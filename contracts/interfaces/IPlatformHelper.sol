// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./IPlatform.sol";
import "./IVolatilityToken.sol";
import "./IElasticToken.sol";
import "./IThetaVault.sol";

interface IPlatformHelper {

    struct PreMintResult {
        uint256 netMintAmount;
        uint256 expectedVolTokensAmount;
        uint256 buyingPremiumFeePercentage;
        uint256 openPositionFee;
        uint256 buyingPremiumFee;
        uint256 timeWindowFee;
        uint256 keepersFee;
    }

    struct PreBurnResult {
        uint256 netBurnAmount;
        uint256 expectedUSDCAmount;
        uint256 closeFee;
        uint256 timeWindowFee;
        uint256 keepersFee;
    }

    struct CheckMintResult {
        uint256 netMintAmount;
        uint256 expectedVolTokensAmount;
        uint256 buyingPremiumFeePercentage;
        uint256 openPositionFee;
        uint256 buyingPremiumFee;
        uint256 timePenaltyFee;
        uint256 keepersFee;
        bool insufficientLiquidity;
        bool insufficientSlippage;
    }

    struct CheckBurnResult {
        uint256 netBurnAmount;
        uint256 expectedUSDCAmount;
        uint256 closeFee;
        uint256 timePenaltyFee;
        uint256 keepersFee;
    }

    function dailyFundingFee(IPlatform platform) external view returns (uint256 fundingFeePercent);
    function fundingFeeValues(IPlatform platform, uint32 minCVI, uint32 maxCVI, uint256 minCollateral, uint256 maxCollateral) external view returns (uint256[][] memory fundingFeeRatePercent);   	
    function collateralRatio(IPlatform platform) external view returns (uint256);
    function premiumFeeCollateralRatio(IPlatform platform) external view returns (uint256);

    function volTokenIntrinsicPrice(IVolatilityToken volToken) external view returns (uint256);
    function volTokenDexPrice(IThetaVault thetaVault) external view returns (uint256);

    function maxMintAmount(IVolatilityToken volToken) external view returns (uint256 maxAmount);
    function maxWithdrawAmount(IThetaVault thetaVault) external view returns (uint256 maxAmount, uint256 maxUSDCAmount);
    function willWithdrawSucceed(IThetaVault thetaVault, uint256 withdrawAmount) external view returns (bool success);

    function calculatePreMint(IVolatilityToken volToken, bool isKeepers, uint256 usdcAmount, uint256 timeWindow) external view returns (PreMintResult memory result);
    function calculatePreBurn(IVolatilityToken volToken, bool isKeepers, uint256 volTokensAmount, uint256 timeWindow) external view returns (PreBurnResult memory result);

    function checkMintRequest(IVolatilityToken volToken, uint256 requestId, bool isKeepers) external view returns (CheckMintResult memory result);
    function checkBurnRequest(IVolatilityToken volToken, uint256 requestId, bool isKeepers) external view returns (CheckBurnResult memory result);

    function convertGOVIToXGOVI(uint256 amount) external view returns (uint256 xGOVIAmount);
    function convertXGOVIToGOVI(uint256 xGOVIAmount) external view returns (uint256 goviAmount);
    function stakedGOVI(address account) external view returns (uint256 stakedAmount, uint256 share);
    function calculateStakingAPR() external view returns (uint256 apr);
}
