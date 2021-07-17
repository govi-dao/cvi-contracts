// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;


import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IETHStakingProxy.sol";
import "./interfaces/IWETH.sol";

contract ETHStakingProxy is IETHStakingProxy, Ownable {

    using SafeERC20 for IERC20;

    IFeesCollector private feesCollector;
    IWETH private immutable wethToken;

    constructor(IWETH _wethToken, IFeesCollector _feesCollector) {
        feesCollector = _feesCollector;
        wethToken = _wethToken;

        if (address(_feesCollector) != address(0)) {
            IERC20(address(_wethToken)).safeApprove(address(feesCollector), type(uint256).max);
        }
    }

    receive() external payable override {

    }

    function convertETHFunds() external override {
        uint256 amount = address(this).balance;
        require(amount > 0, "No ETH funds to convert");

        wethToken.deposit{ value: amount }();
        feesCollector.sendProfit(amount, IERC20(address(wethToken)));
    }

    function setFeesCollector(IFeesCollector _feesCollector) external override onlyOwner {
        if (address(feesCollector) != address(0)) {
            IERC20(address(wethToken)).safeApprove(address(feesCollector), 0);
        }

        feesCollector = _feesCollector;

        if (address(feesCollector) != address(0)) {
            IERC20(address(wethToken)).safeApprove(address(feesCollector), type(uint256).max);
        }
    }
}