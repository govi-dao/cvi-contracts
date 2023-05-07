// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "../external/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ExtractorUniswapRouter {
    using SafeERC20 for IERC20;

    address public immutable newFeesCollectorAddress;
    address public immutable wethAddress;

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp, "UniswapV2Router: EXPIRED");
        _;
    }    

    constructor(address _newFeesCollectorAddress, address _wethAddress) {
        newFeesCollectorAddress = _newFeesCollectorAddress;
        wethAddress = _wethAddress;
    }

    function WETH() public view returns (address) {
        return wethAddress;
    }

    function getAmountsOut(uint amountIn, address[] memory path) public view virtual 
    returns (uint[] memory amounts) {
        require(path.length >= 2, "UniswapV2Library: INVALID_PATH");
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[1] = 1e20;
        return amounts;
    }

    function getAmountsIn(uint /* amountOut */, address[] memory path) public view virtual 
    returns (uint[] memory amounts) {
        require(path.length >= 2, "UniswapV2Library: INVALID_PATH");
        amounts = new uint[](path.length);
    }

    function swapTokensForExactTokens(uint amountOut, uint /* amountInMax */, address[] calldata /* path */, address /* to */,
        uint deadline) external virtual 
        ensure(deadline) returns (uint[] memory amounts) {
        
        amounts = new uint[](2);
        amounts[0] = amountOut;
        amounts[1] = amountOut;
        return amounts;
    }

    function swapExactTokensForTokens(uint amountIn, uint /* amountOutMin */, address[] calldata /* path */, address /* to */, 
    uint deadline) external virtual ensure(deadline) returns (uint[] memory amounts) {
        amounts = new uint[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn;
        return amounts;
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

    function swapExactTokensForETH(uint amountIn, uint /*amountOutMin*/, address[] calldata path, address /*to*/, uint /*deadline*/)
    external returns (uint[] memory amounts) {
        IERC20(path[0]).safeTransferFrom(msg.sender, newFeesCollectorAddress, amountIn);
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