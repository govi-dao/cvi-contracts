// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../v1/interfaces/IFeesCollector.sol";

contract FakeFeesCollector is IFeesCollector {
    using SafeERC20 for IERC20;

    uint256 public totalFeesCollected = 0;

    receive() external payable {

    }

    function sendProfit(uint256 amount, IERC20 token) external override {
        totalFeesCollected += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function getProfit() external view returns (uint256) {
        return totalFeesCollected;
    }
}