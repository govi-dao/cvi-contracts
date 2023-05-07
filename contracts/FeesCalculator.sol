// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IFeesCalculator.sol";

contract FeesCalculator is IFeesCalculator, Ownable {

    uint256 private constant PRECISION_DECIMALS = 1e10;

    uint256 private constant FUNDING_FEE_BASE_PERIOD = 1 days;

    uint256 private constant MAX_FUNDING_FEE_PERCENTAGE = 1000000;
    uint16 private constant CVI_DECIMALS = 100;

    uint16 private constant MAX_PERCENTAGE = 10000;

    uint16 private constant COLATERAL_VALUES_NUM = 101; // From 0.00 to 1.00 inclusive

    uint32 public fundingFeeMinRate = 2000;
    uint32 public fundingFeeMaxRate = 100000;

    uint32 public minFundingFeeCviThreshold = 150;
    uint32 public maxFundingFeeCviThreshold = 50;
    uint32 public fundingFeeDivisionFactor = 5;

    uint32[] private fundingFeeCoefficients = [100000, 114869, 131950, 151571, 174110];

    uint32 public maxCVIValue;

    uint16 public override depositFeePercent = 0;
    uint16 public override withdrawFeePercent = 0;
    uint16 public override openPositionFeePercent = 15;
    uint16 public override openPositionLPFeePercent = 15;
    uint16 public override closePositionLPFeePercent = 0;
    uint16 public buyingPremiumFeeMaxPercent = 1000;
    uint16 public closingPremiumFeeMaxPercent = 1000;
    uint16 public override closePositionFeePercent = 30;

    uint16 public buyingPremiumThreshold = 6500; // 1.0 is MAX_PERCENTAGE = 10000

    uint16 public closePositionMaxFeePercent = 300;

    uint16 public maxTurbulenceFeePercentToTrim = 100;
    uint16 public turbulenceStepPercent = 1000;
    uint16 public override turbulenceIndicatorPercent = 0;

    uint256 public oracleHeartbeatPeriod = 55 minutes;
    uint256 public closePositionFeeDecayPeriod = 24 hours;
    uint256 public fundingFeeConstantRate = 3000;

    uint16 public turbulenceDeviationThresholdPercent = 7000; // 1.0 is MAX_PERCENTAGE = 10000
    uint16 public turbulenceDeviationPercentage = 500; // 1.0 is MAX_PERCENTAGE = 10000
    uint8 public override oracleLeverage = 1;

    uint16[] public collateralToBuyingPremiumMapping = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6, 8, 9, 11, 14, 16, 20, 24, 29, 35, 42, 52, 63, 77, 94, 115, 140, 172, 212, 261, 323, 399, 495, 615, 765, 953, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
    uint32[] public collateralToExtraFundingFeeMapping = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    ICVIOracle public cviOracle;
    IThetaVaultInfo public thetaVault;
    address public stateUpdator;

    modifier onlyStateUpdator {
        require(msg.sender == stateUpdator, "Not allowed");
        _;
    }

    constructor(ICVIOracle _cviOracle, uint32 _maxCVIValue, uint8 _oracleLeverage) {
        maxCVIValue = _maxCVIValue;
        cviOracle = _cviOracle;
        oracleLeverage = _oracleLeverage;
    }

    function updateTurbulenceIndicatorPercent(uint256 _totalTime, uint256 _newRounds, uint32 _lastCVIValue, uint32 _currCVIValue) external override onlyStateUpdator {
        uint16 updatedTurbulenceIndicatorPercent = calculateTurbulenceIndicatorPercent(_totalTime, _newRounds, _lastCVIValue, _currCVIValue);

        if (updatedTurbulenceIndicatorPercent != turbulenceIndicatorPercent) {
            turbulenceIndicatorPercent = updatedTurbulenceIndicatorPercent;
        }
    }

    function setOracle(ICVIOracle _cviOracle) external override onlyOwner {
        cviOracle = _cviOracle;
    }

    function setThetaVault(IThetaVaultInfo _thetaVault) external override onlyOwner {
        thetaVault = _thetaVault;
    }

    function setFundingFeeMinRate(uint32 _newFundingFeeMinRate) external override onlyOwner {
        fundingFeeMinRate = _newFundingFeeMinRate;
    }

    function setFundingFeeMaxRate(uint32 _newFundingFeeMaxRate) external override onlyOwner {
        fundingFeeMaxRate = _newFundingFeeMaxRate;
    }

    function setMinFundingFeeCviThreshold(uint32 _newMinFundingFeeCviThreshold) external override onlyOwner {
        minFundingFeeCviThreshold = _newMinFundingFeeCviThreshold;
    }

    function setMaxFundingFeeCviThreshold(uint32 _newMaxFundingFeeCviThreshold) external override onlyOwner {
        maxFundingFeeCviThreshold = _newMaxFundingFeeCviThreshold;
    }

    function setFundingFeeDivisionFactor(uint32 _newFundingFeeDivisionFactor) external override onlyOwner {
        fundingFeeDivisionFactor = _newFundingFeeDivisionFactor;
    }

    function setFundingFeeCoefficients(uint32[] calldata _newFundingFeeCoefficients) external override onlyOwner {
        require(_newFundingFeeCoefficients.length == fundingFeeDivisionFactor, "Bad size");
        fundingFeeCoefficients = _newFundingFeeCoefficients;
    }

    function setStateUpdator(address _newUpdator) external override onlyOwner {
        stateUpdator = _newUpdator;
    }

    function setDepositFee(uint16 _newDepositFeePercentage) external override onlyOwner {
        require(_newDepositFeePercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        depositFeePercent = _newDepositFeePercentage;
    }

    function setWithdrawFee(uint16 _newWithdrawFeePercentage) external override onlyOwner {
        require(_newWithdrawFeePercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        withdrawFeePercent = _newWithdrawFeePercentage;
    }

    function setOpenPositionFee(uint16 _newOpenPositionFeePercentage) external override onlyOwner {
        require(_newOpenPositionFeePercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        openPositionFeePercent = _newOpenPositionFeePercentage;
    }

    function setClosePositionFee(uint16 _newClosePositionFeePercentage) external override onlyOwner {
        require(_newClosePositionFeePercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        require(_newClosePositionFeePercentage <= closePositionMaxFeePercent, "Min fee above max fee");
        closePositionFeePercent = _newClosePositionFeePercentage;
    }

    function setOpenPositionLPFee(uint16 _newOpenPositionLPFeePercent) external override onlyOwner {
        require(_newOpenPositionLPFeePercent < MAX_PERCENTAGE, "Fee exceeds maximum");
        openPositionLPFeePercent = _newOpenPositionLPFeePercent;
    }

    function setClosePositionLPFee(uint16 _newClosePositionLPFeePercent) external override onlyOwner {
        require(_newClosePositionLPFeePercent < MAX_PERCENTAGE, "Fee exceeds maximum");
        closePositionLPFeePercent = _newClosePositionLPFeePercent;
    }

    function setClosePositionMaxFee(uint16 _newClosePositionMaxFeePercentage) external override onlyOwner {
        require(_newClosePositionMaxFeePercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        require(_newClosePositionMaxFeePercentage >= closePositionFeePercent, "Max fee below min fee");
        closePositionMaxFeePercent = _newClosePositionMaxFeePercentage;
    }

    function setClosePositionFeeDecay(uint256 _newClosePositionFeeDecayPeriod) external override onlyOwner {
        require(_newClosePositionFeeDecayPeriod > 0, "Period must be positive");
        closePositionFeeDecayPeriod = _newClosePositionFeeDecayPeriod;
    }

    function setOracleHeartbeatPeriod(uint256 _newOracleHeartbeatPeriod) external override onlyOwner {
        require(_newOracleHeartbeatPeriod > 0, "Heartbeat must be positive");
        oracleHeartbeatPeriod = _newOracleHeartbeatPeriod;
    }

    function setBuyingPremiumFeeMax(uint16 _newBuyingPremiumFeeMaxPercentage) external override onlyOwner {
        require(_newBuyingPremiumFeeMaxPercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        buyingPremiumFeeMaxPercent = _newBuyingPremiumFeeMaxPercentage;
    }

    function setBuyingPremiumThreshold(uint16 _newBuyingPremiumThreshold) external override onlyOwner {
        require(_newBuyingPremiumThreshold < MAX_PERCENTAGE, "Threshold exceeds maximum");
        buyingPremiumThreshold = _newBuyingPremiumThreshold;   
    }

    function setClosingPremiumFeeMax(uint16 _newClosingPremiumFeeMaxPercentage) external override onlyOwner {
        require(_newClosingPremiumFeeMaxPercentage < MAX_PERCENTAGE, "Fee exceeds maximum");
        closingPremiumFeeMaxPercent = _newClosingPremiumFeeMaxPercentage;
    }

    function setCollateralToBuyingPremiumMapping(uint16[] calldata _newCollateralToBuyingPremiumMapping) external override onlyOwner {
        require(_newCollateralToBuyingPremiumMapping.length == COLATERAL_VALUES_NUM, "Bad mapping size");
        collateralToBuyingPremiumMapping = _newCollateralToBuyingPremiumMapping;
    }

    function setFundingFeeConstantRate(uint16 _newfundingFeeConstantRate) external override onlyOwner {
        require(_newfundingFeeConstantRate < fundingFeeMaxRate, "Fee exceeds maximum");
        fundingFeeConstantRate = _newfundingFeeConstantRate;
    }

    function setCollateralToExtraFundingFeeMapping(uint32[] calldata _newCollateralToExtraFundingFeeMapping) external override onlyOwner {
        require(_newCollateralToExtraFundingFeeMapping.length == COLATERAL_VALUES_NUM, "Bad mapping size");
        collateralToExtraFundingFeeMapping = _newCollateralToExtraFundingFeeMapping;
    }

    function setTurbulenceStep(uint16 _newTurbulenceStepPercentage) external override onlyOwner {
        require(_newTurbulenceStepPercentage < MAX_PERCENTAGE, "Step exceeds maximum");
        turbulenceStepPercent = _newTurbulenceStepPercentage;
    }
    
    function setMaxTurbulenceFeePercentToTrim(uint16 _newMaxTurbulenceFeePercentToTrim) external override onlyOwner {
        require(_newMaxTurbulenceFeePercentToTrim < MAX_PERCENTAGE, "Fee exceeds maximum");
        maxTurbulenceFeePercentToTrim = _newMaxTurbulenceFeePercentToTrim;
    }

     function setTurbulenceDeviationThresholdPercent(uint16 _newTurbulenceDeviationThresholdPercent) external override onlyOwner {
        require(_newTurbulenceDeviationThresholdPercent < MAX_PERCENTAGE, "Threshold exceeds maximum");
        turbulenceDeviationThresholdPercent = _newTurbulenceDeviationThresholdPercent;
    }

    function setTurbulenceDeviationPercent(uint16 _newTurbulenceDeviationPercentage) external override onlyOwner {
        require(_newTurbulenceDeviationPercentage < MAX_PERCENTAGE, "Deviation exceeds maximum");
        turbulenceDeviationPercentage = _newTurbulenceDeviationPercentage;
    }

    function calculateTurbulenceIndicatorPercent(uint256 totalTime, uint256 newRounds, uint32 _lastCVIValue, uint32 _currCVIValue) public view override returns (uint16) {
        uint16 updatedTurbulenceIndicatorPercent = turbulenceIndicatorPercent;

        uint256 CVIDeltaPercent = uint256(_currCVIValue > _lastCVIValue ? (_currCVIValue - _lastCVIValue) : (_lastCVIValue - _currCVIValue)) * MAX_PERCENTAGE / _lastCVIValue;
        uint256 maxAllowedTurbulenceTimes = CVIDeltaPercent * MAX_PERCENTAGE / (uint256(turbulenceDeviationThresholdPercent) * turbulenceDeviationPercentage);

        uint256 decayTimes = 0;
        uint256 turbulenceTimes = 0;
        uint256 totalHeartbeats = totalTime / oracleHeartbeatPeriod;
        if (newRounds > totalHeartbeats) {
            turbulenceTimes = newRounds - totalHeartbeats;
            turbulenceTimes = turbulenceTimes >  maxAllowedTurbulenceTimes ? maxAllowedTurbulenceTimes : turbulenceTimes;
            decayTimes = newRounds - turbulenceTimes;
        } else {
            decayTimes = newRounds;
        }

        for (uint256 i = 0; i < decayTimes; i++) {
            updatedTurbulenceIndicatorPercent = updatedTurbulenceIndicatorPercent / 2;
        }

        if (updatedTurbulenceIndicatorPercent < maxTurbulenceFeePercentToTrim) {
            updatedTurbulenceIndicatorPercent = 0;
        }

        for (uint256 i = 0; i < turbulenceTimes; i++) {
            updatedTurbulenceIndicatorPercent = updatedTurbulenceIndicatorPercent + uint16(uint256(buyingPremiumFeeMaxPercent) * turbulenceStepPercent / MAX_PERCENTAGE);
        }

        if (updatedTurbulenceIndicatorPercent > buyingPremiumFeeMaxPercent) {
            updatedTurbulenceIndicatorPercent = buyingPremiumFeeMaxPercent;
        }

        return updatedTurbulenceIndicatorPercent;
    }

    function calculateBuyingPremiumFee(uint168 _tokenAmount, uint8 _leverage, uint256 _lastTotalLeveragedTokens, uint256 _lastTotalPositionUnits, uint256 _totalLeveragedTokens, uint256 _totalPositionUnits) external view override returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        (buyingPremiumFee, combinedPremiumFeePercentage) =  _calculateBuyingPremiumFeeWithParameters(_tokenAmount, _leverage, _lastTotalLeveragedTokens, _lastTotalPositionUnits, _totalLeveragedTokens, _totalPositionUnits, turbulenceIndicatorPercent);
    }
    
    function calculateBuyingPremiumFeeWithAddendum(uint168 _tokenAmount, uint8 _leverage, uint256 _lastTotalLeveragedTokens, uint256 _lastTotalPositionUnits, uint256 _totalLeveragedTokens, uint256 _totalPositionUnits, uint16 _turbulenceIndicatorPercent) external view override returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        (buyingPremiumFee, combinedPremiumFeePercentage) = _calculateBuyingPremiumFeeWithParameters(_tokenAmount, _leverage,
            _lastTotalLeveragedTokens, _lastTotalPositionUnits, _totalLeveragedTokens, _totalPositionUnits, _turbulenceIndicatorPercent);
    }

    function calculateClosingPremiumFee() external view override returns (uint16 premiumFeePercentage) {
        return closePositionLPFeePercent;
    }

    function calculateSingleUnitFundingFee(CVIValue[] memory _cviValues, uint256 _totalLeveragedTokens, uint256 _totalPositionUnits) public override view returns (uint256 fundingFee) {
        uint256 collateralRatio = calculateCollateralRatio(_totalLeveragedTokens, _totalPositionUnits);

        for (uint8 i = 0; i < _cviValues.length; i++) {
            (uint256 currFundingFee,) = calculateSingleUnitPeriodFundingFee(_cviValues[i], collateralRatio);
            fundingFee = fundingFee + currFundingFee;
        }
    }

    function updateSnapshots(uint256 _latestTimestamp, uint256 _blockTimestampSnapshot, uint256 _latestTimestampSnapshot, uint80 _latestOracleRoundId, uint256 _totalLeveragedTokens, uint256 _totalPositionUnits) external override view returns (SnapshotUpdate memory snapshotUpdate) {
        (uint32 cviValue, uint80 periodEndRoundId, uint256 periodEndTimestamp) = cviOracle.getCVILatestRoundData();
        snapshotUpdate.cviValue = cviValue;
        snapshotUpdate.cviValueTimestamp = periodEndTimestamp;

        snapshotUpdate.latestSnapshot = _blockTimestampSnapshot;
        if (snapshotUpdate.latestSnapshot != 0) { // Block was already updated
            snapshotUpdate.singleUnitFundingFee = 0;
            return snapshotUpdate;
        }

        if (_latestTimestamp == 0) { // For first recorded block
            snapshotUpdate.latestSnapshot = PRECISION_DECIMALS;
            snapshotUpdate.updatedSnapshot = true;
            snapshotUpdate.newLatestRoundId = periodEndRoundId;
            snapshotUpdate.updatedLatestRoundId = true;
            snapshotUpdate.updatedLatestTimestamp = true;
            snapshotUpdate.singleUnitFundingFee = 0;
            return snapshotUpdate;
        }

        uint80 periodStartRoundId = _latestOracleRoundId;
        require(periodEndRoundId >= periodStartRoundId, "Bad round id");

        snapshotUpdate.totalRounds = periodEndRoundId - periodStartRoundId;

        IFeesCalculator.CVIValue[] memory cviValues = new IFeesCalculator.CVIValue[](snapshotUpdate.totalRounds > 0 ? 2 : 1);
        
        if (snapshotUpdate.totalRounds > 0) {
            (uint32 periodStartCVIValue, uint256 periodStartTimestamp) = cviOracle.getCVIRoundData(periodStartRoundId);
            cviValues[0] = IFeesCalculator.CVIValue(periodEndTimestamp - _latestTimestamp, periodStartCVIValue);
            cviValues[1] = IFeesCalculator.CVIValue(block.timestamp - periodEndTimestamp, cviValue);

            snapshotUpdate.newLatestRoundId = periodEndRoundId;
            snapshotUpdate.updatedLatestRoundId = true;

            snapshotUpdate.totalTime = periodEndTimestamp - periodStartTimestamp;
            snapshotUpdate.updatedTurbulenceData = true;
        } else {
            cviValues[0] = IFeesCalculator.CVIValue(block.timestamp - _latestTimestamp, cviValue);
        }

        snapshotUpdate.singleUnitFundingFee = calculateSingleUnitFundingFee(cviValues, _totalLeveragedTokens, _totalPositionUnits);
        snapshotUpdate.latestSnapshot = _latestTimestampSnapshot + snapshotUpdate.singleUnitFundingFee;
        snapshotUpdate.updatedSnapshot = true;
        snapshotUpdate.updatedLatestTimestamp = true;
    }

    function calculateClosePositionFeePercent(uint256 _creationTimestamp, bool _isNoLockPositionAddress) external view override returns (uint16) {
        if (block.timestamp - _creationTimestamp >= closePositionFeeDecayPeriod || _isNoLockPositionAddress) {
            return closePositionFeePercent;
        }

        uint16 decay = uint16((closePositionMaxFeePercent - closePositionFeePercent) * (block.timestamp - _creationTimestamp) / 
            closePositionFeeDecayPeriod);
        return closePositionMaxFeePercent - decay;
    }

    function calculateWithdrawFeePercent(uint256) external view override returns (uint16) {
        return withdrawFeePercent;
    }

    function openPositionFees() external view override returns (uint16 openPositionFeePercentResult, uint16 buyingPremiumFeeMaxPercentResult) {
        openPositionFeePercentResult = openPositionFeePercent;
        buyingPremiumFeeMaxPercentResult = buyingPremiumFeeMaxPercent;
    }

    function calculateSingleUnitPeriodFundingFee(CVIValue memory _cviValue, uint256 _collateralRatio) public view override returns (uint256 fundingFee, uint256 fundingFeeRatePercents) {
        if (_cviValue.cviValue == 0 || _cviValue.period == 0) {
            return (0, 0);
        }

        fundingFeeRatePercents = fundingFeeMaxRate;
        uint32 integerCVIValue = _cviValue.cviValue / oracleLeverage / CVI_DECIMALS;
        if (integerCVIValue > maxFundingFeeCviThreshold) {
            if (integerCVIValue >= minFundingFeeCviThreshold) {
                fundingFeeRatePercents = fundingFeeMinRate;
            } else {

                uint256 exponent = (integerCVIValue - maxFundingFeeCviThreshold) / fundingFeeDivisionFactor;
                uint256 coefficientIndex = (integerCVIValue - maxFundingFeeCviThreshold) % fundingFeeDivisionFactor;

                // Note: overflow is not possible as the exponent can only get larger, and other parts are constants
                // However, 2 ** exponent can overflow if cvi value is wrong

                require(exponent < 256, "exponent overflow");
                fundingFeeRatePercents = PRECISION_DECIMALS / (2 ** exponent) / fundingFeeCoefficients[coefficientIndex] + fundingFeeConstantRate;
            }
        }

        uint256 index = _collateralRatio * 10**2 / PRECISION_DECIMALS;
        fundingFeeRatePercents += fundingFeeRatePercents * collateralToExtraFundingFeeMapping[index >= collateralToExtraFundingFeeMapping.length ? collateralToExtraFundingFeeMapping.length - 1 : index] / MAX_PERCENTAGE;

        if (fundingFeeRatePercents > fundingFeeMaxRate) {
            fundingFeeRatePercents = fundingFeeMaxRate;
        }

        fundingFee = PRECISION_DECIMALS * fundingFeeRatePercents * _cviValue.period * _cviValue.cviValue /
            FUNDING_FEE_BASE_PERIOD / MAX_FUNDING_FEE_PERCENTAGE / maxCVIValue;
    }

    function _calculateBuyingPremiumFeeWithParameters(uint168 _tokenAmount, uint8 _leverage, uint256 _lastTotalLeveragedTokens, uint256 _lastTotalPositionUnits, uint256 _totalLeveragedTokens, uint256 _totalPositionUnits, uint16 _turbulenceIndicatorPercent) private view returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        uint256 collateralRatio = calculateCollateralRatio(_totalLeveragedTokens, _totalPositionUnits);
        uint256 lastCollateralRatio = calculateCollateralRatio(_lastTotalLeveragedTokens, _lastTotalPositionUnits);

        uint16 buyingPremiumFeePercentage = 0;
        if (collateralRatio >= PRECISION_DECIMALS) {
            buyingPremiumFeePercentage = calculateRelativePercentage(buyingPremiumFeeMaxPercent, collateralRatio, lastCollateralRatio);
        } else {
            if (collateralRatio >= buyingPremiumThreshold * PRECISION_DECIMALS / MAX_PERCENTAGE) {
                buyingPremiumFeePercentage = calculateRelativePercentage(collateralToBuyingPremiumMapping[collateralRatio * 10**2 / PRECISION_DECIMALS], collateralRatio, lastCollateralRatio);
            }
        }

        combinedPremiumFeePercentage = openPositionLPFeePercent + _turbulenceIndicatorPercent + buyingPremiumFeePercentage;
        if (combinedPremiumFeePercentage > buyingPremiumFeeMaxPercent) {
            combinedPremiumFeePercentage = buyingPremiumFeeMaxPercent;
        }

        uint256 __buyingPremiumFee = uint256(_tokenAmount) * _leverage * combinedPremiumFeePercentage / MAX_PERCENTAGE;
        buyingPremiumFee = uint168(__buyingPremiumFee);
        require(__buyingPremiumFee == buyingPremiumFee, "Too much tokens");
    }

    function calculateCollateralRatio(uint256 _totalLeveragedTokens, uint256 _totalPositionUnits) public view override returns (uint256 collateralRatio) {
        uint256 vaultPositionUnits = 0;

        if (address(thetaVault) != address(0)) {
            vaultPositionUnits = thetaVault.vaultPositionUnits();
        }

        collateralRatio = _totalLeveragedTokens == 0 ? 0 : (_totalPositionUnits - vaultPositionUnits) * PRECISION_DECIMALS / _totalLeveragedTokens;
    }
    
    function calculateRelativePercentage(uint16 _percentage, uint256 _collateralRatio, uint256 _lastCollateralRatio) private view returns (uint16) {
        if (_lastCollateralRatio >= buyingPremiumThreshold * PRECISION_DECIMALS / MAX_PERCENTAGE || _collateralRatio == _lastCollateralRatio) {
            return _percentage;
        }

        return uint16(_percentage * (_collateralRatio - buyingPremiumThreshold * PRECISION_DECIMALS / MAX_PERCENTAGE) / (_collateralRatio - _lastCollateralRatio));
    }

    function getCollateralToBuyingPremiumMapping() external view override returns(uint16[] memory) {
        return collateralToBuyingPremiumMapping;
    }

    function getCollateralToExtraFundingFeeMapping() external view override returns(uint32[] memory) {
        return collateralToExtraFundingFeeMapping;
    }

    function getFundingFeeCoefficients() external view override returns(uint32[] memory) {
        return fundingFeeCoefficients;
    }
}
