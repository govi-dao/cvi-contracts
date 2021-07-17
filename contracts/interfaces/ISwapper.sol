// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISwapper {
	function tokenAdded(IERC20 addedToken) external;
    function tokenRemoved(IERC20 removedToken) external;

    function swapToWETH(IERC20 token, uint256 tokenAmount) external returns (uint256 wethAmount);
}
