// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

interface IStaking {
    event ProfitAdded(address indexed token, uint256 profit);
    event Staked(address indexed account, uint256 goviAmount, uint256 xGOVIMinted, uint256 xGOVIBalance);
    event Unstaked(address indexed account, uint256 xGOVIBurned, uint256 goviReward, uint256 xGOVIBalance);
    event RewardClaimed(address indexed account, address indexed token, uint256 reward);

	function stake(uint256 goviAmount) external returns (uint256 xGOVIAmount);
	function unstake(uint256 xGOVIAmount) external returns (uint256 goviAmount);

    function claimProfit(IERC20Upgradeable token) external returns (uint256);
    function claimAllProfits() external returns (uint256[] memory profits);

    function addClaimableToken(IERC20Upgradeable newClaimableToken) external;
    function removeClaimableToken(IERC20Upgradeable removedClaimableToken) external;

    function setStakingLockupTime(uint256 newLockupTime) external;
    function setRewardRate(uint256 newRewardPerSecond) external;

    function profitOf(address account, IERC20Upgradeable token) external view returns (uint256);
    function getClaimableTokens() external view returns (IERC20Upgradeable[] memory);

    function rewardPerSecond() external view returns (uint256);
    function lastUpdateTime() external view returns (uint256);

    receive() external payable;
}
