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
    uint8 private rebaseLag; // Obsolete

    uint16 public minDeviationPercentage;

    uint256 public initialTokenToLPTokenRate;

    IERC20Upgradeable public token;
    IPlatform public platform;
    IFeesCollector public feesCollector;
    IFeesCalculator public feesCalculator;
    IRequestFeesCalculator public requestFeesCalculator;
    ICVIOracle public cviOracle;

    uint256 private nextRequestId;

    mapping(uint256 => Request) public requests;

    uint256 public totalRequestsAmount;
    uint256 public maxTotalRequestsAmount;
    bool public verifyTotalRequestsAmount;

    uint16 public deviationPerSingleRebaseLag;
    uint16 public maxDeviationPercentage;

    bool public cappedRebase;

    uint256 public constant PRECISION_DECIMALS = 1e10;
    uint256 public constant CVI_DECIMALS_FIX = 100;

    function initialize(IERC20Upgradeable _token, string memory _lpTokenName, string memory _lpTokenSymbolName, uint8 _leverage, uint256 _initialTokenToVolTokenRate, 
            IPlatform _platform, IFeesCollector _feesCollector, IFeesCalculator _feesCalculator, IRequestFeesCalculator _requestFeesCalculator, ICVIOracle _cviOracle) public initializer {
        minDeviationPercentage = 100;
        deviationPerSingleRebaseLag = 1000;
        maxDeviationPercentage = 5000;
        cappedRebase = true;

        nextRequestId = 1;

        ElasticToken.__ElasticToken_init(_lpTokenName, _lpTokenSymbolName, 18);
        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();

        token = _token;
        platform = _platform;
        feesCollector = _feesCollector;
        feesCalculator = _feesCalculator;
        requestFeesCalculator = _requestFeesCalculator;
        cviOracle = _cviOracle;
        initialTokenToLPTokenRate = _initialTokenToVolTokenRate;
        leverage = _leverage;

        totalRequestsAmount = 0;
        maxTotalRequestsAmount = 1e11;
        verifyTotalRequestsAmount = true;

        if (address(token) != address(0)) {
            token.safeApprove(address(_platform), type(uint256).max);
            token.safeApprove(address(_feesCollector), type(uint256).max);
        }
    }

    // If not rebaser, the rebase underlying method will revert
    function rebaseCVI() external override {
        (uint256 balance, bool isBalancePositive,,,,) = platform.calculatePositionBalance(address(this));
        require(isBalancePositive, "Negative balance");

        // Note: the price is measured by token units, so we want its decimals on the position value as well, as precision decimals
        // We use the rate multiplication to have balance / totalSupply be done with matching decimals
        uint256 positionValue = balance * initialTokenToLPTokenRate * PRECISION_DECIMALS / totalSupply;

        (uint256 cviValueOracle,,) = cviOracle.getCVILatestRoundData();
        uint256 cviValue = cviValueOracle * PRECISION_DECIMALS / CVI_DECIMALS_FIX;

        require(cviValue > positionValue, "Positive rebase disallowed");
        uint256 deviation = cviValue - positionValue;

        require(!cappedRebase || deviation >= cviValue * minDeviationPercentage / MAX_PERCENTAGE, "Not enough deviation");
        require(!cappedRebase || deviation <= cviValue * maxDeviationPercentage / MAX_PERCENTAGE, "Deviation too big");

        // Note: rounding up (ceiling) the rebase lag so it is >= 1 and bumps by 1 for every deviationPerSingleRebaseLag percentage
        uint256 rebaseLagNew = cappedRebase ? (deviation * MAX_PERCENTAGE - 1) / (cviValue * deviationPerSingleRebaseLag) + 1 : 1;

        if (rebaseLagNew > 1) {
            deviation = deviation / rebaseLagNew;
            cviValue = positionValue + deviation;
        }

        uint256 delta = DELTA_PRECISION_DECIMALS * deviation / cviValue;

        rebase(delta, false);
    }

    function submitMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external virtual override nonReentrant returns (uint256 requestId) {
        require(!verifyTotalRequestsAmount || _tokenAmount + totalRequestsAmount <= maxTotalRequestsAmount, "Total requests amount exceeded");
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function submitBurnRequest(uint168 _tokenAmount, uint32 _timeDelay) external override nonReentrant returns (uint256 requestId) {
        return submitRequest(BURN_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function fulfillMintRequest(uint256 _requestId, uint16 _maxBuyingPremiumFeePercentage) public virtual override nonReentrant returns (uint256 tokensMinted) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill, uint168 fulfillFees,, bool wasLiquidated,,,) = preFulfillRequest(_requestId, request, MINT_REQUEST_TYPE, false);

        if (!wasLiquidated) {
            delete requests[_requestId];
            tokensMinted = mintTokens(amountToFulfill, false, _maxBuyingPremiumFeePercentage);

            emit FulfillRequest(_requestId, msg.sender, fulfillFees, false);
        }
    }

    function fulfillBurnRequest(uint256 _requestId) external override nonReentrant returns (uint256 tokensReceived) {
        Request memory request = requests[_requestId];
        (uint168 amountToFulfill,, uint16 fulfillFeesPercentage, bool wasLiquidated,,,) = preFulfillRequest(_requestId, request, BURN_REQUEST_TYPE, false);

        if (!wasLiquidated) {
            delete requests[_requestId];

            uint256 fulfillFees;
            (tokensReceived, fulfillFees) = burnTokens(amountToFulfill, request.timeDelayRequestFeesPercent, fulfillFeesPercentage);

            emit FulfillRequest(_requestId,  msg.sender, fulfillFees, false);
        }
    }

    function fulfillCollateralizedMintRequest(uint256 _requestId) public virtual override nonReentrant returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        Request memory request = requests[_requestId];
        (, uint168 fulfillFees,, bool wasLiquidated, uint168 depositAmount, uint168 mintAmount, bool shouldAbort) = preFulfillRequest(_requestId, request, MINT_REQUEST_TYPE, true);

        if (!wasLiquidated) {
            delete requests[_requestId];

            if (shouldAbort) {
                token.safeTransfer(msg.sender, request.tokenAmount * request.maxRequestFeesPercent / MAX_PERCENTAGE);
            } else {
                (tokensMinted, shortTokensMinted) = mintCollateralizedTokens(mintAmount, depositAmount);
            }

            emit FulfillRequest(_requestId, msg.sender, fulfillFees, shouldAbort);
        }
    }

    function liquidateRequest(uint256 _requestId) external override nonReentrant returns (uint256 findersFeeAmount) {
        Request memory request = requests[_requestId];
        require(request.requestType != 0, "Request id not found");
        require(requestFeesCalculator.isLiquidable(request), "Not liquidable");
        findersFeeAmount = _liquidateRequest(_requestId, request);
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

    function setDeviationPerSingleRebaseLag(uint16 _newDeviationPercentagePerSingleRebaseLag) external override onlyOwner {
        deviationPerSingleRebaseLag = _newDeviationPercentagePerSingleRebaseLag;
    }

    function setMinDeviation(uint16 _newMinDeviationPercentage) external override onlyOwner {
        minDeviationPercentage = _newMinDeviationPercentage;
    }

    function setMaxDeviation(uint16 _newMaxDeviationPercentage) external override onlyOwner {
        maxDeviationPercentage = _newMaxDeviationPercentage;
    }

    function setVerifyTotalRequestsAmount(bool _verifyTotalRequestsAmount) external override onlyOwner {
        verifyTotalRequestsAmount = _verifyTotalRequestsAmount;
    }

    function setMaxTotalRequestsAmount(uint256 _maxTotalRequestsAmount) external override onlyOwner {
        maxTotalRequestsAmount = _maxTotalRequestsAmount;
    }

    function setCappedRebase(bool _newCappedRebase) external override onlyOwner {
        cappedRebase = _newCappedRebase;
    }

    function submitRequest(uint8 _type, uint168 _tokenAmount, uint32 _timeDelay) internal returns (uint requestId) {
        require(_tokenAmount > 0, "Token amount must be positive");

        uint16 timeDelayFeePercent = requestFeesCalculator.calculateTimeDelayFee(_timeDelay);
        uint16 maxFeesPercent = requestFeesCalculator.getMaxFees();

        // Converting to underlying value in case of burn request, to support rebasing until fulfill
        uint168 updatedTokenAmount = _tokenAmount;
        if (_type == BURN_REQUEST_TYPE) {
            uint256 __updatedTokenAmount = valueToUnderlying(_tokenAmount);
            require(uint168(__updatedTokenAmount) == __updatedTokenAmount);
            updatedTokenAmount = uint168(__updatedTokenAmount);
        }

        uint256 timeDelayFeeAmount = updatedTokenAmount * timeDelayFeePercent / MAX_PERCENTAGE;
        uint256 maxFeesAmount = updatedTokenAmount * maxFeesPercent / MAX_PERCENTAGE;

        requestId = nextRequestId;
        nextRequestId = nextRequestId + 1; // Overflow allowed to keep id cycling

        uint32 targetTimestamp = uint32(block.timestamp + _timeDelay);

        requests[requestId] = Request(_type, updatedTokenAmount, timeDelayFeePercent, maxFeesPercent, msg.sender, uint32(block.timestamp), targetTimestamp);

        if (_type != BURN_REQUEST_TYPE) {
            totalRequestsAmount = totalRequestsAmount + _tokenAmount;
        }

        emit SubmitRequest(requestId, _type, msg.sender, _tokenAmount, _type == BURN_REQUEST_TYPE ? underlyingToValue(timeDelayFeeAmount) : timeDelayFeeAmount, targetTimestamp);

        collectRelevantTokens(_type, _type == BURN_REQUEST_TYPE ? underlyingToValue(timeDelayFeeAmount + maxFeesAmount) : timeDelayFeeAmount + maxFeesAmount);
    }

    function preFulfillRequest(uint256 _requestId, Request memory _request, uint8 _expectedType, bool _isCollateralized) private returns (uint168 amountToFulfill, uint168 fulfillFees, uint16 fulfillFeesPercentage, bool wasLiquidated, uint168 depositAmount, uint168 mintAmount, bool shouldAbort) {
        require(_request.owner == msg.sender, "Not owner");
        require(_request.requestType == _expectedType, "Wrong request type");

        if (requestFeesCalculator.isLiquidable(_request)) {
            _liquidateRequest(_requestId, _request);
            wasLiquidated = true;
        } else {
            fulfillFeesPercentage = requestFeesCalculator.calculateTimePenaltyFee(_request);

            uint168 timeDelayFees = _request.tokenAmount * _request.timeDelayRequestFeesPercent / MAX_PERCENTAGE;
            uint256 tokensLeftToTransfer = getUpdatedTokenAmount(_request.requestType, _request.tokenAmount - timeDelayFees - (_request.tokenAmount * _request.maxRequestFeesPercent / MAX_PERCENTAGE));

            if (_request.requestType != BURN_REQUEST_TYPE) {
                subtractTotalRequestAmount(_request.tokenAmount);
            }

            if (_request.requestType == MINT_REQUEST_TYPE) {
                fulfillFees = _request.tokenAmount * fulfillFeesPercentage / MAX_PERCENTAGE;
                amountToFulfill = _request.tokenAmount - timeDelayFees - fulfillFees;

                if (_isCollateralized) {
                    bool isPossible;
                    (mintAmount, depositAmount, isPossible) = calculateCollateralizedAmounts(amountToFulfill);

                    if (!isPossible) {
                        return (0, 0, 0, false, 0, 0, true);
                    }
                }
            }

            collectRelevantTokens(_request.requestType, tokensLeftToTransfer);

            if (_request.requestType == BURN_REQUEST_TYPE) {
                amountToFulfill = getUpdatedTokenAmount(_request.requestType, _request.tokenAmount);
            } else {
                feesCollector.sendProfit(timeDelayFees + fulfillFees, IERC20(address(token)));
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
        positionedTokenAmount = positionedTokenAmount / leverage; // To get actual money put, excluding margin debt
   
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
        tokensReceived = tokensReceived - fulfillFees - timeDelayFee;

        feesCollector.sendProfit(fulfillFees + timeDelayFee, IERC20(address(token)));
        token.safeTransfer(msg.sender, tokensReceived);

        emit Burn(msg.sender, tokensReceived, _tokenAmount);
    }

    function _burnTokens(uint256 _tokenAmount) private returns (uint256 tokensReceived) {
        (, bool isPositive, uint168 totalPositionUnits,,,) = platform.calculatePositionBalance(address(this));
        require(isPositive, "Negative balance");

        uint256 positionUnits = totalPositionUnits * _tokenAmount / totalSupply;
        require(positionUnits == uint168(positionUnits), "Too much position units");

        if (positionUnits > 0) {
            tokensReceived = platform.closePositionWithoutVolumeFee(uint168(positionUnits), 1);
        }

        // Note: Moving to underlying and back in case rebase occured, and trying to burn too much because of rounding
        _burn(address(this), underlyingToValue(valueToUnderlying(_tokenAmount)));
    }

    function calculateCollateralizedAmounts(uint168 _tokenAmount) private view returns (uint168 mintAmount, uint168 depositAmount, bool isPossible) {
        (uint256 cviValue,,) = cviOracle.getCVILatestRoundData();
        uint256 openFee = feesCalculator.openPositionFeePercent() + feesCalculator.openPositionLPFeePercent();
        uint256 depositFee = feesCalculator.depositFeePercent();
        uint256 maxCVIValue = platform.maxCVIValue();

        uint256 currentGain = 0;

        {
            (uint168 positionUnitsAmount,, uint16 openCVIValue,,) = platform.positions(address(this));

            if (positionUnitsAmount != 0) {
                (uint256 currentBalance, bool isBalancePositive,,,, uint256 marginDebt) = platform.calculatePositionBalance(address(this));

                uint256 originalBalance = positionUnitsAmount * openCVIValue / maxCVIValue;

                if (isBalancePositive && currentBalance > originalBalance - marginDebt) {
                    currentGain = currentBalance - (originalBalance - marginDebt);
                }
            }
        }

        // Note: calculate the deposit/mint amount so that the deposit is exactly (MAX_CVI_VALUE / cviValue - 1) times bigger than the rest of amount that will be used to open a position
        // Therefore, liquidity is fully provided along, allowing to not charge premium fees
        // Note: The mint amount is calculated first, as it can be truncated with div, thus being a bit smaller, making the deposit amount a bit bigger, so liquidity coverage is assured

        {
            uint256 numeratorPlus = cviValue * _tokenAmount * (MAX_PERCENTAGE - depositFee);
            uint256 numeratorMinus = uint256(leverage) * currentGain * MAX_PERCENTAGE * (maxCVIValue - cviValue);
            uint256 denominatorPlus = uint256(leverage) * MAX_PERCENTAGE * (maxCVIValue - cviValue) + cviValue * (MAX_PERCENTAGE - depositFee);
            uint256 denominatorMinus = uint256(leverage) * leverage * openFee * (maxCVIValue - cviValue);

            uint256 numerator = numeratorPlus > numeratorMinus ? numeratorPlus - numeratorMinus : numeratorMinus - numeratorPlus;
            uint256 denominator = denominatorPlus > denominatorMinus ? denominatorPlus - denominatorMinus : denominatorMinus - denominatorPlus;

            mintAmount = uint168(numerator / denominator) - 1;
        }

        if (mintAmount > _tokenAmount) {
            return (0, 0, false);
        }

        depositAmount = _tokenAmount - mintAmount;

        if (depositAmount * (MAX_PERCENTAGE - depositFee) / MAX_PERCENTAGE <
                (currentGain + mintAmount - mintAmount * leverage * openFee / MAX_PERCENTAGE) * leverage * (maxCVIValue - cviValue) / cviValue) {
            return (0, 0, false);
        }

        return (mintAmount, depositAmount, true);
    }

    function mintCollateralizedTokens(uint168 _mintAmount, uint168 _depositAmount) private returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        if (_depositAmount > 0) {
            shortTokensMinted = platform.deposit(_depositAmount, 0);
            IERC20Upgradeable(address(platform)).safeTransfer(msg.sender, shortTokensMinted);
        }

        tokensMinted = mintTokens(uint168(_mintAmount), true, 0);

        emit CollateralizedMint(msg.sender, _mintAmount + _depositAmount, tokensMinted, shortTokensMinted);
    }

    function _liquidateRequest(uint256 _requestId, Request memory _request) private returns (uint256 findersFeeAmount) {
        uint168 updatedTokenAmount = getUpdatedTokenAmount(_request.requestType, _request.tokenAmount);
        uint168 timeDelayFeeAmount = updatedTokenAmount * _request.timeDelayRequestFeesPercent / MAX_PERCENTAGE;
        uint168 maxFeesAmount = updatedTokenAmount * _request.maxRequestFeesPercent / MAX_PERCENTAGE;
        uint256 leftAmount = timeDelayFeeAmount + maxFeesAmount;

        if (_request.requestType == BURN_REQUEST_TYPE) {
            leftAmount = _burnTokens(leftAmount);
        } else {
            subtractTotalRequestAmount(updatedTokenAmount);
        }

        findersFeeAmount = requestFeesCalculator.calculateFindersFee(leftAmount);

        delete requests[_requestId];

        feesCollector.sendProfit(leftAmount - findersFeeAmount, IERC20(address(token)));
        token.safeTransfer(msg.sender, findersFeeAmount);

        emit LiquidateRequest(_requestId, _request.requestType, _request.owner, msg.sender, findersFeeAmount);
    }

    function subtractTotalRequestAmount(uint256 _amount) private {
        if (_amount > totalRequestsAmount) {
            totalRequestsAmount = 0;
        } else {
            totalRequestsAmount = totalRequestsAmount - _amount;
        }
    }

    function collectRelevantTokens(uint8 _requestType, uint256 _tokenAmount) private {
        if (_requestType == BURN_REQUEST_TYPE) {
            require(balanceOf(msg.sender) >= _tokenAmount, "Not enough tokens");
            IERC20Upgradeable(address(this)).safeTransferFrom(msg.sender, address(this), _tokenAmount);
        } else {
            token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
        }
    }

    function openPosition(uint168 _amount, bool _withPremiumFee, uint16 _maxBuyingPremiumFeePercentage) private returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        return _withPremiumFee ? 
            platform.openPositionWithoutVolumeFee(_amount, platform.maxCVIValue(), _maxBuyingPremiumFeePercentage, leverage) :
            platform.openPositionWithoutPremiumFee(_amount, platform.maxCVIValue(), leverage);
    }

    function getUpdatedTokenAmount(uint8 _requestType, uint168 _requestAmount) private view returns (uint168 updatedTokenAmount) {
        if (_requestType != BURN_REQUEST_TYPE) {
            return _requestAmount;
        }

        uint256 __updatedTokenAmount = underlyingToValue(_requestAmount);
        require(uint168(__updatedTokenAmount) == __updatedTokenAmount);
        updatedTokenAmount = uint168(__updatedTokenAmount);
    }
}