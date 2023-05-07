// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./../interfaces/IFeesCollector.sol";

contract ExtractorStaking is IFeesCollector {
    using SafeERC20 for IERC20;

    function sendProfit(uint256 /* _amount */, IERC20 /* _token */) external view override {
    }
}