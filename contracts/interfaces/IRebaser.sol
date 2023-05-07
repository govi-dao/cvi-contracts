// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "../external/IUniswapV2Pair.sol";
import "./IVolatilityToken.sol";

interface IRebaser {
    function rebase() external;
    function setVolatilityToken(IVolatilityToken volatilityToken) external;
    function setUniswapPairs(IUniswapV2Pair[] calldata uniswapPairs) external;
    function setRebaserAddress(address user, bool isAllowed) external;
    function setUpkeepInterval(uint32 upkeepInterval) external;
    function setUpkeepTimeWindow(uint32 upkeepTimeWindow) external;
    function setEnableWhitelist(bool enableWhitelist) external;
}
