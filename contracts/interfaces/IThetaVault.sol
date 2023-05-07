// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import '@coti-cvi/contracts-staking/contracts/interfaces/IRewardRouter.sol';

import "./IThetaVaultInfo.sol";
import "./IVolatilityToken.sol";

interface IThetaVault is IThetaVaultInfo {

    event SubmitRequest(uint256 requestId, uint8 requestType, uint256 tokenAmount, uint32 targetTimestamp, address indexed account, uint256 totalUSDCBalance, uint256 totalSupply);
    event FulfillDeposit(uint256 requestId, address indexed account, uint256 totalUSDCAmount, uint256 platformLiquidityAmount, uint256 dexVolTokenUSDCAmount, uint256 dexVolTokenAmount, uint256 dexUSDCAmount, uint256 mintedThetaTokens);
    event FulfillWithdraw(uint256 requestId, address indexed account, uint256 totalUSDCAmount, uint256 platformLiquidityAmount, uint256 dexVolTokenAmount, uint256 dexUSDCVolTokenAmount, uint256 dexUSDCAmount, uint256 burnedThetaTokens);
    event LiquidateRequest(uint256 requestId, uint8 requestType, address indexed account, address indexed liquidator, uint256 tokenAmount);

    function submitDepositRequest(uint168 tokenAmount/* , bool shouldStake */) external returns (uint256 requestId);
    function submitWithdrawRequest(uint168 thetaTokenAmount) external returns (uint256 requestId);

    function fulfillDepositRequest(uint256 requestId) external returns (uint256 thetaTokensMinted);
    function fulfillWithdrawRequest(uint256 requestId) external returns (uint256 tokenWithdrawnAmount);

    function liquidateRequest(uint256 requestId) external;

    function rebalance() external;

    function setRewardRouter(IRewardRouter rewardRouter) external;
    function setFulfiller(address newFulfiller) external;
    function setMinPoolSkew(uint16 newMinPoolSkewPercentage) external;
    function setLiquidityPercentages(uint16 newExtraLiquidityPercentage, uint16 minDexPercentageAllowed) external;
    function setRequestDelay(uint256 newRequestDelay) external;
    function setDepositCap(uint256 newDepositCap) external;
    function setPeriods(uint256 newLockupPeriod, uint256 newLiquidationPeriod) external;
    function setMinAmounts(uint256 newMinDepositAmount, uint256 newMinWithdrawAmount) external;
    function setDepositHoldings(uint16 newDepositHoldingsPercentage) external;
    
    function volToken() external view returns (IVolatilityToken);

    function totalBalance() external view returns (uint256 balance, uint256 usdcPlatformLiquidity, uint256 intrinsicDEXVolTokenBalance, uint256 volTokenPositionBalance, uint256 dexUSDCAmount, uint256 dexVolTokensAmount);
    function getReserves() external view returns (uint256 volTokenAmount, uint256 usdcAmount);
    function requests(uint256 requestId) external view returns (uint8 requestType, uint168 tokenAmount, uint32 targetTimestamp, address owner, bool shouldStake);
}
