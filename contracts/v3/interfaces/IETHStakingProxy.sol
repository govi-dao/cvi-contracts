// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../v1/interfaces/IFeesCollector.sol";

interface IETHStakingProxy {
    receive() external payable;

    function convertETHFunds() external;
    function setFeesCollector(IFeesCollector feesCollector) external;
}
