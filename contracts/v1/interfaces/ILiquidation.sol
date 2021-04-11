// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

interface ILiquidation {	
	function setMinLiquidationThreshold(uint16 newMinThreshold) external;
    function setMinLiquidationReward(uint16 newMaxRewardAmount) external;
    function setMaxLiquidationReward(uint16 newMaxRewardAmount) external;

	function isLiquidationCandidate(uint256 positionBalance, bool isPositive, uint256 positionUnitsAmount) external view returns (bool);

	function getLiquidationReward(uint256 positionBalance, bool isPositive, uint256 positionUnitsAmount) external view returns (uint256 finderFeeAmount);
}
