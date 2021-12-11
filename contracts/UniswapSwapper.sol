// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./external/IUniswapV2Router02.sol";
import "./interfaces/IUniswapSwapper.sol";
import "./interfaces/ISwapper.sol";
import "./interfaces/IWETH.sol";

contract UniswapSwapper is IUniswapSwapper, ISwapper, Ownable {

    using SafeERC20 for IERC20;

    IERC20 private wethToken;
    IUniswapV2Router02 private uniswapRouter;

    uint256 private maxSwapETHAmount = 1 ether;
    address private stakingAddress;

    modifier onlyStaking {
        require(msg.sender == stakingAddress, "Not allowed");
        _;
    }

    constructor(IUniswapV2Router02 _uniswapRouter) {
    	uniswapRouter = _uniswapRouter;
    	wethToken = IERC20(_uniswapRouter.WETH());
    }

    function tokenAdded(IERC20 _addedToken) external override onlyStaking {
        _addedToken.safeApprove(address(uniswapRouter), type(uint256).max);
    }

    function tokenRemoved(IERC20 _removedToken) external override onlyStaking {
        _removedToken.safeApprove(address(uniswapRouter), 0);
    }

    function setMaxSwapETHAmount(uint256 _newMaxAmount) external override onlyOwner {
        require(_newMaxAmount > 0, "Max amount must be positive");
        maxSwapETHAmount = _newMaxAmount;
    }

    function swapToWETH(IERC20 _token, uint256 _tokenAmount) external override onlyStaking returns (uint256 wethAmount) {
        address[] memory path = new address[](2);
        path[0] = address(_token);
        path[1] = address(wethToken);

        uint[] memory _tokenAmountsOut = uniswapRouter.getAmountsOut(_tokenAmount, path);
        uint _tokenAmountWeth = _tokenAmountsOut[1];
        
        uint256 _tokenAmountToSwap = _tokenAmount;

        if (_tokenAmountWeth > maxSwapETHAmount) {
            uint[] memory _tokenAmountsIn = uniswapRouter.getAmountsIn(maxSwapETHAmount, path);
            _tokenAmountToSwap = _tokenAmountsIn[0];
        }
        
        _token.safeTransferFrom(msg.sender, address(this), _tokenAmountToSwap);

        uint256[] memory amounts = 
            uniswapRouter.swapExactTokensForTokens(_tokenAmountToSwap, 
                0, path, address(this), block.timestamp);

        wethAmount = amounts[1];
        wethToken.safeTransfer(msg.sender, wethAmount);
    }

    function setStakingAddress(address _newStakingAddress) external override onlyOwner {
        stakingAddress = _newStakingAddress;
    }
}
