// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IPlatform.sol";
import "./interfaces/IETHPlatform.sol";
import "./interfaces/IWETH.sol";
import "./Platform.sol";


contract ETHPlatform is Platform, IETHPlatform {

    address public constant WETH = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

    constructor(string memory _lpTokenName, string memory _lpTokenSymbolName, 
        IFeesModel _feesModel, 
        IFeesCollector _feesCollector,
        IFeesCalculator _feesCalculator,
        IRewards _rewards,
        ICVIOracle _cviOracle,
        ILiquidation _liquidation) public Platform(IERC20(WETH), _lpTokenName, _lpTokenSymbolName, _feesModel, _feesCalculator, _cviOracle, _liquidation) {
    }

    function depositETH(uint256 _minLPTokenAmount) external override payable returns (uint256 lpTokenAmount) {
        IWETH(WETH).deposit{value: msg.value}();
        lpTokenAmount = _deposit(msg.value, _minLPTokenAmount, false);
    }

    function withdrawETH(uint256 _lpTokensAmount, uint256 _maxLPTokenBurnAmount) external override returns (uint256 burntAmount, uint256 withdrawnAmount) {
    	(burntAmount, withdrawnAmount) = _withdraw(_lpTokensAmount, _maxLPTokenBurnAmount, false);
        IWETH(WETH).withdraw(withdrawnAmount);
        msg.sender.transfer(withdrawnAmount);
    }

    function withdrawLPTokensETH(uint256 _lpTokensAmount) external override returns (uint256 burntAmount, uint256 withdrawnAmount) {
    	(burntAmount, withdrawnAmount) = _withdrawLPTokens(_lpTokensAmount, false);
    	sendETH(withdrawnAmount);
    }

    function openPositionETH(uint16 _maxCVI) external override payable returns (uint256 positionUnitsAmount) {
        IWETH(WETH).deposit{value: msg.value}();
        positionUnitsAmount = _openPosition(msg.value, _maxCVI, false);
    }

    function closePositionETH(uint256 _positionUnitsAmount, uint16 _minCVI) external override returns (uint256 tokenAmount) {
        tokenAmount = _closePosition(_positionUnitsAmount, _minCVI, false);
        sendETH(tokenAmount);
    }

    function sendETH(uint256 _amount) private {
    	IWETH(WETH).withdraw(_amount);
        msg.sender.transfer(_amount);
    }
}
