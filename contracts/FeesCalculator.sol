// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IFeesCalculator.sol";

contract FeesCalculator is IFeesCalculator, Ownable {

    uint256 private constant PRECISION_DECIMALS = 1e10;

    uint256 private constant FUNDING_FEE_MIN_RATE = 2000;
    uint256 private constant FUNDING_FEE_MAX_RATE = 100000;
    uint256 private constant FUNDING_FEE_BASE_PERIOD = 1 days;

    uint256 private constant MAX_FUNDING_FEE_PERCENTAGE = 1000000;
    uint16 private constant CVI_DECIMALS = 100;

    uint16 private constant MAX_FUNDING_FEE_CVI_THRESHOLD = 55;
    uint16 private constant MIN_FUDNING_FEE_CVI_THRESHOLD = 150;
    uint16 private constant FUNDING_FEE_DIVISION_FACTOR = 5;

    uint16 private constant MAX_PERCENTAGE = 10000;

    uint16 public maxCVIValue;

    uint16 public override depositFeePercent = 0;
    uint16 public override withdrawFeePercent = 0;
    uint16 public override openPositionFeePercent = 15;
    uint16 public override openPositionLPFeePercent = 15;
    uint16 public override buyingPremiumFeeMaxPercent = 1000;
    uint16 public override closePositionFeePercent = 30;

    uint16 public buyingPremiumThreshold = 8000; // 1.0 is MAX_PERCENTAGE = 10000

    uint16 public closePositionMaxFeePercent = 300;

    uint16 public maxTurbulenceFeePercentToTrim = 100;
    uint16 public turbulenceStepPercent = 1000;
    uint16 public override turbulenceIndicatorPercent = 0;

    uint256 public oracleHeartbeatPeriod = 55 minutes;
    uint256 public closePositionFeeDecayPeriod = 24 hours;
    uint256 public fundingFeeConstantRate = 3000;

    uint16 public turbulenceDeviationThresholdPercent = 7000; // 1.0 is MAX_PERCENTAGE = 10000
    uint16 public turbulenceDeviationPercentage = 500; // 1.0 is MAX_PERCENTAGE = 10000

    ICVIOracle public cviOracle;
    address public turbulenceUpdator;

    modifier onlyTurbulenceUpdator {
        require(msg.sender == turbulenceUpdator, "Not allowed");
        _;
    }

    constructor(ICVIOracle _cviOracle, uint16 _maxCVIValue) {
        maxCVIValue = _maxCVIValue;
        cviOracle = _cviOracle;
    }

    function updateTurbulenceIndicatorPercent(uint256 _totalTime, uint256 _newRounds, uint16 _lastCVIValue, uint16 _currCVIValue) external override onlyTurbulenceUpdator returns (uint16 updatedTurbulenceIndicatorPercent) {
        uint256 totalHeartbeats = _totalTime / oracleHeartbeatPeriod;
        updatedTurbulenceIndicatorPercent = calculateTurbulenceIndicatorPercent(totalHeartbeats, _newRounds, _lastCVIValue, _currCVIValue);

        if (updatedTurbulenceIndicatorPercent != turbulenceIndicatorPercent) {
            turbulenceIndicatorPercent = updatedTurbulenceIndicatorPercent;
        }
    }

    function setOracle(ICVIOracle _cviOracle) external override onlyOwner {
        cviOracle = _cviOracle;
    }

    function setTurbulenceUpdator(address _newUpdator) external override onlyOwner {
        turbulenceUpdator = _newUpdator;
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

    function setFundingFeeConstantRate(uint16 _newfundingFeeConstantRate) external override onlyOwner {
        require(_newfundingFeeConstantRate < FUNDING_FEE_MAX_RATE, "Fee exceeds maximum");
        fundingFeeConstantRate = _newfundingFeeConstantRate;
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

    function calculateTurbulenceIndicatorPercent(uint256 totalHeartbeats, uint256 newRounds, uint16 _lastCVIValue, uint16 _currCVIValue) public view override returns (uint16) {
        uint16 updatedTurbulenceIndicatorPercent = turbulenceIndicatorPercent;

        uint256 CVIDeltaPercent = uint256(_currCVIValue > _lastCVIValue ? (_currCVIValue - _lastCVIValue) : (_lastCVIValue - _currCVIValue)) * MAX_PERCENTAGE / _lastCVIValue;
        uint256 maxAllowedTurbulenceTimes = CVIDeltaPercent * MAX_PERCENTAGE / (uint256(turbulenceDeviationThresholdPercent) * turbulenceDeviationPercentage);

        uint256 decayTimes = 0;
        uint256 turbulenceTimes = 0;
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

    function calculateBuyingPremiumFee(uint168 _tokenAmount, uint8 _leverage, uint256 _collateralRatio, uint256 _lastCollateralRatio) external view override returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        (buyingPremiumFee, combinedPremiumFeePercentage) =  _calculateBuyingPremiumFeeWithTurbulence(_tokenAmount, _leverage, _collateralRatio, _lastCollateralRatio, turbulenceIndicatorPercent);
    }
    
    function calculateBuyingPremiumFeeWithTurbulence(uint168 _tokenAmount, uint8 _leverage, uint256 _collateralRatio, uint256 _lastCollateralRatio, uint16 _turbulenceIndicatorPercent) external view override returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        (buyingPremiumFee, combinedPremiumFeePercentage) = _calculateBuyingPremiumFeeWithTurbulence(_tokenAmount, _leverage, _collateralRatio, _lastCollateralRatio, _turbulenceIndicatorPercent);
    }

    function calculateSingleUnitFundingFee(CVIValue[] memory _cviValues) public override view returns (uint256 fundingFee) {
        for (uint8 i = 0; i < _cviValues.length; i++) {
            fundingFee = fundingFee + calculateSingleUnitPeriodFundingFee(_cviValues[i]);
        }
    }

    function calculateSingleUnitPeriodFundingFee(CVIValue memory _cviValue) private view returns (uint256 fundingFee) {
        if (_cviValue.cviValue == 0 || _cviValue.period == 0) {
            return 0;
        }

        uint256 fundingFeeRatePercents = FUNDING_FEE_MAX_RATE;
        uint16 integerCVIValue = _cviValue.cviValue / CVI_DECIMALS;
        if (integerCVIValue > MAX_FUNDING_FEE_CVI_THRESHOLD) {
            if (integerCVIValue >= MIN_FUDNING_FEE_CVI_THRESHOLD) {
                fundingFeeRatePercents = FUNDING_FEE_MIN_RATE;
            } else {
                // Defining as memory to keep function pure and save storage space + reads
                uint24[5] memory fundingFeeCoefficients = [100000, 114869, 131950, 151571, 174110];

                uint256 exponent = (integerCVIValue - MAX_FUNDING_FEE_CVI_THRESHOLD) / FUNDING_FEE_DIVISION_FACTOR;
                uint256 coefficientIndex = (integerCVIValue - MAX_FUNDING_FEE_CVI_THRESHOLD) % FUNDING_FEE_DIVISION_FACTOR;

                // Note: overflow is not possible as the exponent can only get larger, and other parts are constants
                // However, 2 ** exponent can overflow if cvi value is wrong

                require(exponent < 256, "exponent overflow");
                fundingFeeRatePercents = PRECISION_DECIMALS / (2 ** exponent) / fundingFeeCoefficients[coefficientIndex] + fundingFeeConstantRate;

                if (fundingFeeRatePercents > FUNDING_FEE_MAX_RATE) {
                    fundingFeeRatePercents = FUNDING_FEE_MAX_RATE;
                }
            }
        }

        return PRECISION_DECIMALS * _cviValue.cviValue * fundingFeeRatePercents * _cviValue.period /
            FUNDING_FEE_BASE_PERIOD / maxCVIValue / MAX_FUNDING_FEE_PERCENTAGE;
    }

    function updateSnapshots(uint256 _latestTimestamp, uint256 _blockTimestampSnapshot, uint256 _latestTimestampSnapshot, uint80 latestOracleRoundId) external override  view returns (SnapshotUpdate memory snapshotUpdate) {
        (uint16 cviValue, uint80 periodEndRoundId, uint256 periodEndTimestamp) = cviOracle.getCVILatestRoundData();
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

        uint80 periodStartRoundId = latestOracleRoundId;
        require(periodEndRoundId >= periodStartRoundId, "Bad round id");

        snapshotUpdate.totalRounds = periodEndRoundId - periodStartRoundId;

        uint256 cviValuesNum = snapshotUpdate.totalRounds > 0 ? 2 : 1;
        IFeesCalculator.CVIValue[] memory cviValues = new IFeesCalculator.CVIValue[](cviValuesNum);
        
        if (snapshotUpdate.totalRounds > 0) {
            (uint16 periodStartCVIValue, uint256 periodStartTimestamp) = cviOracle.getCVIRoundData(periodStartRoundId);
            cviValues[0] = IFeesCalculator.CVIValue(periodEndTimestamp - _latestTimestamp, periodStartCVIValue);
            cviValues[1] = IFeesCalculator.CVIValue(block.timestamp - periodEndTimestamp, cviValue);

            snapshotUpdate.newLatestRoundId = periodEndRoundId;
            snapshotUpdate.updatedLatestRoundId = true;

            snapshotUpdate.totalTime = periodEndTimestamp - periodStartTimestamp;
            snapshotUpdate.updatedTurbulenceData = true;
        } else {
            cviValues[0] = IFeesCalculator.CVIValue(block.timestamp - _latestTimestamp, cviValue);
        }

        snapshotUpdate.singleUnitFundingFee = calculateSingleUnitFundingFee(cviValues);
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

    function _calculateBuyingPremiumFeeWithTurbulence(uint168 _tokenAmount, uint8 _leverage, uint256 _collateralRatio, uint256 _lastCollateralRatio, uint16 _turbulenceIndicatorPercent) private view returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        require(_collateralRatio >= _lastCollateralRatio);

        uint16 buyingPremiumFeePercentage = 0;
        if (_collateralRatio >= PRECISION_DECIMALS) {
            buyingPremiumFeePercentage = calculateRelativePercentage(buyingPremiumFeeMaxPercent, _collateralRatio, _lastCollateralRatio);
        } else {
            if (_collateralRatio >= buyingPremiumThreshold * PRECISION_DECIMALS / MAX_PERCENTAGE) {
                // NOTE: The collateral ratio can never be bigger than 1.0 (= PERCISION_DECIMALS) in calls from the platform,
                // so there is no issue with having a revert always occuring on (PRECISION_DECIMALS - _collateralRatio) on specific scenarios

                // Denominator is multiplied by PRECISION_DECIMALS, but is squared, so need to have a square in numerator as well
                // TOOD: Use safecast?
                buyingPremiumFeePercentage = calculateRelativePercentage(uint16(PRECISION_DECIMALS ** 2 / (PRECISION_DECIMALS - _collateralRatio) ** 2), _collateralRatio, _lastCollateralRatio);
            }
        }

        combinedPremiumFeePercentage = buyingPremiumFeePercentage == 0 ? openPositionLPFeePercent + _turbulenceIndicatorPercent : buyingPremiumFeePercentage + _turbulenceIndicatorPercent;
        if (combinedPremiumFeePercentage > buyingPremiumFeeMaxPercent) {
            combinedPremiumFeePercentage = buyingPremiumFeeMaxPercent;
        }
        
        uint256 __buyingPremiumFee = uint256(_tokenAmount) * _leverage * combinedPremiumFeePercentage / MAX_PERCENTAGE;
        buyingPremiumFee = uint168(__buyingPremiumFee);
        require(__buyingPremiumFee == buyingPremiumFee, "Too much tokens");
    }

    function calculateRelativePercentage(uint16 _percentage, uint256 _collateralRatio, uint256 _lastCollateralRatio) private view returns (uint16) {
        if (_lastCollateralRatio >= buyingPremiumThreshold * PRECISION_DECIMALS / MAX_PERCENTAGE) {
            return _percentage;
        }

        return uint16(_percentage * (_collateralRatio - buyingPremiumThreshold * PRECISION_DECIMALS / MAX_PERCENTAGE) / (_collateralRatio - _lastCollateralRatio));
    }
}
