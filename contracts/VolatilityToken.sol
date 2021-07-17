// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./interfaces/IVolatilityToken.sol";
import "./ElasticToken.sol";

contract VolatilityToken is Initializable, IVolatilityToken, ReentrancyGuardUpgradeable, ElasticToken {

    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint8 public constant MINT_REQUEST_TYPE = 1;
    uint8 public constant BURN_REQUEST_TYPE = 2;

    uint16 public constant MAX_PERCENTAGE = 10000;

    uint8 public leverage;
    uint8 public rebaseLag;

    uint16 public minDeviationPercentage;

    uint256 public initialTokenToLPTokenRate;

    IERC20Upgradeable private token;
    IPlatform private platform;
    IFeesCollector private feesCollector;
    IFeesCalculator private feesCalculator;
    IRequestFeesCalculator private requestFeesCalculator;
    ICVIOracle private cviOracle;

    uint256 private nextRequestId;

    mapping(uint256 => Request) public requests;

    function initialize(IERC20Upgradeable _token, string memory _lpTokenName, string memory _lpTokenSymbolName, uint8 _leverage, uint256 _initialTokenToLPTokenRate, 
            IPlatform _platform, IFeesCollector _feesCollector, IFeesCalculator _feesCalculator, IRequestFeesCalculator _requestFeesCalculator, ICVIOracle _cviOracle) public initializer {
        rebaseLag = 2;
        minDeviationPercentage = 100;
        nextRequestId = 1;

        ElasticToken.__ElasticToken_init(_lpTokenName, _lpTokenSymbolName, 18);
        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();

        token = _token;
        platform = _platform;
        feesCollector = _feesCollector;
        feesCalculator = _feesCalculator;
        requestFeesCalculator = _requestFeesCalculator;
        cviOracle = _cviOracle;
        initialTokenToLPTokenRate = _initialTokenToLPTokenRate;
        leverage = _leverage;

        if (address(token) != address(0)) {
            token.safeApprove(address(_platform), type(uint256).max);
            token.safeApprove(address(_feesCollector), type(uint256).max);
        }
    }    

    // If not rebaser, the rebase underlying method will revert
    function rebaseCVI() external override {
        (uint256 balance, bool isBalancePositive,,,,) = platform.calculatePositionBalance(address(this));
        require(isBalancePositive, "Negative balance");

        uint256 positionValue = balance * initialTokenToLPTokenRate * (10**(ERC20Upgradeable(address(token)).decimals())) / totalSupply;

        (uint256 cviValueOracle,,) = cviOracle.getCVILatestRoundData();
        uint256 cviValue = cviValueOracle * (10**(ERC20Upgradeable(address(token)).decimals())) / 100;

        uint256 deviation = positionValue > cviValue ? positionValue - cviValue : cviValue - positionValue;
        bool positive = positionValue > cviValue;

        if (rebaseLag > 1) {
            deviation = deviation / rebaseLag;
            cviValue = positive ? positionValue - deviation : positionValue + deviation;
        }

        require(deviation >= cviValue * minDeviationPercentage / MAX_PERCENTAGE, "Not enough deviation");

        uint256 delta = DELTA_PRECISION_DECIMALS * deviation / cviValue;

        rebase(delta, positive);
    }

    function submitMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external virtual override nonReentrant returns (uint256 requestId) {
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function submitBurnRequest(uint168 _tokenAmount, uint32 _timeDelay) external override nonReentrant returns (uint256 requestId) {
        return submitRequest(BURN_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function fulfillMintRequest(uint256 _requestId, uint16 _maxBuyingPremiumFeePercentage) public virtual override nonReentrant returns (uint256 tokensMinted) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill, uint168 fulfillFees,, bool wasLiquidated) = preFulfillRequest(_requestId, request, MINT_REQUEST_TYPE);

        if (!wasLiquidated) {
            delete requests[_requestId];
            tokensMinted = mintTokens(amountToFulfill, false, _maxBuyingPremiumFeePercentage);

            emit FulfillRequest(_requestId, msg.sender, fulfillFees);
        }
    }

    function fulfillBurnRequest(uint256 _requestId) external override nonReentrant returns (uint256 tokensReceived) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill,, uint16 fulfillFeesPercentage, bool wasLiquiudated) = preFulfillRequest(_requestId, request, BURN_REQUEST_TYPE);

        if (!wasLiquiudated) {
            delete requests[_requestId];

            uint256 fulfillFees;
            (tokensReceived, fulfillFees) = burnTokens(amountToFulfill, request.timeDelayRequestFeesPercent, fulfillFeesPercentage);

            emit FulfillRequest(_requestId,  msg.sender, fulfillFees);
        }
    }

    function fulfillCollateralizedMintRequest(uint256 _requestId) public virtual override nonReentrant returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill, uint168 fulfillFees,, bool wasLiquidated) = preFulfillRequest(_requestId, request, MINT_REQUEST_TYPE);

        if (!wasLiquidated) {
            delete requests[_requestId];
            (tokensMinted, shortTokensMinted) = mintCollateralizedTokens(amountToFulfill);

            emit FulfillRequest(_requestId, msg.sender, fulfillFees);
        }
    }

    function liquidateRequest(uint256 _requestId) external override nonReentrant returns (uint256 findersFeeAmount) {
        Request memory request = requests[_requestId];
        require(requestFeesCalculator.isLiquidable(request), "Not liquidable");
        findersFeeAmount = _liquidateRequest(_requestId, request);
    }

    function _liquidateRequest(uint256 _requestId, Request memory _request) private returns (uint256 findersFeeAmount) {
        uint168 timeDelayFeeAmount = _request.tokenAmount * _request.timeDelayRequestFeesPercent / MAX_PERCENTAGE;
        uint168 maxFeesAmount = _request.tokenAmount * _request.maxRequestFeesPercent / MAX_PERCENTAGE;
        uint256 leftAmount = timeDelayFeeAmount + maxFeesAmount;

        if (_request.requestType == BURN_REQUEST_TYPE) {
            leftAmount = _burnTokens(leftAmount);
        }

        findersFeeAmount = requestFeesCalculator.calculateFindersFee(leftAmount);
        delete requests[_requestId];

        sendProfit(leftAmount - findersFeeAmount, token);
        transferFunds(findersFeeAmount);

        emit LiquidateRequest(_requestId, _request.requestType, _request.owner, msg.sender, findersFeeAmount);
    }

    function setPlatform(IPlatform _newPlatform) external override onlyOwner {
        if (address(platform) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(platform), type(uint256).max);
        }

        platform = _newPlatform;

        if (address(_newPlatform) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(_newPlatform), type(uint256).max);
        }
    }

    function setFeesCalculator(IFeesCalculator _newFeesCalculator) external override onlyOwner {
        feesCalculator = _newFeesCalculator;
    }

    function setFeesCollector(IFeesCollector _newCollector) external override onlyOwner {
        if (address(feesCollector) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(feesCollector), 0);
        }

        feesCollector = _newCollector;

        if (address(_newCollector) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(_newCollector), type(uint256).max);
        }
    }

    function setRequestFeesCalculator(IRequestFeesCalculator _newRequestFeesCalculator) external override onlyOwner {
        requestFeesCalculator = _newRequestFeesCalculator;
    }

    function setCVIOracle(ICVIOracle _newCVIOracle) external override onlyOwner {
        cviOracle = _newCVIOracle;
    }

    function setRebaseLag(uint8 _newRebaseLag) external override onlyOwner {
        rebaseLag = _newRebaseLag;
    }

    function setMinDeviation(uint16 _newMinDeviationPercentage) external override onlyOwner {
        minDeviationPercentage = _newMinDeviationPercentage;
    }

    function submitRequest(uint8 _type, uint168 _tokenAmount, uint32 _timeDelay) internal returns (uint requestId) {
        require(_tokenAmount > 0, "Token amount must be positive");

        uint16 timeDelayFeePercent = requestFeesCalculator.calculateTimeDelayFee(_timeDelay);
        uint16 maxFeesPercent = requestFeesCalculator.getMaxFees();

        uint256 timeDelayFeeAmount = _tokenAmount * timeDelayFeePercent / MAX_PERCENTAGE;
        uint256 maxFeesAmount = _tokenAmount * maxFeesPercent / MAX_PERCENTAGE;

        requestId = nextRequestId;
        nextRequestId = nextRequestId + 1; // Overflow allowed to keep id cycling

        uint32 targetTimestamp = uint32(block.timestamp + _timeDelay);

        requests[requestId] = Request(_type, _tokenAmount, timeDelayFeePercent, maxFeesPercent, msg.sender, uint32(block.timestamp), targetTimestamp);

        emit SubmitRequest(requestId, _type, msg.sender, _tokenAmount, timeDelayFeeAmount, targetTimestamp);

        collectRelevantTokens(_type, timeDelayFeeAmount + maxFeesAmount);
    }

    function preFulfillRequest(uint256 _requestId, Request memory _request, uint8 _expectedType) private returns (uint168 amountToFulfill, uint168 fulfillFees, uint16 fulfillFeesPercentage, bool wasLiquidated) {
        require(_request.owner == msg.sender, "Not owner");
        require(_request.requestType == _expectedType, "Wrong request type");

        if (requestFeesCalculator.isLiquidable(_request)) {
            _liquidateRequest(_requestId, _request);
            wasLiquidated = true;
        } else {
            fulfillFeesPercentage = requestFeesCalculator.calculateTimePenaltyFee(_request);
            uint168 timeDelayFees = _request.tokenAmount * _request.timeDelayRequestFeesPercent / MAX_PERCENTAGE;

            uint256 tokensLeftToTransfer = _request.tokenAmount - timeDelayFees - (_request.tokenAmount * _request.maxRequestFeesPercent / MAX_PERCENTAGE);
            collectRelevantTokens(_request.requestType, tokensLeftToTransfer);

            if (_request.requestType == BURN_REQUEST_TYPE) {
                amountToFulfill = _request.tokenAmount;
            } else {
                fulfillFees = _request.tokenAmount * fulfillFeesPercentage / MAX_PERCENTAGE;
                amountToFulfill = _request.tokenAmount - timeDelayFees - fulfillFees;
                sendProfit(timeDelayFees + fulfillFees, token);
            }
        }
    }

    function mintTokens(uint168 _tokenAmount, bool _isCollateralized, uint16 _maxBuyingPremiumFeePercentage) private returns (uint256 tokensMinted) {
        uint256 balance = 0;
        bool isPositive = true;

        (uint256 currPositionUnits,,,,) = platform.positions(address(this));
        if (currPositionUnits != 0) {
            (balance, isPositive,,,,) = platform.calculatePositionBalance(address(this));
        }
        require(isPositive, "Negative balance");

        uint256 supply = totalSupply;

        (, uint256 positionedTokenAmount) = openPosition(_tokenAmount, !_isCollateralized, _maxBuyingPremiumFeePercentage);
   
        if (supply > 0 && balance > 0) {
            tokensMinted = positionedTokenAmount * supply / balance;
        } else {
            tokensMinted = positionedTokenAmount * initialTokenToLPTokenRate;
        }

        if (!_isCollateralized) {
            emit Mint(msg.sender, positionedTokenAmount, tokensMinted);
        }

        require(tokensMinted > 0, "Too few tokens");

        _mint(msg.sender, tokensMinted);
    }

    function burnTokens(uint168 _tokenAmount, uint16 _timeDelayFeesPercentage, uint16 _fulfillFeesPercentage) private returns (uint256 tokensReceived, uint256 fulfillFees) {
        tokensReceived = _burnTokens(_tokenAmount);

        uint256 timeDelayFee = tokensReceived * _timeDelayFeesPercentage / MAX_PERCENTAGE;
        fulfillFees = tokensReceived * _fulfillFeesPercentage / MAX_PERCENTAGE;
        sendProfit(fulfillFees + timeDelayFee, token);

        tokensReceived = tokensReceived - fulfillFees - timeDelayFee;
        transferFunds(tokensReceived);

        emit Burn(msg.sender, tokensReceived, _tokenAmount);
    }

    function _burnTokens(uint256 _tokenAmount) private returns (uint256 tokensReceived) {
        (, bool isPositive, uint168 totalPositionUnits,,,) = platform.calculatePositionBalance(address(this));
        require(isPositive, "Negative balance");

        uint256 positionUnits = totalPositionUnits * _tokenAmount / totalSupply;
        require(positionUnits == uint168(positionUnits), "Too much position units");

        if (positionUnits > 0) {
            tokensReceived = platform.closePosition(uint168(positionUnits), 1);
        }

        _burn(address(this), _tokenAmount);
    }

    function mintCollateralizedTokens(uint168 _tokenAmount) private returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        (uint256 cviValue,,) = cviOracle.getCVILatestRoundData();
        uint256 openFee = feesCalculator.openPositionFeePercent() + feesCalculator.openPositionLPFeePercent();
        uint256 depositFee = feesCalculator.depositFeePercent();
        uint256 maxCVIValue = platform.maxCVIValue();

        // Note: calculate the deposit/mint amount so that the deposit is exactly (MAX_CVI_VALUE / cviValue - 1) times bigger than the rest of amount that will be used to open a position
        // Therefore, liquidity is fully provided along, allowing to not charge premium fees
        // Note: The mint amount is calculated first, as it can be truncated with div, thus being a bit smaller, making the deposit amount a bit bigger, so liquidity coverage is assured.
        uint256 nominator = cviValue * (MAX_PERCENTAGE - depositFee) * _tokenAmount;
        uint256 mintAmount = nominator / (cviValue * openFee + maxCVIValue * MAX_PERCENTAGE - openFee * maxCVIValue - depositFee * cviValue);

        require(mintAmount <= _tokenAmount, "Amounts calculation error");
        uint256 depositAmount = _tokenAmount - uint168(mintAmount);

        require(depositAmount * (MAX_PERCENTAGE - depositFee) / MAX_PERCENTAGE >=
            mintAmount * (MAX_PERCENTAGE - openFee) / MAX_PERCENTAGE * (maxCVIValue - cviValue) / cviValue, "Amounts calculation error");

        if (depositAmount > 0) {
            shortTokensMinted = deposit(depositAmount);
            IERC20Upgradeable(address(platform)).safeTransfer(msg.sender, shortTokensMinted);
        }

        tokensMinted = mintTokens(uint168(mintAmount), true, 0);

        emit CollateralizedMint(msg.sender, _tokenAmount, tokensMinted, shortTokensMinted);
    }

    function collectRelevantTokens(uint8 _requestType, uint256 _tokenAmount) private {
        if (_requestType == BURN_REQUEST_TYPE) {
            require(balanceOf(msg.sender) >= _tokenAmount, "Not enough tokens");
            IERC20Upgradeable(address(this)).safeTransferFrom(msg.sender, address(this), _tokenAmount);
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

    function sendProfit(uint256 _amount, IERC20Upgradeable _token) internal virtual {
        feesCollector.sendProfit(_amount, IERC20(address(_token)));
    }

    function openPosition(uint168 _amount, bool _withPremiumFee, uint16 _maxBuyingPremiumFeePercentage) internal virtual returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        return _withPremiumFee ? 
            platform.openPosition(_amount, platform.maxCVIValue(), _maxBuyingPremiumFeePercentage, leverage) :
            platform.openPositionWithoutPremiumFee(_amount, platform.maxCVIValue(), leverage);
    }

    function deposit(uint256 _amount) internal virtual returns (uint256 shortTokensMinted) {
        return platform.deposit(_amount, 0);
    }
}
