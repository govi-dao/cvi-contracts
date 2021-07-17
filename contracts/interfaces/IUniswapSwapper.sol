// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IUniswapSwapper {
    
    function setStakingAddress(address newStakingAddress) external;
    function setMaxSwapETHAmount(uint256 maxAmount) external;
}
