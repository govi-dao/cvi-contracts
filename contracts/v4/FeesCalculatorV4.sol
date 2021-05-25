// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "../v1/utils/SafeMath80.sol";
import "../v1/utils/SafeMath16.sol";
import "../v3/utils/SafeMath168.sol";

import "./interfaces/IFeesCalculatorV4.sol";

contract FeesCalculatorV4 is IFeesCalculatorV4, Ownable {

    using SafeMath for uint256;
    using SafeMath16 for uint16;
    using SafeMath168 for uint168;

    uint256 private constant PRECISION_DECIMALS = 1e10;

    uint256 private constant FUNDING_FEE_MIN_RATE = 2000;
    uint256 private constant FUNDING_FEE_MAX_RATE = 100000;
    uint256 private constant FUNDING_FEE_BASE_PERIOD = 1 days;
    uint256 private constant FUNDING_FEE_CONSTANT_RATE = 3000;

    uint256 private constant MAX_FUNDING_FEE_PERCENTAGE = 1000000;

    uint16 private constant MAX_CVI_VALUE = 20000;
    uint16 private constant CVI_DECIMALS = 100;

    uint16 private constant MAX_FUNDING_FEE_CVI_THRESHOLD = 55;
    uint16 private constant MIN_FUDNING_FEE_CVI_THRESHOLD = 150;
    uint16 private constant FUNDING_FEE_DIVISION_FACTOR = 5;

    uint16 private constant MAX_PERCENTAGE = 10000;

    uint16 public override depositFeePercent = 0;
    uint16 public override withdrawFeePercent = 0;
    uint16 public override openPositionFeePercent = 30;
    uint16 public override buyingPremiumFeeMaxPercent = 1000;
    uint16 public override closePositionFeePercent = 30;

    uint16 public buyingPremiumThreshold = 8000; // 1.0 is MAX_PERCENTAGE = 10000

    uint16 public closePositionMaxFeePercent = 300;

    uint16 public maxTurbulenceFeePercentToTrim = 100;
    uint16 public turbulenceStepPercent = 1000;
    uint16 public override turbulenceIndicatorPercent = 0;

    uint256 public oracleHeartbeatPeriod = 55 minutes;
    uint256 public closePositionFeeDecayPeriod = 24 hours;

    uint16 public turbulenceDeviationThresholdPercent = 7000; // 1.0 is MAX_PERCENTAGE = 10000
    uint16 public turbulenceDeviationPercentage = 500; // 1.0 is MAX_PERCENTAGE = 10000

    address public turbulenceUpdator;

    modifier onlyTurbulenceUpdator {
        require(msg.sender == turbulenceUpdator, "Not allowed");
        _;
    }

    function updateTurbulenceIndicatorPercent(uint256 _totalTime, uint256 _newRounds, uint16 _lastCVIValue, uint16 _currCVIValue) external override onlyTurbulenceUpdator returns (uint16) {
        uint256 totalHeartbeats = _totalTime / oracleHeartbeatPeriod;
        uint16 updatedTurbulenceIndicatorPercent = calculateTurbulenceIndicatorPercent(totalHeartbeats, _newRounds, _lastCVIValue, _currCVIValue);

        if (updatedTurbulenceIndicatorPercent != turbulenceIndicatorPercent) {
            turbulenceIndicatorPercent = updatedTurbulenceIndicatorPercent;
        }
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

        uint256 deltaCVIAbsPercent = _currCVIValue > _lastCVIValue ? (_currCVIValue - _lastCVIValue).mul(MAX_PERCENTAGE) / _lastCVIValue : (_lastCVIValue - _currCVIValue).mul(MAX_PERCENTAGE) / _lastCVIValue;
        uint256 maxAllowedTurbulenceTimes = (deltaCVIAbsPercent * MAX_PERCENTAGE) / (turbulenceDeviationThresholdPercent * turbulenceDeviationPercentage);

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
            updatedTurbulenceIndicatorPercent = updatedTurbulenceIndicatorPercent.add(uint16(uint256(buyingPremiumFeeMaxPercent).mul(turbulenceStepPercent) / MAX_PERCENTAGE));
        }

        if (updatedTurbulenceIndicatorPercent > buyingPremiumFeeMaxPercent) {
            updatedTurbulenceIndicatorPercent = buyingPremiumFeeMaxPercent;
        }

        return updatedTurbulenceIndicatorPercent;
    }

    function calculateBuyingPremiumFee(uint168 _tokenAmount, uint8 _leverage, uint256 _collateralRatio) external view override returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        (buyingPremiumFee, combinedPremiumFeePercentage) =  _calculateBuyingPremiumFeeWithTurbulence(_tokenAmount, _leverage, _collateralRatio, turbulenceIndicatorPercent);
    }
    
    function calculateBuyingPremiumFeeWithTurbulence(uint168 _tokenAmount, uint8 _leverage, uint256 _collateralRatio, uint16 _turbulenceIndicatorPercent) external view override returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        (buyingPremiumFee, combinedPremiumFeePercentage) = _calculateBuyingPremiumFeeWithTurbulence(_tokenAmount, _leverage, _collateralRatio, _turbulenceIndicatorPercent);
    }

    function calculateSingleUnitFundingFee(CVIValue[] calldata _cviValues) external override pure returns (uint256 fundingFee) {
        for (uint8 i = 0; i < _cviValues.length; i++) {
            fundingFee = fundingFee.add(calculateSingleUnitPeriodFundingFee(_cviValues[i]));
        }
    }

    function calculateSingleUnitPeriodFundingFee(CVIValue memory _cviValue) private pure returns (uint256 fundingFee) {
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
                fundingFeeRatePercents = (PRECISION_DECIMALS / (2 ** exponent) / fundingFeeCoefficients[coefficientIndex]) + 
                    FUNDING_FEE_CONSTANT_RATE;

                if (fundingFeeRatePercents > FUNDING_FEE_MAX_RATE) {
                    fundingFeeRatePercents = FUNDING_FEE_MAX_RATE;
                }
            }
        }

        return PRECISION_DECIMALS.mul(uint256(_cviValue.cviValue)).mul(fundingFeeRatePercents).mul(_cviValue.period) /
            FUNDING_FEE_BASE_PERIOD / MAX_CVI_VALUE / MAX_FUNDING_FEE_PERCENTAGE;
    }

    function calculateClosePositionFeePercent(uint256 creationTimestamp) external view override returns (uint16) {
        if (block.timestamp.sub(creationTimestamp) >= closePositionFeeDecayPeriod) {
            return closePositionFeePercent;
        }

        uint16 decay = uint16(uint256(closePositionMaxFeePercent - closePositionFeePercent).mul(block.timestamp.sub(creationTimestamp)) / 
            closePositionFeeDecayPeriod);
        return closePositionMaxFeePercent.sub(decay);
    }

    function calculateWithdrawFeePercent(uint256) external view override returns (uint16) {
        return withdrawFeePercent;
    }

    function openPositionFees() external view override returns (uint16 openPositionFeePercentResult, uint16 buyingPremiumFeeMaxPercentResult) {
        openPositionFeePercentResult = openPositionFeePercent;
        buyingPremiumFeeMaxPercentResult = buyingPremiumFeeMaxPercent;
    }

    function _calculateBuyingPremiumFeeWithTurbulence(uint168 _tokenAmount, uint8 _leverage, uint256 _collateralRatio, uint16 _turbulenceIndicatorPercent) private view returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage) {
        uint168 buyingPremiumFeePercentage = 0;
        if (_collateralRatio >= PRECISION_DECIMALS) {
            buyingPremiumFeePercentage = buyingPremiumFeeMaxPercent;
        } else {
            if (_collateralRatio >= uint256(buyingPremiumThreshold).mul(PRECISION_DECIMALS) / MAX_PERCENTAGE) {
                // NOTE: The collateral ratio can never be bigger than 1.0 (= PERCISION_DECIMALS) in calls from the platform,
                // so there is no issue with having a revert always occuring here on specific scenarios
                uint168 denominator = uint168(PRECISION_DECIMALS).sub(uint168(_collateralRatio));

                // Denominator is multiplied by PRECISION_DECIMALS, but is squared, so need to have a square in numerator as well
                buyingPremiumFeePercentage = uint168(PRECISION_DECIMALS * PRECISION_DECIMALS).
                    div(denominator.mul(denominator));
            }
        }

        combinedPremiumFeePercentage = uint16(buyingPremiumFeePercentage).add(_turbulenceIndicatorPercent);
        if (combinedPremiumFeePercentage > buyingPremiumFeeMaxPercent) {
            combinedPremiumFeePercentage = buyingPremiumFeeMaxPercent;
        }
        
        uint256 __buyingPremiumFee = uint256(_tokenAmount.mul(_leverage)).mul(combinedPremiumFeePercentage) / MAX_PERCENTAGE;
        buyingPremiumFee = uint168(__buyingPremiumFee);
        require(__buyingPremiumFee == buyingPremiumFee, "Too much tokens");
    }
}
