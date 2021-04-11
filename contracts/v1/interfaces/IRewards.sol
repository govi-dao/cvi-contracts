// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

interface IRewards {
	function reward(address account, uint256 positionUnits) external;
	function claimReward(uint256[] memory openPositionDays) external;

	function setRewarder(address newRewarder) external;
	function setDailyReward(uint256 newDailyReward) external;
}
