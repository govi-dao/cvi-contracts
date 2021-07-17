// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FakeERC20 is ERC20 {
	uint8 __decimals;

    constructor(string memory _name, string memory _symbol, uint256 _supply, uint8 _decimals) ERC20(_name, _symbol) {
    	__decimals = _decimals;
        _mint(msg.sender, _supply);
    }

    function decimals() public view override returns (uint8) {
        return __decimals;
    }
}
