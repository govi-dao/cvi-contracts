// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IRebaser.sol";

contract Rebaser is IRebaser, Ownable {
    IVolatilityToken private volatilityToken;
    IUniswapV2Pair private pair;

    constructor(IVolatilityToken _volatilityToken, IUniswapV2Pair _uniswapPair) {
        volatilityToken = _volatilityToken;
        pair = _uniswapPair;
    }

    function rebase() external override onlyOwner {
        require(address(volatilityToken) != address(0), "Rebaser: set volatility token");
        volatilityToken.rebaseCVI();
        if (address(pair) != address(0)) {
            pair.sync();
        }
    }

    function setVolatilityToken(IVolatilityToken _volatilityToken) external override onlyOwner {
        volatilityToken = _volatilityToken;
    }

    function setUniswapPair(IUniswapV2Pair _uniswapPair) external override onlyOwner {
        pair = _uniswapPair;
    }
}
