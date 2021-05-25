// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

interface IUniswapSwapper {
    
    function setStakingAddress(address newStakingAddress) external;
    function setMaxSwapETHAmount(uint256 _maxAmount) external;

}
