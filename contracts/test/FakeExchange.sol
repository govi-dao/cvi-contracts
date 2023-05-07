// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./../interfaces/IWETH.sol";

contract FakeExchange {

    using SafeERC20 for IERC20;

    uint168 public constant EXCHANGE_RATE_DECIMALS = 10000;
    uint16 public constant MAX_PERCENTAGE = 10000;

    mapping(address => uint256) public exchangeRates;
    mapping(address => uint16) public slippagePercents;

    IERC20 public token;
    IERC20 public wethToken;

    constructor(IERC20 _wethToken) {
        wethToken = _wethToken;

        if (address(wethToken) != address(0)) {
            wethToken.safeApprove(address(wethToken), type(uint256).max);
        }
    }

    receive() external payable {

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

        uint amountOut = amountsOut[1];
        require(amountOut >= amountOutMin, "Fake Uniswap: output below min");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, amountOut);

        amountsOut = new uint[](2);
        amountsOut[0] = amountIn;
        amountsOut[1] = amountOut;

        return amountsOut;
    }

    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(deadline >= block.timestamp, "Fake Uniswap: Deadline in past");

        uint[] memory amountsOut = getAmountsOut(amountIn, path);

        uint amountOut = amountsOut[1];
        require(amountOut >= amountOutMin, "Fake Uniswap: output below min");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IWETH(address(wethToken)).withdraw(amountOut);
        payable(to).transfer(amountOut);

        amountsOut = new uint[](2);
        amountsOut[0] = amountIn;
        amountsOut[1] = amountOut;

        return amountsOut;
    }

    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline)
    external payable returns (uint[] memory amount) {
        require(deadline >= block.timestamp, "Fake Uniswap: Deadline in past");

        uint[] memory amountsOut = getAmountsOut(msg.value, path);

        uint amountOut = amountsOut[1];
        require(amountOut >= amountOutMin, "Fake Uniswap: output below min");

        IERC20(path[1]).safeTransfer(to, amountOut);

        amountsOut = new uint[](2);
        amountsOut[0] = msg.value;
        amountsOut[1] = amountOut;

        return amountsOut;
    }

    function getAmountsOut(uint amountIn, address[] memory path)
        public
        view
        returns (uint[] memory amounts)
    {
        amounts = new uint[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * (MAX_PERCENTAGE - slippagePercents[path[1]]) * exchangeRates[path[1]] / EXCHANGE_RATE_DECIMALS / MAX_PERCENTAGE;
    }

    function getAmountsIn(uint amountOut, address[] memory path) public view returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountOut * EXCHANGE_RATE_DECIMALS * MAX_PERCENTAGE / exchangeRates[path[1]] / (MAX_PERCENTAGE - slippagePercents[path[1]]);
        amounts[1] = amountOut;
    }

    function setSlippagePercent(uint16 _slippagePercent, IERC20 _destToken) external {
        slippagePercents[address(_destToken)] = _slippagePercent;
    }

    function setExchangeRate(uint256 _exchangeRate, IERC20 _destToken) external {
        exchangeRates[address(_destToken)] = _exchangeRate;
    }

    function WETH() external view returns (address) {
        return address(wethToken);
    }
}