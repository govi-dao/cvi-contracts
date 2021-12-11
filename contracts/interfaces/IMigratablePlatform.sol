// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMigratablePlatform {
    function deposit(uint256 tokenAmount, uint256 minLPTokenAmount) external returns (uint256 lpTokenAmount);
    function withdrawLPTokens(uint256 _lpTokensAmount) external returns (uint256 burntAmount, uint256 withdrawnAmount);

    function token() external returns (IERC20);
}