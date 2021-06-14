// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;

import "./IPlatformV3.sol";
import "./IRequestFeesCalculator.sol";
import "./../../v3/interfaces/ICVIOracleV3.sol";
import "./IUniswapOracle.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";

interface IVolatilityToken {

	struct Request {
		uint8 requestType; // 1 => mint, 2 => burn, 3 => collateralized mint
		uint168 tokenAmount;
        uint16 timeDelayRequestFeesPercent;
		uint16 maxRequestFeesPercent;
        address owner;
        uint32 requestTimestamp;
        uint32 targetTimestamp;
    }

    event SubmitRequest(uint256 requestId, uint8 requestType, address indexed account, uint256 tokenAmount, uint256 submitFeesAmount, uint32 targetTimestamp);
    event FulfillRequest(uint256 requestId, uint256 fulfillFeesAmount);
    event Mint(address indexed account, uint256 tokenAmount, uint256 mintedTokens);
    event CollateralizedMint(address indexed account, uint256 tokenAmount, uint256 mintedTokens, uint256 mintedShortTokens);
    event Burn(address indexed account, uint256 tokenAmount, uint256 burnedTokens);

    function rebaseCVI() external;

    function submitMintRequest(uint168 tokenAmount, uint32 timeDelay) external returns (uint256 requestId);
    function submitBurnRequest(uint168 tokenAmount, uint32 timeDelay) external returns (uint256 requestId);

    function fulfillMintRequest(uint256 requestId, uint16 maxBuyingPremiumFeePercentage) external returns (uint256 tokensMinted);
    function fulfillBurnRequest(uint256 requestId) external returns (uint256 tokensBurned);
    function fulfillCollateralizedMintRequest(uint256 requestId) external returns (uint256 tokensMinted, uint256 shortTokensMinted);

    function liquidateRequest(uint256 requestId) external returns (uint256 findersFeeAmount);

    function setPlatform(IPlatformV3 newPlatform) external;
    function setFeesCalculator(IFeesCalculatorV4 newFeesCalculator) external;
    function setFeesCollector(IFeesCollector newCollector) external;
    function setRequestFeesCalculator(IRequestFeesCalculator newRequestFeesCalculator) external;
    function setCVIOracle(ICVIOracleV3 newCVIOracle) external;
    function setMinDeviation(uint16 newMinDeviationPercentage) external;
    function setRebaseLag(uint8 newRebaseLag) external;
}
