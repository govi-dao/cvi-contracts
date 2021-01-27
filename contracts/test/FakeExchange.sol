// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;

import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

contract FakeExchange {

    using SafeERC20 for IERC20;

    uint256 public exchangeRate;
    IERC20 public token;
    IERC20 public immutable wethToken;

    constructor(IERC20 _wethToken, uint _exchangeRate) public {
        wethToken = _wethToken;
        exchangeRate = _exchangeRate;
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory) {
        require(deadline >= block.timestamp, "Fake Uniswap: Deadline in past");

        uint[] memory amountsOut = getAmountsOut(amountIn, path);
        uint amountOut = amountsOut[0];
        require(amountOut >= amountOutMin, "Fake Uniswap: output below min");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        wethToken.safeTransfer(to, amountOut);

        amountsOut = new uint[](2);
        amountsOut[0] = amountIn;
        amountsOut[1] = amountOut;

        return amountsOut;
    }

    function getAmountsOut(uint amountIn, address[] memory)
        public
        view
        returns (uint[] memory amounts)
    {
        amounts = new uint[](1);
        amounts[0] = amountIn / exchangeRate;
    }

    function WETH() external view returns (address) {
        return address(wethToken);
    }
}