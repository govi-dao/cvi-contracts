// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "./IVolatilityToken.sol";

interface IRequestFeesCalculator {
    function calculateTimePenaltyFee(IVolatilityToken.Request calldata request) external view returns (uint16 feePercentage);
    function calculateTimeDelayFee(uint256 tokenAmount, uint256 timeDelay) external view returns (uint16 feePercentage);
    function calculateFindersFee(uint256 tokensLeftAmount) external view returns (uint256 findersFeeAmount);

    function isLiquidable(IVolatilityToken.Request calldata request) external view returns (bool liquidable);

    function setTimeWindow(uint32 minTimeWindow, uint32 maxTimeWindow) external;
    function setTimeDelayFeesParameters(uint16 minTimeDelayFeePercent, uint16 maxTimeDelayFeePercent) external;
    function setMinWaitTime(uint32 minWaitTime) external;
    function setTimePenaltyFeeParameters(uint16 minTimePenaltyFeePercent, uint32 midTime, uint16 midTimePenaltyFeePercent, uint32 maxTime, uint16 maxTimePenaltyFeePercent) external;
    function setFindersFee(uint16 findersFeePercent) external;

    function getMaxFees(uint256 tokenAmount) external view returns (uint16 maxFeesPercent);
}
