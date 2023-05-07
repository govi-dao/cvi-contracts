// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./IPlatform.sol";
import "./IRequestFeesCalculator.sol";
import "./ICVIOracle.sol";

interface IVolatilityToken {

    struct Request {
        uint8 requestType; // 1 => mint, 2 => burn
        uint168 tokenAmount;
        uint16 timeDelayRequestFeesPercent;
        uint16 maxRequestFeesPercent;
        address owner;
        uint32 requestTimestamp;
        uint32 targetTimestamp;
        bool useKeepers;
        uint16 maxBuyingPremiumFeePercentage;
    }

    event SubmitRequest(uint256 requestId, uint8 requestType, address indexed account, uint256 tokenAmount, uint256 submitFeesAmount, uint32 requestTimestamp, uint32 targetTimestamp, bool useKeepers, uint16 maxBuyingPremiumFeePercentage);
    event FulfillRequest(uint256 requestId, uint8 requestType, address indexed account, uint256 fulfillFeesAmount, bool isAborted, bool useKeepers, bool keepersCalled, address indexed fulfiller, uint32 fulfillTimestamp);
    event LiquidateRequest(uint256 requestId, uint8 requestType, address indexed account, address indexed liquidator, uint256 findersFeeAmount, bool useKeepers, uint32 liquidateTimestamp);
    event Mint(uint256 requestId, address indexed account, uint256 tokenAmount, uint256 positionedTokenAmount, uint256 mintedTokens, uint256 openPositionFee, uint256 buyingPremiumFee);
    event Burn(uint256 requestId, address indexed account, uint256 tokenAmountBeforeFees, uint256 tokenAmount, uint256 burnedTokens, uint256 closePositionFee, uint256 closingPremiumFee);

    function rebaseCVI() external;

    function submitMintRequest(uint168 tokenAmount, uint32 timeDelay) external returns (uint256 requestId);
    function submitKeepersMintRequest(uint168 tokenAmount, uint32 timeDelay, uint16 maxBuyingPremiumFeePercentage) external returns (uint256 requestId);
    function submitBurnRequest(uint168 tokenAmount, uint32 timeDelay) external returns (uint256 requestId);
    function submitKeepersBurnRequest(uint168 tokenAmount, uint32 timeDelay) external returns (uint256 requestId);

    function fulfillMintRequest(uint256 requestId, uint16 maxBuyingPremiumFeePercentage, bool keepersCalled) external returns (uint256 tokensMinted, bool success);
    function fulfillBurnRequest(uint256 requestId, bool keepersCalled) external returns (uint256 tokensBurned);

    function mintTokens(uint168 tokenAmount) external returns (uint256 mintedTokens);
    function burnTokens(uint168 burnAmount) external returns (uint256 tokenAmount);

    function liquidateRequest(uint256 requestId) external returns (uint256 findersFeeAmount);

    function setMinter(address minter) external;
    function setPlatform(IPlatform newPlatform) external;
    function setFeesCalculator(IFeesCalculator newFeesCalculator) external;
    function setFeesCollector(IFeesCollector newCollector) external;
    function setRequestFeesCalculator(IRequestFeesCalculator newRequestFeesCalculator) external;
    function setCVIOracle(ICVIOracle newCVIOracle) external;
    function setDeviationParameters(uint16 newDeviationPercentagePerSingleRebaseLag, uint16 newMinDeviationPercentage, uint16 newMaxDeviationPercentage) external;
    function setVerifyTotalRequestsAmount(bool verifyTotalRequestsAmount) external;
    function setMaxTotalRequestsAmount(uint256 maxTotalRequestsAmount) external;
    function setCappedRebase(bool newCappedRebase) external;

    function setMinRequestId(uint256 newMinRequestId) external;
    function setMaxMinRequestIncrements(uint256 newMaxMinRequestIncrements) external;

    function setFulfiller(address fulfiller) external;

    function setKeepersFeeVaultAddress(address newKeepersFeeVaultAddress) external;

    function setMinKeepersAmounts(uint256 newMinKeepersMintAmount, uint256 newMinKeepersBurnAmount) external;

    function platform() external view returns (IPlatform);
    function requestFeesCalculator() external view returns (IRequestFeesCalculator);
    function leverage() external view returns (uint8);
    function initialTokenToLPTokenRate() external view returns (uint256);

    function requests(uint256 requestId) external view returns (uint8 requestType, uint168 tokenAmount, uint16 timeDelayRequestFeesPercent, uint16 maxRequestFeesPercent,
        address owner, uint32 requestTimestamp, uint32 targetTimestamp, bool useKeepers, uint16 maxBuyingPremiumFeePercentage);
}
