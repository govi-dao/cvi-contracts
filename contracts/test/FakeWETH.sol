// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./FakeERC20.sol";
import "../interfaces/IWETH.sol";

contract FakeWETH is FakeERC20, IWETH {

	using SafeERC20 for IERC20;

    constructor(string memory name, string memory symbol, uint256 supply, uint8 decimals) FakeERC20(name, symbol, supply, decimals) {
    }

    receive() external payable {

    }

    function deposit() external payable override {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 _amount) external override {
        _burn(msg.sender, _amount);
    	payable(msg.sender).transfer(_amount);
    }
}
