// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8;

import "./../VolatilityToken.sol";

contract VolatilityTokenTest is VolatilityToken {
    function setTotalRequestsAmount(uint256 _amount) external onlyOwner {
        totalRequestsAmount = _amount;
    }
}