// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IPlatformMigrator.sol";

contract PlatformMigrator is IPlatformMigrator, Ownable {

    using SafeERC20 for IERC20;

    IERC20 public rewardToken;
    IERC20 public oldToken;
    IMigratablePlatform public oldPlatform;
    IMigratablePlatform public newPlatform;
    IUniswapV2Router02 public router;

    uint256 public rewardAmount = 1e20;

    constructor(IERC20 _rewardToken, IERC20 _oldToken, IMigratablePlatform _oldPlatform, IMigratablePlatform _newPlatform, IUniswapV2Router02 _router) {
        rewardToken = _rewardToken;
        oldToken = _oldToken;
        oldPlatform = _oldPlatform;
        newPlatform = _newPlatform;
        router = _router;
    }

    function migrateLPTokens(uint256 _tokenAmountOutMin) external override returns (uint256 newLPTokensAmount) {
        uint256 oldLPTokensAmount = IERC20(address(oldPlatform)).balanceOf(msg.sender);

        require(oldLPTokensAmount > 0, "No LP tokens to migrate");

        IERC20(address(oldPlatform)).safeTransferFrom(msg.sender, address(this), oldLPTokensAmount);
        IERC20(address(oldPlatform)).safeApprove(address(oldPlatform), 0);
        IERC20(address(oldPlatform)).safeApprove(address(oldPlatform), oldLPTokensAmount);
        (, uint256 oldTokensAmount) = oldPlatform.withdrawLPTokens(oldLPTokensAmount);
        IERC20 newToken = newPlatform.token();
        uint256 newTokensAmount = oldTokensAmount;
        if (address(oldToken) != address(newToken)) {
            address[] memory path = new address[](2);
            path[0] = address(oldToken);
            path[1] = address(newToken);

            oldToken.safeApprove(address(router), 0);
            oldToken.safeApprove(address(router), oldTokensAmount);
            uint[] memory amounts = router.swapExactTokensForTokens(oldTokensAmount, _tokenAmountOutMin, path, address(this), block.timestamp);
            newTokensAmount = amounts[1];
        }

        newToken.safeApprove(address(newPlatform), newTokensAmount);
        newLPTokensAmount = newPlatform.deposit(newTokensAmount, 0);
        IERC20(address(newPlatform)).safeTransfer(msg.sender, newLPTokensAmount);
        rewardToken.safeTransfer(msg.sender, rewardAmount);
        emit Migration(msg.sender, address(oldPlatform), address(newPlatform), oldLPTokensAmount, newLPTokensAmount, oldTokensAmount, newTokensAmount, rewardAmount);
    }

    function setOldPlatform(IMigratablePlatform _newOldPlatform) external override onlyOwner {
        oldPlatform = _newOldPlatform;
    }

    function setNewPlatform(IMigratablePlatform _newNewPlatform) external override onlyOwner {
        newPlatform = _newNewPlatform;
    }

    function setRouter(IUniswapV2Router02 _newRouter) external override onlyOwner {
        router = _newRouter;
    }

    function setRewardAmount(uint256 _newRewardAmount) external override onlyOwner {
        rewardAmount = _newRewardAmount;
    }

    function withdrawAllRewards() external override onlyOwner {
        uint256 balance = rewardToken.balanceOf(address(this));
        rewardToken.safeTransfer(msg.sender, balance);
    }
}