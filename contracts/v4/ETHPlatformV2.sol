// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IETHPlatformV2.sol";
import "./PlatformV3.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ETHPlatformV2 is PlatformV3, IETHPlatformV2 {

    using SafeMath for uint256;

    constructor(string memory _lpTokenName, string memory _lpTokenSymbolName, uint256 _initialTokenToLPTokenRate,
        IFeesCalculatorV4 _feesCalculator,
        ICVIOracleV3 _cviOracle,
        ILiquidationV2 _liquidation) PlatformV3(IERC20(address(0)), _lpTokenName, _lpTokenSymbolName, _initialTokenToLPTokenRate, _feesCalculator, _cviOracle, _liquidation) {
    }

    function depositETH(uint256 _minLPTokenAmount) external override payable nonReentrant returns (uint256 lpTokenAmount) {
        lpTokenAmount = _deposit(msg.value, _minLPTokenAmount);
    }

    function increaseSharedPoolETH(uint256 tokenAmount) external override payable nonReentrant {
        _increaseSharedPool(msg.value);
    }

    function openPositionETH(uint16 _maxCVI, uint168 _maxBuyingPremiumFeePercentage, uint8 _leverage) external override payable nonReentrant returns (uint168 positionUnitsAmount, uint168 positionedETHAmount) {
        require(uint168(msg.value) == msg.value, "Too much ETH");
        return _openPosition(uint168(msg.value), _maxCVI, _maxBuyingPremiumFeePercentage, _leverage, true);
    }

    function openPositionWithoutPremiumFeeETH(uint16 _maxCVI, uint168 _maxBuyingPremiumFeePercentage, uint8 _leverage) external override payable returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        require(uint168(msg.value) == msg.value, "Too much ETH");
        return _openPosition(uint168(msg.value), _maxCVI, _maxBuyingPremiumFeePercentage, _leverage, false);   
    }

    function transferFunds(uint256 _tokenAmount) internal override {
        msg.sender.transfer(_tokenAmount);
    }

    // ETH is passed automatically, nothing to do
    function collectTokens(uint256 _tokenAmount) internal override {
    }

    // ETH has already passed, so subtract amount to get balance before run
    function getTokenBalance(uint256 _tokenAmount) internal view override returns (uint256) {
        return address(this).balance.sub(_tokenAmount);
    }

    function sendProfit(uint256 _amount, IERC20 _token) internal override {
        payable(address(feesCollector)).transfer(_amount);
    }

    function deposit(uint256 tokenAmount, uint256 minLPTokenAmount) external override returns (uint256 lpTokenAmount) {
        revert("Use depositETH");
    }

    function openPosition(uint168 tokenAmount, uint16 maxCVI, uint168 maxBuyingPremiumFeePercentage, uint8 leverage) external override returns (uint168 positionUnitsAmount, uint168 positionedETHAmount) {
        revert("Use openPositionETH");
    }

    function increaseSharedPool(uint256 tokenAmount) external override {
        revert("Use increaseSharedPoolETH");
    }
}
