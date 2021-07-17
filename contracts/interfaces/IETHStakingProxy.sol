// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IFeesCollector.sol";

interface IETHStakingProxy {
    receive() external payable;

    function convertETHFunds() external;
    function setFeesCollector(IFeesCollector feesCollector) external;
}
