// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IETHVolatilityToken {
    function submitMintRequestETH(uint168 tokenAmount, uint32 timeDelay) external payable returns (uint256 requestId);

    function fulfillMintRequestETH(uint256 requestId, uint16 maxBuyingPremiumFeePercentage) external payable returns (uint256 tokensMinted);
    function fulfillCollateralizedMintRequestETH(uint256 requestId) external payable returns (uint256 tokensMinted, uint256 shortTokensMinted);
}
