// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./interfaces/IVolatilityToken.sol";
import "./interfaces/IRequestManager.sol";
import "./ElasticToken.sol";

contract VolatilityToken is Initializable, IVolatilityToken, IRequestManager, ReentrancyGuardUpgradeable, ElasticToken {

    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint8 public constant MINT_REQUEST_TYPE = 1;
    uint8 public constant BURN_REQUEST_TYPE = 2;

    uint16 public constant MAX_PERCENTAGE = 10000;

    uint8 public override leverage; // Obsolete
    uint8 private rebaseLag; // Obsolete

    uint16 public minDeviationPercentage;

    uint256 public override initialTokenToLPTokenRate;

    IERC20Upgradeable public token;
    IPlatform public override platform;
    IFeesCollector public feesCollector;
    IFeesCalculator public feesCalculator;
    IRequestFeesCalculator public override requestFeesCalculator;
    ICVIOracle public cviOracle;

    uint256 public override nextRequestId;

    mapping(uint256 => Request) public override requests;

    uint256 public totalRequestsAmount;
    uint256 public maxTotalRequestsAmount;
    bool public verifyTotalRequestsAmount;

    uint16 public deviationPerSingleRebaseLag;
    uint16 public maxDeviationPercentage;

    bool public cappedRebase;

    uint256 public constant PRECISION_DECIMALS = 1e10;
    uint256 public constant CVI_DECIMALS_FIX = 100;

    uint256 public override minRequestId;
    uint256 public override maxMinRequestIncrements;

    address public fulfiller;

    address public keepersFeeVaultAddress;

    uint256 public minKeepersMintAmount;
    uint256 public minKeepersBurnAmount;
    
    address public minter;

    function initialize(IERC20Upgradeable _token, string memory _lpTokenName, string memory _lpTokenSymbolName, uint8 _leverage, uint256 _initialTokenToVolTokenRate, 
            IPlatform _platform, IFeesCollector _feesCollector, IFeesCalculator _feesCalculator, IRequestFeesCalculator _requestFeesCalculator, ICVIOracle _cviOracle) public initializer {
        minDeviationPercentage = 100;
        deviationPerSingleRebaseLag = 1000;
        maxDeviationPercentage = 5000;
        cappedRebase = true;

        nextRequestId = 1;
        minRequestId = 1;

        maxMinRequestIncrements = 30;

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

    function setNameAndSymbol(string memory _newName, string memory _newSymbol) external onlyOwner {
        name = _newName;
        symbol = _newSymbol;
    }

    function submitMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external virtual override returns (uint256 requestId) {
        requireTotalRequestsAmount(_tokenAmount);
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay, false, 0);
    }

    function submitKeepersMintRequest(uint168 _tokenAmount, uint32 _timeDelay, uint16 _maxBuyingPremiumFeePercentage) external override returns (uint256 requestId) {
        requireTotalRequestsAmount(_tokenAmount);
        require(_tokenAmount >= minKeepersMintAmount, "Not enough tokens");
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay, true, _maxBuyingPremiumFeePercentage);
    }

    function submitBurnRequest(uint168 _tokenAmount, uint32 _timeDelay) external override returns (uint256 requestId) {
        return submitRequest(BURN_REQUEST_TYPE, _tokenAmount, _timeDelay, false, 0);
    }

    function submitKeepersBurnRequest(uint168 _tokenAmount, uint32 _timeDelay) external override returns (uint256 requestId) {
        require(_tokenAmount >= minKeepersBurnAmount, "Not enough tokens");
        return submitRequest(BURN_REQUEST_TYPE, _tokenAmount, _timeDelay, true, 0);
    }

    function fulfillMintRequest(uint256 _requestId, uint16 _maxBuyingPremiumFeePercentage, bool _keepersCalled) public virtual override returns (uint256 tokensMinted, bool success) {
        require(!_keepersCalled || msg.sender == fulfiller); // Not allowed
        Request memory request = requests[_requestId];
        return _fulfillMintRequest(_requestId, request, _maxBuyingPremiumFeePercentage, _keepersCalled);
    }

    function fulfillBurnRequest(uint256 _requestId,  bool _keepersCalled) external override returns (uint256 tokensReceived) {
        require(!_keepersCalled || msg.sender == fulfiller); // Not allowed
        Request memory request = requests[_requestId];
        return _fulfillBurnRequest(_requestId, request, _keepersCalled);
    }

    function mintTokens(uint168 tokenAmount) external override returns (uint256 mintedTokens) {
        require(msg.sender == minter);
        token.safeTransferFrom(msg.sender, address(this), tokenAmount);
        (mintedTokens,) = mintTokens(0, msg.sender, tokenAmount, MAX_PERCENTAGE, false, false);
    }

    function burnTokens(uint168 burnAmount) external override returns (uint256 tokenAmount) {
        require(msg.sender == minter);
        IERC20Upgradeable(address(this)).safeTransferFrom(msg.sender, address(this), underlyingToValue(valueToUnderlying(uint256(burnAmount))));
        (tokenAmount,) = burnTokens(0, msg.sender, burnAmount, 0, 0, false, false);
    }

    function liquidateRequest(uint256 _requestId) external override nonReentrant returns (uint256 findersFeeAmount) {
        Request memory request = requests[_requestId];
        require(request.requestType != 0, "Request id not found");
        require(requestFeesCalculator.isLiquidable(request), "Not liquidable");
        findersFeeAmount = _liquidateRequest(_requestId, request);
    }

    function setMinter(address _newMinter) external override onlyOwner {
        minter = _newMinter;
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

    function setDeviationParameters(uint16 _newDeviationPercentagePerSingleRebaseLag, uint16 _newMinDeviationPercentage, uint16 _newMaxDeviationPercentage) external override onlyOwner {
        deviationPerSingleRebaseLag = _newDeviationPercentagePerSingleRebaseLag;
        minDeviationPercentage = _newMinDeviationPercentage;
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

    function setMinRequestId(uint256 _newMinRequestId) external override onlyOwner {
        minRequestId = _newMinRequestId;
    }

    function setMaxMinRequestIncrements(uint256 _newMaxMinRequestIncrements) external override onlyOwner {
        maxMinRequestIncrements = _newMaxMinRequestIncrements;
    }

    function setFulfiller(address _fulfiller) external override onlyOwner {
        fulfiller = _fulfiller;
    }

    function setKeepersFeeVaultAddress(address _newKeepersFeeVaultAddress) external override onlyOwner {
        keepersFeeVaultAddress = _newKeepersFeeVaultAddress;
    }

    function setMinKeepersAmounts(uint256 _newMinKeepersMintAmount, uint256 _newMinKeepersBurnAmount) external override onlyOwner {
        minKeepersMintAmount = _newMinKeepersMintAmount;
        minKeepersBurnAmount = _newMinKeepersBurnAmount;
    }

    struct SubmitRequestLocals {
        uint168 updatedTokenAmount;
        uint16 timeDelayFeePercent;
        uint16 maxFeesPercent;
        uint256 timeDelayFeeAmount;
        uint256 maxFeesAmount;
    }

    function submitRequest(uint8 _type, uint168 _tokenAmount, uint32 _timeDelay, bool _useKeepers, uint16 _maxBuyingPremiumFeePercentage) private nonReentrant returns (uint requestId) {
        require(_tokenAmount > 0);

        SubmitRequestLocals memory locals;

        // Converting to underlying value in case of burn request, to support rebasing until fulfill
        locals.updatedTokenAmount = _tokenAmount;
        if (_type == BURN_REQUEST_TYPE) {
            uint256 __updatedTokenAmount = valueToUnderlying(_tokenAmount);
            require(uint168(__updatedTokenAmount) == __updatedTokenAmount);
            locals.updatedTokenAmount = uint168(__updatedTokenAmount);
        }

        locals.timeDelayFeePercent = requestFeesCalculator.calculateTimeDelayFee(_timeDelay);
        locals.maxFeesPercent = requestFeesCalculator.getMaxFees();

        locals.timeDelayFeeAmount = locals.updatedTokenAmount * locals.timeDelayFeePercent / MAX_PERCENTAGE;
        locals.maxFeesAmount = locals.updatedTokenAmount * locals.maxFeesPercent / MAX_PERCENTAGE;

        requestId = nextRequestId;
        nextRequestId = nextRequestId + 1; // Overflow allowed to keep id cycling

        uint32 targetTimestamp = uint32(block.timestamp + _timeDelay);

        requests[requestId] = Request(_type, locals.updatedTokenAmount, locals.timeDelayFeePercent, locals.maxFeesPercent, msg.sender, uint32(block.timestamp), targetTimestamp, _useKeepers, _maxBuyingPremiumFeePercentage);

        if (_type != BURN_REQUEST_TYPE) {
            totalRequestsAmount = totalRequestsAmount + _tokenAmount;
        }

        collectRelevantTokens(_type, _useKeepers ? _tokenAmount : (_type == BURN_REQUEST_TYPE ? underlyingToValue(locals.timeDelayFeeAmount + locals.maxFeesAmount) : locals.timeDelayFeeAmount + locals.maxFeesAmount));

        emit SubmitRequest(requestId, _type, msg.sender, _tokenAmount, _type == BURN_REQUEST_TYPE ? underlyingToValue(locals.timeDelayFeeAmount) : locals.timeDelayFeeAmount, uint32(block.timestamp), targetTimestamp, _useKeepers, _maxBuyingPremiumFeePercentage);
    }

    struct PreFulfillResults {
        uint168 amountToFulfill;
        uint168 fulfillFees;
        uint168 timeDelayFees;
        uint16 fulfillFeesPercentage;
        bool wasLiquidated;
        uint168 depositAmount;
        uint168 mintAmount;
        bool shouldAbort;
        uint168 keepersFee;
    }

    function preFulfillRequest(uint256 _requestId, Request memory _request, uint8 _expectedType, bool _keepersCalled) private returns (PreFulfillResults memory results) {
        require((_keepersCalled && _request.useKeepers) || _request.owner == msg.sender); // Not allowed
        require(_request.requestType == _expectedType, "Wrong request type");

        if (requestFeesCalculator.isLiquidable(_request)) {
            _liquidateRequest(_requestId, _request);
            results.wasLiquidated = true;
        } else {
            require(!_keepersCalled || block.timestamp >= _request.targetTimestamp, "Target time not reached");
            results.fulfillFeesPercentage = _request.useKeepers && block.timestamp >= _request.targetTimestamp ? 0 : requestFeesCalculator.calculateTimePenaltyFee(_request);

            results.timeDelayFees = _request.tokenAmount * _request.timeDelayRequestFeesPercent / MAX_PERCENTAGE;

            if (_request.requestType == MINT_REQUEST_TYPE) {
                if (_request.useKeepers && _keepersCalled) {
                    // Note: Cast is safe as keepers fee is always less than amount
                    results.keepersFee = uint168(requestFeesCalculator.calculateKeepersFee(_request.tokenAmount));
                }

                results.fulfillFees = _request.tokenAmount * results.fulfillFeesPercentage / MAX_PERCENTAGE;
                results.amountToFulfill = _request.tokenAmount - results.timeDelayFees - results.fulfillFees - results.keepersFee;
            }

            if (!_request.useKeepers) {
                uint256 tokensLeftToTransfer = getUpdatedTokenAmount(_request.requestType, _request.tokenAmount - results.timeDelayFees - (_request.tokenAmount * _request.maxRequestFeesPercent / MAX_PERCENTAGE));
                collectRelevantTokens(_request.requestType, tokensLeftToTransfer);
            }

            if (_request.requestType == BURN_REQUEST_TYPE) {
                results.amountToFulfill = getUpdatedTokenAmount(_request.requestType, _request.tokenAmount);
            }
        }
    }

    function requireTotalRequestsAmount(uint168 _newTokenAmount) private view {
        require(!verifyTotalRequestsAmount || _newTokenAmount + totalRequestsAmount <= maxTotalRequestsAmount, "Total requests amount exceeded");
    }

    function _fulfillMintRequest(uint256 _requestId, Request memory _request, uint16 _maxBuyingPremiumFeePercentage, bool _keepersCalled) private returns (uint256 tokensMinted, bool success) {
        PreFulfillResults memory results = preFulfillRequest(_requestId, _request, MINT_REQUEST_TYPE, _keepersCalled);

        if (results.wasLiquidated) {
            success = true;
        } else {
            (tokensMinted, success) = mintTokens(_requestId, _request.owner, results.amountToFulfill, _maxBuyingPremiumFeePercentage, _request.useKeepers && _keepersCalled, true);

            if (success) {
                subtractTotalRequestAmount(_request.tokenAmount);
                deleteRequest(_requestId);

                feesCollector.sendProfit(results.timeDelayFees + results.fulfillFees, IERC20(address(token)));

                if (results.keepersFee > 0) {
                    token.safeTransfer(keepersFeeVaultAddress, results.keepersFee);
                }

                emit FulfillRequest(_requestId, _request.requestType, _request.owner, results.fulfillFees + results.keepersFee, false, _request.useKeepers, _keepersCalled, msg.sender, uint32(block.timestamp));
            }
        }
    }

    function _fulfillBurnRequest(uint256 _requestId, Request memory _request, bool _keepersCalled) private nonReentrant returns (uint256 tokensReceived) {
        PreFulfillResults memory results = preFulfillRequest(_requestId, _request, BURN_REQUEST_TYPE, _keepersCalled);

        if (!results.wasLiquidated) {
            deleteRequest(_requestId);

            uint256 fulfillFees;
            (tokensReceived, fulfillFees) = burnTokens(_requestId, _request.owner, results.amountToFulfill, _request.timeDelayRequestFeesPercent, results.fulfillFeesPercentage, _keepersCalled && _request.useKeepers, true);

            emit FulfillRequest(_requestId, _request.requestType, _request.owner, fulfillFees, false, _request.useKeepers, _keepersCalled, msg.sender, uint32(block.timestamp));
        }
    }

    function mintTokens(uint256 _requestId, address _owner, uint168 _tokenAmount, uint16 _maxBuyingPremiumFeePercentage, bool _catchRevert, bool _chargeOpenFee) private returns (uint256 tokensMinted, bool success) {
        uint256 balance = 0;

        {
            bool isPositive = true;

            (uint256 currPositionUnits,,,,) = platform.positions(address(this));
            if (currPositionUnits != 0) {
                (balance, isPositive,,,,) = platform.calculatePositionBalance(address(this));
            }
            require(isPositive, "Negative balance");
        }

        uint256 supply = totalSupply;

        (, uint256 positionedTokenAmount, uint256 openPositionFee, uint256 buyingPremiumFee, bool transactionSuccess) = openPosition(_tokenAmount, _maxBuyingPremiumFeePercentage, _catchRevert, _chargeOpenFee);

        if (transactionSuccess) {   
            if (supply > 0 && balance > 0) {
                tokensMinted = positionedTokenAmount * supply / balance;
            } else {
                tokensMinted = positionedTokenAmount * initialTokenToLPTokenRate;
            }

            emit Mint(_requestId, _owner, _tokenAmount, positionedTokenAmount, tokensMinted, openPositionFee, buyingPremiumFee);

            require(tokensMinted > 0, "Too few tokens");

            _mint(_owner, tokensMinted);
            success = true;
        }
    }

    function burnTokens(uint256 _requestId, address _owner, uint168 _tokenAmount, uint16 _timeDelayFeesPercentage, uint16 _fulfillFeesPercentage, bool _hasKeepersFee, bool _chargeCloseFee) private returns (uint256 tokensReceived, uint256 fulfillFees) {
        (uint256 tokensBeforeFees, uint256 closePositionFee, uint256 closingPremiumFee) = _burnTokens(_tokenAmount, _chargeCloseFee);

        {
            uint256 timeDelayFee = tokensBeforeFees * _timeDelayFeesPercentage / MAX_PERCENTAGE;
            fulfillFees = tokensBeforeFees * _fulfillFeesPercentage / MAX_PERCENTAGE;

            uint256 keepersFee = 0;
            if (_hasKeepersFee) {
                keepersFee = requestFeesCalculator.calculateKeepersFee(tokensBeforeFees);
            }

            tokensReceived = tokensBeforeFees - fulfillFees - timeDelayFee - keepersFee;

            if (fulfillFees + timeDelayFee > 0) {
                feesCollector.sendProfit(fulfillFees + timeDelayFee, IERC20(address(token)));
            }
            
            if (keepersFee > 0) {
                token.safeTransfer(keepersFeeVaultAddress, keepersFee);
                fulfillFees += keepersFee;
            }
        }

        token.safeTransfer(_owner, tokensReceived);

        emit Burn(_requestId, _owner, tokensBeforeFees, tokensReceived, _tokenAmount, closePositionFee, closingPremiumFee);
    }

    function _burnTokens(uint256 _tokenAmount, bool _chargeCloseFee) private returns (uint256 tokensReceived, uint256 closePositionFee, uint256 closingPremiumFee) {
        (, bool isPositive, uint168 totalPositionUnits,,,) = platform.calculatePositionBalance(address(this));
        require(isPositive, "Negative balance");

        uint256 positionUnits = totalPositionUnits * _tokenAmount / totalSupply;
        require(positionUnits == uint168(positionUnits), "Too much position units");

        if (positionUnits > 0) {
            (tokensReceived, closePositionFee, closingPremiumFee) = _chargeCloseFee ? 
                platform.closePosition(uint168(positionUnits), 1) :
                platform.closePositionWithoutFee(uint168(positionUnits), 1);
        }

        // Note: Moving to underlying and back in case rebase occured, and trying to burn too much because of rounding
        _burn(address(this), underlyingToValue(valueToUnderlying(_tokenAmount)));
    }

    function _liquidateRequest(uint256 _requestId, Request memory _request) private returns (uint256 findersFeeAmount) {
        uint168 updatedTokenAmount = getUpdatedTokenAmount(_request.requestType, _request.tokenAmount);
        uint256 leftAmount = updatedTokenAmount;

        if (!_request.useKeepers) {
            uint168 timeDelayFeeAmount = updatedTokenAmount * _request.timeDelayRequestFeesPercent / MAX_PERCENTAGE;
            uint168 maxFeesAmount = updatedTokenAmount * _request.maxRequestFeesPercent / MAX_PERCENTAGE;
            leftAmount = timeDelayFeeAmount + maxFeesAmount;   
        }

        if (_request.requestType == BURN_REQUEST_TYPE) {
            (leftAmount,,) = _burnTokens(leftAmount, true);
        } else {
            subtractTotalRequestAmount(updatedTokenAmount);
        }

        findersFeeAmount = _request.useKeepers ? requestFeesCalculator.calculateKeepersFee(leftAmount) : requestFeesCalculator.calculateFindersFee(leftAmount);

        deleteRequest(_requestId);

        if (_request.useKeepers) {
            token.safeTransfer(_request.owner, leftAmount - findersFeeAmount);
        } else {
            feesCollector.sendProfit(leftAmount - findersFeeAmount, IERC20(address(token)));
        }

        token.safeTransfer(msg.sender, findersFeeAmount);

        emit LiquidateRequest(_requestId, _request.requestType, _request.owner, msg.sender, findersFeeAmount, _request.useKeepers, uint32(block.timestamp));
    }

    function deleteRequest(uint256 _requestId) private {
        delete requests[_requestId];

        uint256 currMinRequestId = minRequestId;
        uint256 increments = 0;
        bool didIncrement = false;

        // Skip over non-keepers request ids as well as fulfilled ones, 
        // as minRequestId is used only to allow keepers to test which requests are waiting to be fulfilled
        while (currMinRequestId < nextRequestId && increments < maxMinRequestIncrements && (requests[currMinRequestId].owner == address(0) || requests[currMinRequestId].useKeepers == false)) {
            increments++;
            currMinRequestId++;
            didIncrement = true;
        }

        if (didIncrement) {
            minRequestId = currMinRequestId;
        }
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

    function openPosition(uint168 _amount, uint16 _maxBuyingPremiumFeePercentage, bool _catchRevert, bool _chargeOpenFee) private returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount, uint168 openPositionFee, uint168 buyingPremiumFee, bool transactionSuccess) {
        transactionSuccess = true;

        if (_catchRevert) {
            (bool success, bytes memory returnData) = 
                address(platform).call(abi.encodePacked(platform.openPosition.selector, abi.encode(_amount, platform.maxCVIValue(), _maxBuyingPremiumFeePercentage, 1)));

            if (success) {
                (positionUnitsAmount, positionedTokenAmount, openPositionFee, buyingPremiumFee) = abi.decode(returnData, (uint168, uint168, uint168, uint168));
            } else {
                transactionSuccess = false;
            }
        } else {
            (positionUnitsAmount, positionedTokenAmount, openPositionFee, buyingPremiumFee) = !_chargeOpenFee ? 
                platform.openPositionWithoutFee(_amount, platform.maxCVIValue(), 1) : 
                platform.openPosition(_amount, platform.maxCVIValue(), _maxBuyingPremiumFeePercentage, 1);
        }
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
