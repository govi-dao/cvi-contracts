// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "../external/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FakeUniswapRouter {
    using SafeERC20 for IERC20;
    uint256 private conversionRatio = 400;

    IERC20 public token;
    IERC20 public immutable wethToken;

    address private immutable WETH;

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp, "UniswapV2Router: EXPIRED");
        _;
    }    

    constructor(IERC20 _wethToken, address _WETH, uint _conversionRatio) {
        wethToken = _wethToken;
        conversionRatio = _conversionRatio;
        WETH = _WETH;
    }

    function setRatio(uint256 _conversionRatio) external {
        conversionRatio = _conversionRatio;
    }

    function getAmountsOut(uint amountIn, address[] memory path) public view virtual 
    returns (uint[] memory amounts) {
        require(path.length >= 2, "UniswapV2Library: INVALID_PATH");
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        for (uint i; i < path.length - 1; i++) {
            amounts[i + 1] = amounts[i] * conversionRatio / 1000;
        }
    }

    function getAmountsIn(uint amountOut, address[] memory path) public view virtual 
    returns (uint[] memory amounts) {
        require(path.length >= 2, "UniswapV2Library: INVALID_PATH");
        amounts = new uint[](path.length);
        amounts[amounts.length - 1] = amountOut;
        
        for (uint i = path.length - 1; i > 0; i--) {
            amounts[i - 1] = amounts[i] * 1000 / conversionRatio;
        }
    }

    function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to,
        uint deadline) external virtual 
        ensure(deadline) returns (uint[] memory amounts) {
        
        uint[] memory amountsIn = getAmountsIn(amountOut, path);
        uint amountIn = amountsIn[0];
        require(amountIn <= amountInMax, "Fake Uniswap: excessive input amount");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountOut);
        wethToken.safeTransfer(to, amountIn);

        amountsIn = new uint[](2);
        amountsIn[0] = amountIn;
        amountsIn[1] = amountOut;

        return amountsIn;
    }

    function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, 
    uint deadline) external virtual ensure(deadline) returns (uint[] memory amounts) {
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

    // Implementations for IUniswapV2Router02 required functionality
    
    function getAmountOut(uint amountIn, uint /*reserveIn*/, uint /*reserveOut*/) public pure virtual
    returns (uint amountOut) {
        return amountIn;
    }

    function getAmountIn(uint amountOut, uint /*reserveIn*/, uint /*reserveOut*/) public pure virtual 
    returns (uint amountIn) {
        return amountOut;
    }

    function factory() external pure returns (address) {
        return address(0);
    }

    function addLiquidity(address /*tokenA*/, address /*tokenB*/, uint amountADesired, uint amountBDesired, uint /*amountAMin*/, 
    uint /*amountBMin*/, address /*to*/, uint /*deadline*/ ) external pure returns (uint amountA, uint amountB, uint liquidity) {
        (amountA, amountB, liquidity) = (amountADesired, amountBDesired, 1);
    }

    function addLiquidityETH(address /*token*/, uint amountTokenDesired, uint /*amountTokenMin*/, uint amountETHMin, address /*to*/,
    uint /*deadline*/ ) external payable returns (uint amountToken, uint amountETH, uint liquidity) {
        (amountToken, amountETH, liquidity) = (amountTokenDesired, amountETHMin, 1);
    }

    function removeLiquidity(address /*tokenA*/, address /*tokenB*/, uint /*liquidity*/, uint amountAMin, uint amountBMin, address /*to*/, 
    uint /*deadline*/) external pure returns (uint amountA, uint amountB) {
        (amountA, amountB) = (amountAMin, amountBMin);
    }

    function removeLiquidityETH(address /*token*/, uint /*liquidity*/, uint amountTokenMin, uint amountETHMin, address /*to*/, 
    uint /*deadline*/) external pure returns (uint amountToken, uint amountETH) {
        (amountToken, amountETH) = (amountTokenMin, amountETHMin);
    }

    function removeLiquidityWithPermit(address /*tokenA*/, address /*tokenB*/, uint /*liquidity*/, uint amountAMin, uint amountBMin,
    address /*to*/, uint /*deadline*/, bool /*approveMax*/, uint8 /*v*/, bytes32 /*r*/, bytes32 /*s*/) external pure returns (uint amountA, uint amountB) {
        (amountA, amountB) = (amountAMin, amountBMin);
    }

    function removeLiquidityETHWithPermit(address /*token*/, uint /*liquidity*/, uint amountTokenMin, uint amountETHMin, address /*to*/,
    uint /*deadline*/, bool /*approveMax*/, uint8 /*v*/, bytes32 /*r*/, bytes32 /*s*/) external pure returns (uint amountToken, uint amountETH) {
        (amountToken, amountETH) = (amountTokenMin, amountETHMin);
    }

    function swapExactETHForTokens(uint amountOutMin, address[] calldata /*path*/, address /*to*/, uint /*deadline*/)
    external payable returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountOutMin;
        amounts[1] = amountOutMin;
        return amounts;
    }
    
    function swapTokensForExactETH(uint amountOut, uint /*amountInMax*/, address[] calldata /*path*/, address /*to*/, uint /*deadline*/) 
    external pure returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountOut;
        amounts[1] = amountOut;
        return amounts;
    }

    function swapExactTokensForETH(uint amountIn, uint /*amountOutMin*/, address[] calldata /*path*/, address /*to*/, uint /*deadline*/)
    external pure returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn;
        return amounts;
    }

    function swapETHForExactTokens(uint amountOut, address[] calldata /*path*/, address /*to*/, uint /*deadline*/)
    external payable returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountOut;
        amounts[1] = amountOut;
        return amounts;
    }

    function removeLiquidityETHSupportingFeeOnTransferTokens(address /*token*/, uint /*liquidity*/, uint /*amountTokenMin*/,
        uint amountETHMin, address /*to*/, uint /*deadline*/) external pure returns (uint amountETH){
            return amountETHMin;
        }

    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(address /*token*/, uint /*liquidity*/, uint /*amountTokenMin*/,
        uint amountETHMin, address /*to*/, uint /*deadline*/, bool /*approveMax*/, uint8 /*v*/, bytes32 /*r*/, bytes32 /*s*/) external pure returns (uint amountETH){
            return amountETHMin;
        }

    function quote(uint amountA, uint /*reserveA*/, uint /*reserveB*/) public pure virtual returns (uint amountB) {
        return amountA;
    }
}