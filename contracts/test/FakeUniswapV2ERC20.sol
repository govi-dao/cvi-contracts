// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./IUniswapV2ERC20.sol";

contract FakeUniswapV2ERC20 is ERC20, IUniswapV2Pair {
    constructor(string memory name, string memory symbol, uint256 supply, uint8 decimals) public ERC20(name, symbol) {
        _mint(msg.sender, supply);
        _setupDecimals(decimals);
    }

    function getReserves() external override view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        return (0,0,0);
    }
}
