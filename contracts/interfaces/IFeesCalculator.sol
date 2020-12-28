// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

interface IFeesCalculator {

    struct CVIValue {
        uint256 period;
        uint16 cviValue;
    }

    function updateTurbulenceIndicatorPercent(uint256[] memory periods) external returns (uint16);

    function setTurbulenceUpdator(address newUpdator) external;

    function setDepositFee(uint16 newDepositFeePercentage) external;
    function setWithdrawFee(uint16 newWithdrawFeePercentage) external;
    function setOpenPositionFee(uint16 newOpenPositionFeePercentage) external;
    function setClosePositionFee(uint16 newClosePositionFeePercentage) external;
    
    function setOracleHeartbeatPeriod(uint256 newOracleHeartbeatPeriod) external;
    function setBuyingPremiumFeeMax(uint16 newBuyingPremiumFeeMaxPercentage) external;
    function setBuyingPremiumThreshold(uint16 newBuyingPremiumThreshold) external;
    function setTurbulenceStep(uint16 newTurbulenceStepPercentage) external;

    function calculateBuyingPremiumFee(uint256 tokenAmount, uint256 collateralRatio) external view returns (uint256 buyingPremiumFee);
    function calculateSingleUnitFundingFee(CVIValue[] memory cviValues) external pure returns (uint256 fundingFee);

    function depositFeePercent() external returns (uint16);
    function withdrawFeePercent() external returns (uint16);
    function openPositionFeePercent() external returns (uint16);
    function closePositionFeePercent() external returns (uint16);
}
