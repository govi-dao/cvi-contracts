// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

contract FakeFactory {
    address tokenA;
    address tokenB;
    address pair;

    constructor(address _pair, address _tokenA, address _tokenB) {
        pair = _pair;
        tokenA = _tokenA;
        tokenB = _tokenB;
    }

    function getPair(address _tokenA, address _tokenB) external view returns (address) {
        require(tokenA == _tokenA && tokenB == _tokenB, "Not supported");
        return pair;
    }
}