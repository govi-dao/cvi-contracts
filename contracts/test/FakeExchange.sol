// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FakeExchange {

    using SafeERC20 for IERC20;

    uint168 public constant EXCHANGE_RATE_DECIMALS = 10000;
    uint16 public constant MAX_PERCENTAGE = 10000;

    uint256 public exchangeRate;
    uint16 public slippagePercent = 10000;

    IERC20 public token;
    IERC20 public immutable wethToken;

    constructor(IERC20 _wethToken, uint _exchangeRate) {
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

        uint amountOut = amountsOut[1] * slippagePercent / MAX_PERCENTAGE;

        require(amountOut >= amountOutMin, "Fake Uniswap: output below min");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, amountOut);

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
        amounts = new uint[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * exchangeRate / EXCHANGE_RATE_DECIMALS;
    }

    function getAmountsIn(uint amountOut, address[] memory) public view returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountOut * EXCHANGE_RATE_DECIMALS / exchangeRate;
        amounts[1] = amountOut;
    }

    function setSlippagePercent(uint16 _slippagePercent) external {
        slippagePercent = _slippagePercent;
    }

    function WETH() external view returns (address) {
        return address(wethToken);
    }
}