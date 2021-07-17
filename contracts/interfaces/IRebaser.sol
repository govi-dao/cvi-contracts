// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "../external/IUniswapV2Pair.sol";
import "./IVolatilityToken.sol";

interface IRebaser {
    function rebase() external;
    
    function setVolatilityToken(IVolatilityToken volatilityToken) external;
    function setUniswapPair(IUniswapV2Pair uniswapPair) external;
}
