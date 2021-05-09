// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "../v1/Platform.sol";

contract FakePlatform is Platform {

    constructor(uint256 amount, address account) Platform(IERC20(address(0)), "FakeToken", "FakeToken", 0, IFeesModel(address(0)), IFeesCalculator(address(0)), ICVIOracle(address(0)), ILiquidation(address(0))) {
        positions[account] = Position(amount, block.timestamp, 0, 0);
    }
}
