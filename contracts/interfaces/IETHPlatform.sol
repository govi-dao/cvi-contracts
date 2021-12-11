// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IETHPlatform {
    function depositETH(uint256 minLPTokenAmount) external payable returns (uint256 lpTokenAmount);
    function increaseSharedPoolETH() external payable;
    function openPositionETH(uint16 maxCVI, uint16 maxBuyingPremiumFeePercentage, uint8 leverage) external payable returns (uint168 positionUnitsAmount, uint168 positionedETHAmount);
    function openPositionWithoutVolumeFeeETH(uint16 maxCVI, uint16 maxBuyingPremiumFeePercentage, uint8 leverage) external payable returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount);
    function openPositionWithoutPremiumFeeETH(uint16 maxCVI, uint8 leverage) external payable returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount);
}
