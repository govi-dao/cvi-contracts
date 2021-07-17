// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "../Platform.sol";

contract FakePlatform is Platform {

    constructor(uint168 amount, address account) {
    	Platform.initialize(IERC20Upgradeable(address(0)), "FakeToken", "FakeToken", 0, 20000, IFeesCalculator(address(0)), ICVIOracle(address(0)), ILiquidation(address(0)));
        positions[account] = Position(amount, 1, 5000, uint32(block.timestamp), uint32(block.timestamp));
    }
}
