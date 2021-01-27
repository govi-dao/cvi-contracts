// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;

interface IETHPlatform {
    function depositETH(uint256 minLPTokenAmount) external payable returns (uint256 lpTokenAmount);
    function withdrawETH(uint256 tokenAmount, uint256 maxLPTokenBurnAmount) external returns (uint256 burntAmount, uint256 withdrawnAmount);
    function withdrawLPTokensETH(uint256 lpTokensAmount) external returns (uint256 burntAmount, uint256 withdrawnAmount);
    function openPositionETH(uint16 maxCVI) external payable returns (uint256 positionUnitsAmount);
    function closePositionETH(uint256 positionUnitsAmount, uint16 minCVI) external returns (uint256 tokenAmount);

    receive() external payable;
}
