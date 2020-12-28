// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "./utils/SafeMath80.sol";
import "./utils/SafeMath16.sol";

import "./interfaces/IFeesCalculator.sol";

contract FeesCalculator is IFeesCalculator, Ownable {

    using SafeMath for uint256;
    using SafeMath16 for uint16;
    using SafeMath80 for uint80;

    uint16 private constant MAX_CVI_VALUE = 20000;
    uint16 private constant CVI_DECIMALS = 100;
    uint256 private constant PRECISION_DECIMALS = 1e10;

    uint256 public constant FUNDING_RATE_MAX = 100000;
    uint256 public constant FUNDING_FEE_BASE_PERIOD = 1 days;

    uint16 public constant FUNDING_FEE_MAX_CVI_MIN = 55;
    uint16 public constant FUNDING_FEE_MIN_CVI_MIN = 110;
    uint16 public constant FUNDING_FEE_DIVISION_FACTOR = 5;

    uint256 public constant FUNDING_FEE_MIN_RATE = 2000;

    uint16 public constant MAX_PERCENTAGE = 10000;
    uint256 public constant MAX_FUNDING_FEE_PERCENTAGE = 1000000;

    uint16 public override depositFeePercent = 0;
    uint16 public override withdrawFeePercent = 0;
    uint16 public override openPositionFeePercent = 30;
    uint16 public override closePositionFeePercent = 30;
    uint16 public buyingPremiumFeeMaxPercent = 1000;
    uint16 public turbulenceStepPercent = 1000;
    uint16 public buyingPremiumThreshold = 8000; // 1.0 is MAX_PERCENTAGE = 10000

    uint256 public oracleHeartbeatPeriod = 1 hours;

    uint16 public turbulenceIndicatorPercent = 0;

    address public turbulenceUpdator;

    //TOOD: test setOracleHeartbeatPeriod, setBuyingPremiumFeeMax, setBuyingPremiumThreshold, setTurbulenceStep

    modifier onlyTurbulenceUpdator {
        require(msg.sender == turbulenceUpdator, "Not allowed");
        _;
    }

    function updateTurbulenceIndicatorPercent(uint256[] memory _periods) external override onlyTurbulenceUpdator returns (uint16) {
        for (uint8 i = 0; i < _periods.length; i++) {
            if (_periods[i] < oracleHeartbeatPeriod) {
                turbulenceIndicatorPercent = turbulenceIndicatorPercent.add(uint16(uint256(buyingPremiumFeeMaxPercent).mul(turbulenceStepPercent).div(MAX_PERCENTAGE)));
                if (turbulenceIndicatorPercent >= buyingPremiumFeeMaxPercent) {
                    turbulenceIndicatorPercent = buyingPremiumFeeMaxPercent;
                }
            } else {
                if (turbulenceIndicatorPercent != 0) {
                    turbulenceIndicatorPercent = turbulenceIndicatorPercent.div(2);
                }
            }
        }
        return turbulenceIndicatorPercent;
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
        closePositionFeePercent = _newClosePositionFeePercentage;
    }

    function setOracleHeartbeatPeriod(uint256 _newOracleHeartbeatPeriod) external override onlyOwner {
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

    function calculateBuyingPremiumFee(uint256 _tokenAmount, uint256 _collateralRatio) external view override returns (uint256 buyingPremiumFee) {
        uint256 buyingPremiumFeePercentage = 0;
        if (_collateralRatio >= PRECISION_DECIMALS) {
            buyingPremiumFeePercentage = buyingPremiumFeeMaxPercent;
        } else {
            if (_collateralRatio >= uint256(buyingPremiumThreshold).mul(PRECISION_DECIMALS).div(MAX_PERCENTAGE)) {
                uint256 denominator = PRECISION_DECIMALS.sub(_collateralRatio);

                // Denominator is multiplied by PRECISION_DECIMALS, but is squared, so need to have a square in numerator as well
                buyingPremiumFeePercentage = (PRECISION_DECIMALS).mul(PRECISION_DECIMALS).
                    div(denominator.mul(denominator));
            }
        }

        uint256 combinedPremiumFeePercentage = buyingPremiumFeePercentage.add(turbulenceIndicatorPercent);
        if (combinedPremiumFeePercentage > buyingPremiumFeeMaxPercent) {
            combinedPremiumFeePercentage = buyingPremiumFeeMaxPercent;
        }
        
        buyingPremiumFee = combinedPremiumFeePercentage.mul(_tokenAmount).div(MAX_PERCENTAGE);
    }

    function calculateSingleUnitFundingFee(CVIValue[] memory _cviValues) external override pure returns (uint256 fundingFee) {
        for (uint8 i = 0; i < _cviValues.length; i++) {
            fundingFee = fundingFee.add(calculateSingleUnitPeriodFundingFee(_cviValues[i]));
        }
    }

    function calculateSingleUnitPeriodFundingFee(CVIValue memory _cviValue) private pure returns (uint256 fundingFee) {
        // Defining as memory to keep function pure and save storage space + reads
        uint24[5] memory fundingFeeCoefficients = [100000, 114869, 131950, 151571, 174110];

        if (_cviValue.cviValue == 0 || _cviValue.period == 0) {
            return 0;
        }

        uint256 fundingFeeRatePercents = FUNDING_RATE_MAX;
        uint16 integerCVIValue = _cviValue.cviValue.div(CVI_DECIMALS);
        if (integerCVIValue > FUNDING_FEE_MAX_CVI_MIN) {
            if (integerCVIValue >= FUNDING_FEE_MIN_CVI_MIN) {
                fundingFeeRatePercents = FUNDING_FEE_MIN_RATE;
            } else {
                fundingFeeRatePercents = PRECISION_DECIMALS
                    .div(uint256(2)**(integerCVIValue.sub(FUNDING_FEE_MAX_CVI_MIN).div(FUNDING_FEE_DIVISION_FACTOR)))
                    .div(fundingFeeCoefficients[(integerCVIValue.sub(FUNDING_FEE_MAX_CVI_MIN)) % FUNDING_FEE_DIVISION_FACTOR])
                    .add(FUNDING_FEE_MIN_RATE);
                
                if (fundingFeeRatePercents > FUNDING_RATE_MAX) {
                    fundingFeeRatePercents = FUNDING_RATE_MAX;
                }
            }
        }

        // Split calculation to prevent stack too deep error
        uint256 multiplication = uint256(_cviValue.cviValue).mul(PRECISION_DECIMALS).mul(fundingFeeRatePercents).mul(_cviValue.period);
        return multiplication.div(FUNDING_FEE_BASE_PERIOD).div(MAX_CVI_VALUE).div(MAX_FUNDING_FEE_PERCENTAGE);
    }
}
