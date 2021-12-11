// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./IMigratablePlatform.sol";
import "./../external/IUniswapV2Router02.sol";

interface IPlatformMigrator {

	event Migration(address indexed account, address indexed oldPlatfrom, address indexed newPlatform, uint256 oldLPTokensAmount, uint256 newLPTokensAmount, uint256 oldTokensAmount, uint256 newTokensAmount, uint256 rewardAmount);

    function migrateLPTokens(uint256 tokenAmountOutMin) external returns (uint256 newLPTokensAmount);

    function setOldPlatform(IMigratablePlatform newOldPlatform) external;
    function setNewPlatform(IMigratablePlatform newNewPlatform) external;
    function setRouter(IUniswapV2Router02 newRouter) external;
    function setRewardAmount(uint256 newRewardAmount) external;
    function withdrawAllRewards() external;
}
