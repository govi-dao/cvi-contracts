// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./interfaces/IETHPlatform.sol";
import "./Platform.sol";

contract ETHPlatform is Platform, IETHPlatform {

    function initialize(string memory _lpTokenName, string memory _lpTokenSymbolName, uint256 _initialTokenToLPTokenRate, uint16 _maxCVIValue,
        IFeesCalculator _feesCalculator,
        ICVIOracle _cviOracle,
        ILiquidation _liquidation) public initializer {
            Platform.initialize(IERC20Upgradeable(address(0)), _lpTokenName, _lpTokenSymbolName, _initialTokenToLPTokenRate, _maxCVIValue, _feesCalculator, _cviOracle, _liquidation);
    }

    function depositETH(uint256 _minLPTokenAmount) external override payable returns (uint256 lpTokenAmount) {
        lpTokenAmount = _deposit(msg.value, _minLPTokenAmount);
    }

    function increaseSharedPoolETH() external override payable {
        _increaseSharedPool(msg.value);
    }

    function openPositionETH(uint16 _maxCVI, uint16 _maxBuyingPremiumFeePercentage, uint8 _leverage) external override payable returns (uint168 positionUnitsAmount, uint168 positionedETHAmount) {
        require(uint168(msg.value) == msg.value, "Too much ETH");
        return _openPosition(uint168(msg.value), _maxCVI, _maxBuyingPremiumFeePercentage, _leverage, true, true);
    }

    function openPositionWithoutVolumeFeeETH(uint16 _maxCVI, uint16 _maxBuyingPremiumFeePercentage, uint8 _leverage) external override payable returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        require(uint168(msg.value) == msg.value, "Too much ETH");
        require(noPremiumFeeAllowedAddresses[msg.sender]); // "Not allowed"
        return _openPosition(uint168(msg.value), _maxCVI, _maxBuyingPremiumFeePercentage, _leverage, true, false);   
    }

    function openPositionWithoutPremiumFeeETH(uint16 _maxCVI, uint8 _leverage) external override payable returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        require(uint168(msg.value) == msg.value, "Too much ETH");
        require(noPremiumFeeAllowedAddresses[msg.sender]); // "Not allowed"
        return _openPosition(uint168(msg.value), _maxCVI, 0, _leverage, false, false);
    }

    function transferFunds(uint256 _tokenAmount) internal override {
        payable(msg.sender).transfer(_tokenAmount);
    }

    // ETH is passed automatically, nothing to do
    function collectTokens(uint256 _tokenAmount) internal override {
    }

    function sendProfit(uint256 _amount, IERC20Upgradeable /*_token*/) internal override {
        payable(address(feesCollector)).transfer(_amount);
    }

    function deposit(uint256 /*tokenAmount*/, uint256 /*minLPTokenAmount*/) external pure override returns (uint256 /*lpTokenAmount*/) {
        revert();
    }

    function openPosition(uint168 /*tokenAmount*/, uint16 /*maxCVI*/, uint16 /*maxBuyingPremiumFeePercentage*/, uint8 /*leverage*/) external  pure override returns (uint168 /*positionUnitsAmount*/, uint168 /*positionedETHAmount*/) {
        revert();
    }

    function increaseSharedPool(uint256 /*tokenAmount*/) external pure override {
        revert();
    }
}
