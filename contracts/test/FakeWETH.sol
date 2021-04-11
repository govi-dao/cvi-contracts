// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;

import "./FakeERC20.sol";
import "../v1/interfaces/IWETH.sol";

contract FakeWETH is FakeERC20, IWETH {
    constructor(string memory name, string memory symbol, uint256 supply, uint8 decimals) public FakeERC20(name, symbol, supply, decimals) {
    }

    function deposit() external payable override {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 _amount) external override {
    	msg.sender.transfer(_amount);
    }
}
