// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;

interface IETHPlatformV2 {
    function depositETH(uint256 minLPTokenAmount) external payable returns (uint256 lpTokenAmount);
    function increaseSharedPoolETH(uint256 tokenAmount) external payable;
    function openPositionETH(uint16 maxCVI, uint168 maxBuyingPremiumFeePercentage, uint8 leverage) external payable returns (uint168 positionUnitsAmount, uint168 positionedETHAmount);
    function openPositionWithoutPremiumFeeETH(uint16 maxCVI, uint168 maxBuyingPremiumFeePercentage, uint8 leverage) external payable returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount);
}
