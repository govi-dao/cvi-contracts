// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;


import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./interfaces/IETHVolatilityToken.sol";
import "./VolatilityToken.sol";
import "./interfaces/IETHPlatform.sol";
import "./interfaces/IPlatform.sol";

contract ETHVolatilityToken is VolatilityToken, IETHVolatilityToken {

    IETHPlatform public ethPlatform;
    address payable public feesCollectorAddress;

    function initialize(string memory _lpTokenName, string memory _lpTokenSymbolName, uint8 _leverage, uint256 _initialTokenToLPTokenRate, 
                        IETHPlatform _ethPlatform, address payable _feesCollectorAddress, IFeesCalculator _feesCalculator, IRequestFeesCalculator _requestFeesCalculator,
                        ICVIOracle _cviOracle) public initializer {
        VolatilityToken.initialize(IERC20Upgradeable(address(0)), _lpTokenName, _lpTokenSymbolName, _leverage, _initialTokenToLPTokenRate, 
            IPlatform(address(0)), IFeesCollector(address(0)), _feesCalculator, _requestFeesCalculator, _cviOracle);
        ethPlatform = _ethPlatform;
        feesCollectorAddress = _feesCollectorAddress;
    }

    function submitMintRequestETH(uint168 _tokenAmount, uint32 _timeDelay) external payable override nonReentrant returns (uint256 requestId) {
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function fulfillMintRequestETH(uint256 _requestId, uint16 _maxBuyingPremiumFeePercentage) external payable override returns (uint256 tokensMinted) {
        return fulfillMintRequest(_requestId, _maxBuyingPremiumFeePercentage);
    }

    function fulfillCollateralizedMintRequestETH(uint256 _requestId) external payable override returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        return fulfillCollateralizedMintRequest(_requestId);
    }

    function transferFunds(uint256 _tokenAmount) internal override {
        payable(msg.sender).transfer(_tokenAmount);
    }

    // ETH is passed automatically, but need to make sure there is enough, and return change
    function collectTokens(uint256 _tokenAmount) internal override {
        require(msg.value >= _tokenAmount, "Not enough ETH");
        if (msg.value > _tokenAmount) {
            payable(msg.sender).transfer(msg.value - _tokenAmount);
        }
    }

    function sendProfit(uint256 _amount, IERC20Upgradeable /*_token*/) internal override {
        feesCollectorAddress.transfer(_amount);
    }

    function openPosition(uint168 _amount, bool _withPremiumFee, uint16 _maxBuyingPremiumFeePercentage) internal override returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        return _withPremiumFee ? 
            ethPlatform.openPositionETH{value: _amount}(IPlatform(address(ethPlatform)).maxCVIValue(), _maxBuyingPremiumFeePercentage, leverage) :
            ethPlatform.openPositionWithoutPremiumFeeETH{value: _amount}(IPlatform(address(ethPlatform)).maxCVIValue(), leverage);
    }

    function deposit(uint256 _amount) internal override returns (uint256 shortTokensMinted) {
        return ethPlatform.depositETH{value: _amount}(0);
    }

    function submitMintRequest(uint168 /*_tokenAmount*/, uint32/*_timeDelay*/) external pure override returns (uint256 /*requestId*/) {
        revert("Use submitMintRequestETH");
    }

    function fulfillMintRequest(uint256 /*_requestId*/, uint16 /*_maxBuyingPremiumFeePercentage*/) public pure override returns (uint256 /*tokensMinted*/) {
        revert("Use fulfillMintRequestETH");
    }

    function fulfillCollateralizedMintRequest(uint256 /*_requestId*/) public pure override returns (uint256 /*tokensMinted*/, uint256 /*shortTokensMinted*/) {
        revert("Use fulfillCollateralizedMintRequestETH");
    }
}
