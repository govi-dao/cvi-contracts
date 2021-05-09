// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IETHVolatilityToken.sol";
import "./VolatilityToken.sol";
import "./interfaces/IETHPlatformV2.sol";
import "./interfaces/IPlatformV3.sol";

contract ETHVolatilityToken is VolatilityToken, IETHVolatilityToken {

    IETHPlatformV2 public ethPlatform;
    address payable public feesCollectorAddress;

    constructor(string memory _lpTokenName, string memory _lpTokenSymbolName, uint8 _leverage, uint256 _initialTokenToLPTokenRate, 
        IETHPlatformV2 _ethPlatform, address payable _feesCollectorAddress, IFeesCalculatorV4 _feesCalculator, IRequestFeesCalculator _requestFeesCalculator, ICVIOracleV3 _cviOracle, IUniswapOracle _uniswapOracle) 
            VolatilityToken (IERC20(address(0)), _lpTokenName, _lpTokenSymbolName, _leverage, _initialTokenToLPTokenRate, IPlatformV3(address(0)), IFeesCollector(address(0)), _feesCalculator, _requestFeesCalculator, _cviOracle, _uniswapOracle) {
        ethPlatform = _ethPlatform;
        feesCollectorAddress = _feesCollectorAddress;
    }

    function submitMintRequestETH(uint168 _tokenAmount, uint32 _timeDelay) external payable override nonReentrant returns (uint256 requestId) {
        return submitRequest(MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function submitCollateralizedMintRequestETH(uint168 _tokenAmount, uint32 _timeDelay) external payable override nonReentrant returns (uint256 requestId) {
        return submitRequest(COLLATERALIZED_MINT_REQUEST_TYPE, _tokenAmount, _timeDelay);
    }

    function fulfillMintRequestETH(uint256 _requestId) external payable override returns (uint256 tokensMinted) {
        return fulfillMintRequest(_requestId);
    }

    function fulfillCollateralizedMintRequestETH(uint256 _requestId) external payable override returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        return fulfillCollateralizedMintRequest(_requestId);
    }

    function transferFunds(uint256 _tokenAmount) internal override {
        msg.sender.transfer(_tokenAmount);
    }

    // ETH is passed automatically, but need to make sure there is enough, and return change
    function collectTokens(uint256 _tokenAmount) internal override {
        require(msg.value >= _tokenAmount, "Not enough ETH");
        if (msg.value > _tokenAmount) {
            msg.sender.transfer(msg.value - _tokenAmount);
        }
    }

    function sendProfit(uint256 _amount, IERC20 _token) internal override {
        feesCollectorAddress.transfer(_amount);
    }

    function openPosition(uint168 _amount, bool _withPremiumFee) internal override returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        return _withPremiumFee ? 
            ethPlatform.openPositionETH{value: _amount}(MAX_CVI_VALUE, MAX_PERCENTAGE, leverage) :
            ethPlatform.openPositionWithoutPremiumFeeETH{value: _amount}(MAX_CVI_VALUE, MAX_PERCENTAGE, leverage);
    }

    function deposit(uint256 _amount) internal override returns (uint256 shortTokensMinted) {
        return ethPlatform.depositETH{value: _amount}(0);
    }

    function submitMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external override returns (uint256 requestId) {
        revert("Use submitMintRequestETH");
    }

    function submitCollateralizedMintRequest(uint168 _tokenAmount, uint32 _timeDelay) external override returns (uint256 requestId) {
        revert("Use submitCollateralizedMintRequestETH");
    }

    function fulfillMintRequest(uint256 _requestId) public override returns (uint256 tokensMinted) {
        revert("Use fulfillMintRequestETH");
    }

    function fulfillCollateralizedMintRequest(uint256 _requestId) public override returns (uint256 tokensMinted, uint256 shortTokensMinted) {
        revert("Use fulfillCollateralizedMintRequestETH");
    }
}
