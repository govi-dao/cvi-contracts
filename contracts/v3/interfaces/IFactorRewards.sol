// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

import "./IPlatformV2.sol";

interface IFactorRewards {
	function claimReward() external;

	function setPlatform(IPlatformV2 newPlatform) external;
	function setDailyReward(uint256 newDailyReward) external;
	function setRewardsFactor(uint256 newRewardsFactor) external;
	function setMaxClaimPeriod(uint256 newMaxClaimPeriod) external;
}
