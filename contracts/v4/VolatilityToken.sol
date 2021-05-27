// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./../v3/utils/SafeMath168.sol";

import "./interfaces/IVolatilityToken.sol";
import "./ElasticToken.sol";

contract VolatilityToken is IVolatilityToken, Ownable, ElasticToken, ReentrancyGuard {

    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using SafeMath168 for uint168;

    uint8 public constant MINT_REQUEST_TYPE = 1;
    uint8 public constant BURN_REQUEST_TYPE = 2;
    uint8 public constant COLLATERALIZED_MINT_REQUEST_TYPE = 3;

    uint16 public constant MAX_PERCENTAGE = 10000;
    uint16 public constant MAX_CVI_VALUE = 20000;

    uint8 public leverage;
    uint8 public rebaseLag = 2;

    uint16 public minDeviationPercentage = 500;

    uint256 public immutable initialTokenToLPTokenRate;

    IERC20 private token;
    IPlatformV3 private platform;
    IFeesCollector private feesCollector;
    IFeesCalculatorV4 private feesCalculator;
    IRequestFeesCalculator private requestFeesCalculator;
    ICVIOracleV3 private cviOracle;
    IUniswapOracle private uniswapOracle;

    //TOOD: UniswapOracle => MarketOracle

    uint256 private nextRequestId = 1;

    mapping(uint256 => Request) public requests;

    constructor(IERC20 _token, string memory _lpTokenName, string memory _lpTokenSymbolName, uint8 _leverage, uint256 _initialTokenToLPTokenRate, 
            IPlatformV3 _platform, IFeesCollector _feesCollector, IFeesCalculatorV4 _feesCalculator, IRequestFeesCalculator _requestFeesCalculator, ICVIOracleV3 _cviOracle, IUniswapOracle _uniswapOracle) ElasticToken (_lpTokenName, _lpTokenSymbolName, 18) {
        token = _token;
        platform = _platform;
        feesCollector = _feesCollector;
        feesCalculator = _feesCalculator;
        requestFeesCalculator = _requestFeesCalculator;
        cviOracle = _cviOracle;
        uniswapOracle = _uniswapOracle;
        initialTokenToLPTokenRate = _initialTokenToLPTokenRate;
        leverage = _leverage;

        if (address(token) != address(0)) {
            token.approve(address(_platform), uint256(-1));
            token.approve(address(_feesCollector), uint256(-1));
        }
    }

    // If not rebaser, the rebase underlying method will revert
    function rebaseCVI() external override {
        require(uniswapOracle.blockTimestampLast() + uniswapOracle.PERIOD() >= block.timestamp, "Price not updated");

        (uint256 cviValue,,) = cviOracle.getCVILatestRoundData();
        uint256 uniswapValue = uniswapOracle.consult(address(this), 1);

        uint256 deviation = uniswapValue > cviValue ? uniswapValue - cviValue : cviValue - uniswapValue;
        bool positive = uniswapValue > cviValue;

        uint256 minDeviation = cviValue.mul(minDeviationPercentage).div(MAX_PERCENTAGE);
        require(deviation >= minDeviation, "Not enough deviation");

        uint256 delta = DELTA_PRECISION_DECIMALS.mul(deviation).div(cviValue).div(rebaseLag);
        rebase(delta, positive);
    }

    function submitMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external virtual override nonReentrant returns (uint256 requestId) {
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function submitBurnRequest(uint168 _tokenAmount, uint32 _timeDelay) external override nonReentrant returns (uint256 requestId) {
        return submitRequest(BURN_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function submitCollateralizedMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external virtual override nonReentrant returns (uint256 requestId) {
        return submitRequest(COLLATERALIZED_MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function fulfillMintRequest(uint256 _requestId) public virtual override nonReentrant returns (uint256 tokensMinted) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill, uint168 fulfillFees,, bool wasLiquidated) = preFulfillRequest(_requestId, request, MINT_REQUEST_TYPE);

        if (!wasLiquidated) {
            delete requests[_requestId];
            tokensMinted = mintTokens(amountToFulfill, false);

            emit FulfillRequest(_requestId, fulfillFees);
        }
    }

    function fulfillBurnRequest(uint256 _requestId) external override nonReentrant returns (uint256 tokensReceived) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill,, uint16 fulfillFeesPercentage, bool wasLiquiudated) = preFulfillRequest(_requestId, request, BURN_REQUEST_TYPE);

        if (!wasLiquiudated) {
            delete requests[_requestId];

            uint256 fulfillFees;
            (tokensReceived, fulfillFees) = burnTokens(amountToFulfill, request.timeDelayRequestFeesPercent, fulfillFeesPercentage);

            emit FulfillRequest(_requestId, fulfillFees);
        }
    }

    function fulfillCollateralizedMintRequest(uint256 _requestId) public virtual override nonReentrant returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill, uint168 fulfillFees,, bool wasLiquidated) = preFulfillRequest(_requestId, request, COLLATERALIZED_MINT_REQUEST_TYPE);

        if (!wasLiquidated) {
            delete requests[_requestId];
            (tokensMinted, shortTokensMinted) = mintCollateralizedTokens(amountToFulfill);

            emit FulfillRequest(_requestId, fulfillFees);
        }
    }

    function liquidateRequest(uint256 _requestId) external override nonReentrant returns (uint256 findersFeeAmount) {
        Request memory request = requests[_requestId];
        if (requestFeesCalculator.isLiquidable(request)) {
            findersFeeAmount = _liquidateRequest(_requestId, request);
        }
    }

    function _liquidateRequest(uint256 _requestId, Request memory _request) private returns (uint256 findersFeeAmount) {
        uint168 timeDelayFeeAmount = _request.tokenAmount.mul(_request.timeDelayRequestFeesPercent).div(MAX_PERCENTAGE);
        uint168 maxFeesAmount = _request.tokenAmount.mul(_request.maxRequestFeesPercent).div(MAX_PERCENTAGE);
        uint256 leftAmount = timeDelayFeeAmount.add(maxFeesAmount);

        if (_request.requestType == BURN_REQUEST_TYPE) {
            leftAmount = _burnTokens(leftAmount);
        }

        findersFeeAmount = requestFeesCalculator.calculateFindersFee(leftAmount);
        delete requests[_requestId];

        sendProfit(leftAmount.sub(findersFeeAmount), token);
        transferFunds(findersFeeAmount);
    }

    function setPlatform(IPlatformV3 _newPlatform) external override onlyOwner {
        platform = _newPlatform;
        token.approve(address(_newPlatform), uint256(-1));
    }

    function setFeesCalculator(IFeesCalculatorV4 _newFeesCalculator) external override onlyOwner {
        feesCalculator = _newFeesCalculator;
    }

    function setFeesCollector(IFeesCollector _newCollector) external override onlyOwner {
        if (address(feesCollector) != address(0) && address(token) != address(0)) {
            token.approve(address(feesCollector), 0);
        }

        feesCollector = _newCollector;

        if (address(_newCollector) != address(0) && address(token) != address(0)) {
            token.approve(address(_newCollector), uint256(-1));
        }
    }

    function setRequestFeesCalculator(IRequestFeesCalculator _newRequestFeesCalculator) external override onlyOwner {
        requestFeesCalculator = _newRequestFeesCalculator;
    }

    function setCVIOracle(ICVIOracleV3 _newCVIOracle) external override onlyOwner {
        cviOracle = _newCVIOracle;
    }

    function setUniswapOracle(IUniswapOracle _newUniswapOracle) external override onlyOwner {
        uniswapOracle = _newUniswapOracle;
    }

    function setRebaseLag(uint8 _newRebaseLag) external override onlyOwner {
        rebaseLag = _newRebaseLag;
    }

    function setMinDeviation(uint16 _newMinDeviationPercentage) external override onlyOwner {
        minDeviationPercentage = _newMinDeviationPercentage;
    }

    function submitRequest(uint8 _type, uint168 _tokenAmount, uint32 _timeDelay) internal returns (uint requestId) {
        require(_tokenAmount > 0, "Token amount must be positive");

        uint16 timeDelayFeePercent = requestFeesCalculator.calculateTimeDelayFee(_tokenAmount, _timeDelay);
        uint16 maxFeesPercent = requestFeesCalculator.getMaxFees(_tokenAmount);

        uint256 timeDelayFeeAmount = _tokenAmount.mul(timeDelayFeePercent).div(MAX_PERCENTAGE);
        uint256 maxFeesAmount = _tokenAmount.mul(maxFeesPercent).div(MAX_PERCENTAGE);

        requestId = nextRequestId;
        nextRequestId = nextRequestId + 1; // Overflow allowed to keep id cycling

        uint32 targetTimestamp = uint32(block.timestamp.add(_timeDelay));

        requests[requestId] = Request(_type, _tokenAmount, timeDelayFeePercent, maxFeesPercent, msg.sender, uint32(block.timestamp), targetTimestamp);

        emit SubmitRequest(requestId, _type, msg.sender, _tokenAmount, timeDelayFeeAmount, targetTimestamp);

        collectRelevantTokens(_type, timeDelayFeeAmount.add(maxFeesAmount));
    }

    function preFulfillRequest(uint256 _requestId, Request memory _request, uint8 _expectedType) private returns (uint168 amountToFulfill, uint168 fulfillFees, uint16 fulfillFeesPercentage, bool wasLiquidated) {
        require(_request.owner == msg.sender, "Not owner");
        require(_request.requestType == _expectedType, "Wrong request type");

        if (requestFeesCalculator.isLiquidable(_request)) {
            _liquidateRequest(_requestId, _request);
            wasLiquidated = true;
        } else {
            fulfillFeesPercentage = requestFeesCalculator.calculateTimePenaltyFee(_request);
            uint168 timeDelayFees = _request.tokenAmount.mul(_request.timeDelayRequestFeesPercent).div(MAX_PERCENTAGE);

            uint256 tokensLeftToTransfer = _request.tokenAmount.sub(timeDelayFees).sub(_request.tokenAmount.mul(_request.maxRequestFeesPercent).div(MAX_PERCENTAGE));
            collectRelevantTokens(_request.requestType, tokensLeftToTransfer);

            if (_request.requestType == BURN_REQUEST_TYPE) {
                amountToFulfill = _request.tokenAmount;
            } else {
                fulfillFees = _request.tokenAmount.mul(fulfillFeesPercentage).div(MAX_PERCENTAGE);
                amountToFulfill = _request.tokenAmount.sub(timeDelayFees).sub(fulfillFees);
                sendProfit(timeDelayFees.add(fulfillFees), token);
            }
        }
    }

    function mintTokens(uint168 _tokenAmount, bool _isCollateralized) private returns (uint256 tokensMinted) {
        uint256 balance = 0;
        bool isPositive = true;

        (uint256 currPositionUnits,,,,) = platform.positions(address(this));
        if (currPositionUnits != 0) {
            (balance, isPositive,,,,) = platform.calculatePositionBalance(address(this));
        }
        require(isPositive, "Negative balance");

        uint256 supply = totalSupply;

        (, uint256 positionedTokenAmount) = openPosition(_tokenAmount, !_isCollateralized);
   
        if (supply > 0 && balance > 0) {
            tokensMinted = positionedTokenAmount.mul(supply) / balance;
        } else {
            tokensMinted = positionedTokenAmount.mul(initialTokenToLPTokenRate);
        }

        if (!_isCollateralized) {
            emit Mint(msg.sender, positionedTokenAmount, tokensMinted);
        }

        require(tokensMinted > 0, "Too few tokens");

        _mint(msg.sender, tokensMinted);
    }

    function burnTokens(uint168 _tokenAmount, uint16 _timeDelayFeesPercentage, uint16 _fulfillFeesPercentage) private returns (uint256 tokensReceived, uint256 fulfillFees) {
        tokensReceived = _burnTokens(_tokenAmount);

        uint256 timeDelayFee = tokensReceived.mul(_timeDelayFeesPercentage).div(MAX_PERCENTAGE);
        fulfillFees = tokensReceived.mul(_fulfillFeesPercentage).div(MAX_PERCENTAGE);
        sendProfit(fulfillFees.add(timeDelayFee), token);

        tokensReceived = tokensReceived.sub(fulfillFees).sub(timeDelayFee);
        transferFunds(tokensReceived);

        emit Burn(msg.sender, tokensReceived, _tokenAmount);
    }

    function _burnTokens(uint256 _tokenAmount) private returns (uint256 tokensReceived) {
        (,, uint168 totalPositionUnits,,,) = platform.calculatePositionBalance(address(this));
        uint256 positionUnits = uint256(totalPositionUnits).mul(_tokenAmount).div(totalSupply);
        require(positionUnits == uint168(positionUnits), "Too much position units");

        tokensReceived = platform.closePosition(uint168(positionUnits), 1);
        _burn(address(this), _tokenAmount);
    }

    function mintCollateralizedTokens(uint168 _tokenAmount) private returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        (uint256 cviValue,,) = cviOracle.getCVILatestRoundData();
        uint256 openFee = feesCalculator.openPositionFeePercent();
        uint256 depositFee = feesCalculator.depositFeePercent();

        // Note: calculate the deposit amount so that it is exactly (MAX_CVI_VALUE / cviValue - 1) times bigger than the rest of amount that will be used to open a position
        // Therefore, liquidity is fully provided along, allowing to not charge premium fees
        uint256 nominator = uint256(MAX_CVI_VALUE).sub(cviValue).mul(_tokenAmount).mul(uint256(MAX_PERCENTAGE).sub(openFee));
        uint256 depositAmount = nominator.div((cviValue.mul(openFee).add(uint256(MAX_CVI_VALUE).mul(MAX_PERCENTAGE)).sub(openFee.mul(MAX_CVI_VALUE)).sub(depositFee.mul(cviValue))));

        require(depositAmount < _tokenAmount, "Amounts calculation error");
        uint168 mintAmount = _tokenAmount - uint168(depositAmount);

        tokensMinted = mintTokens(mintAmount, true);

        if (depositAmount > 0) {
            shortTokensMinted = deposit(depositAmount);
            IERC20(address(platform)).safeTransfer(msg.sender, shortTokensMinted);
        }

        emit CollateralizedMint(msg.sender, _tokenAmount, tokensMinted, shortTokensMinted);
    }

    function collectRelevantTokens(uint8 _requestType, uint256 _tokenAmount) private {
        if (_requestType == BURN_REQUEST_TYPE) {
            require(balanceOf(msg.sender) >= _tokenAmount, "Not enough tokens");
            IERC20(address(this)).safeTransferFrom(msg.sender, address(this), _tokenAmount);
        } else {
            collectTokens(_tokenAmount);
        }
    }

    function transferFunds(uint256 _tokenAmount) internal virtual {
        token.safeTransfer(msg.sender, _tokenAmount);
    }

    function collectTokens(uint256 _tokenAmount) internal virtual {
        token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
    }

    function sendProfit(uint256 _amount, IERC20 _token) internal virtual {
        feesCollector.sendProfit(_amount, _token);
    }

    function openPosition(uint168 _amount, bool _withPremiumFee) internal virtual returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        return _withPremiumFee ? 
            platform.openPosition(_amount, MAX_CVI_VALUE, MAX_PERCENTAGE, leverage) :
            platform.openPositionWithoutPremiumFee(_amount, MAX_CVI_VALUE, MAX_PERCENTAGE, leverage);
    }

    function deposit(uint256 _amount) internal virtual returns (uint256 shortTokensMinted) {
        return platform.deposit(_amount, 0);
    }
}
