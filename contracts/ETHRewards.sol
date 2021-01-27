// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;

import "./Rewards.sol";

contract ETHRewards is Rewards {
    constructor(IERC20 _cviToken) public Rewards(_cviToken) {}
}