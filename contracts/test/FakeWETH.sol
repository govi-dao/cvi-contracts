// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./FakeERC20.sol";
import "../interfaces/IWETH.sol";

contract FakeWETH is FakeERC20, IWETH {
    constructor(string memory name, string memory symbol, uint256 supply, uint8 decimals) FakeERC20(name, symbol, supply, decimals) {
    }

    function deposit() external payable override {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 _amount) external override {
    	payable(msg.sender).transfer(_amount);
    }
}
