// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;

interface IETHVolatilityToken {
    function submitMintRequestETH(uint168 tokenAmount, uint32 timeDelay) external payable returns (uint256 requestId);
    function submitCollateralizedMintRequestETH(uint168 tokenAmount, uint32 timeDelay) external payable returns (uint256 requestId);

    function fulfillMintRequestETH(uint256 requestId) external payable returns (uint256 tokensMinted);
    function fulfillCollateralizedMintRequestETH(uint256 requestId) external payable returns (uint256 tokensMinted, uint256 shortTokensMinted);
}
