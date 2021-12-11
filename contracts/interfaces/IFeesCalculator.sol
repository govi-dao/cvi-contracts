// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./ICVIOracle.sol";

interface IFeesCalculator {

    struct CVIValue {
        uint256 period;
        uint16 cviValue;
    }

    struct SnapshotUpdate {
        uint256 latestSnapshot;
        uint256 singleUnitFundingFee;
        uint256 totalTime;
        uint256 totalRounds;
        uint256 cviValueTimestamp;
        uint80 newLatestRoundId;
        uint16 cviValue;
        bool updatedSnapshot;
        bool updatedLatestRoundId;
        bool updatedLatestTimestamp;
        bool updatedTurbulenceData;
    }

    function updateTurbulenceIndicatorPercent(uint256 totalTime, uint256 newRounds, uint16 lastCVIValue, uint16 currCVIValue) external;
    function updateAdjustedTimestamp(uint256 collateralRatio, uint256 lastCollateralRatio) external;
    function updateCloseAdjustedTimestamp(uint256 collateralRatio, uint256 lastCollateralRatio) external;

    function setOracle(ICVIOracle cviOracle) external;

    function setStateUpdator(address newUpdator) external;

    function setDepositFee(uint16 newDepositFeePercentage) external;
    function setWithdrawFee(uint16 newWithdrawFeePercentage) external;
    function setOpenPositionFee(uint16 newOpenPositionFeePercentage) external;
    function setOpenPositionLPFee(uint16 newOpenPositionLPFeePercent) external;
    function setClosePositionLPFee(uint16 newClosePositionLPFeePercent) external;
    function setClosePositionFee(uint16 newClosePositionFeePercentage) external;
    function setClosePositionMaxFee(uint16 newClosePositionMaxFeePercentage) external;
    function setClosePositionFeeDecay(uint256 newClosePositionFeeDecayPeriod) external;
    
    function setOracleHeartbeatPeriod(uint256 newOracleHeartbeatPeriod) external;
    function setBuyingPremiumFeeMax(uint16 newBuyingPremiumFeeMaxPercentage) external;
    function setBuyingPremiumThreshold(uint16 newBuyingPremiumThreshold) external;
    function setClosingPremiumFeeMax(uint16 newClosingPremiumFeeMaxPercentage) external;
    function setCollateralToBuyingPremiumMapping(uint16[] calldata newCollateralToBuyingPremiumMapping) external;
    function setFundingFeeConstantRate(uint16 newfundingFeeConstantRate) external;
    function setTurbulenceStep(uint16 newTurbulenceStepPercentage) external;
    function setMaxTurbulenceFeePercentToTrim(uint16 newMaxTurbulenceFeePercentToTrim) external;
    function setTurbulenceDeviationThresholdPercent(uint16 newTurbulenceDeviationThresholdPercent) external;
    function setTurbulenceDeviationPercent(uint16 newTurbulenceDeviationPercentage) external;

    function setVolumeTimeWindow(uint16 newVolumeTimeWindow) external;
    function setVolumeFeeTimeWindow(uint16 newVolumeFeeTimeWindow) external;
    function setMaxVolumeFeeDeltaCollateral(uint16 newMaxVolumeFeeDeltaCollateral) external;
    function setMidVolumeFee(uint16 newMidVolumeFee) external;
    function setMaxVolumeFee(uint16 newMaxVolumeFee) external;

    function setCloseVolumeTimeWindow(uint16 newCloseVolumeTimeWindow) external;
    function setCloseVolumeFeeTimeWindow(uint16 newCloseVolumeFeeTimeWindow) external;
    function setCloseMaxVolumeFeeDeltaCollateral(uint16 newCloseMaxVolumeFeeDeltaCollateral) external;
    function setCloseMidVolumeFee(uint16 newCloseMidVolumeFee) external;
    function setCloseMaxVolumeFee(uint16 newCloseMaxVolumeFee) external;

    function calculateTurbulenceIndicatorPercent(uint256 totalTime, uint256 newRounds, uint16 _lastCVIValue, uint16 _currCVIValue) external view returns (uint16);

    function calculateBuyingPremiumFee(uint168 tokenAmount, uint8 leverage, uint256 collateralRatio, uint256 lastCollateralRatio, bool withVolumeFee) external view returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage);
    function calculateBuyingPremiumFeeWithAddendum(uint168 tokenAmount, uint8 leverage, uint256 collateralRatio, uint256 lastCollateralRatio, bool withVolumeFee, uint16 _turbulenceIndicatorPercent) external view returns (uint168 buyingPremiumFee, uint16 combinedPremiumFeePercentage);

    function calculateClosingPremiumFee(uint256 tokenAmount, uint256 collateralRatio, uint256 lastCollateralRatio, bool withVolumeFee) external view returns (uint16 combinedPremiumFeePercentage);
    function calculateClosingPremiumFeeWithAddendum(uint256 collateralRatio, uint256 lastCollateralRatio, bool withVolumeFee) external view returns (uint16 combinedPremiumFeePercentage);

    function calculateSingleUnitFundingFee(CVIValue[] memory cviValues) external view returns (uint256 fundingFee);
    function updateSnapshots(uint256 latestTimestamp, uint256 blockTimestampSnapshot, uint256 latestTimestampSnapshot, uint80 latestOracleRoundId) external view returns (SnapshotUpdate memory snapshotUpdate);

    function calculateClosePositionFeePercent(uint256 creationTimestamp, bool isNoLockPositionAddress) external view returns (uint16);
    function calculateWithdrawFeePercent(uint256 lastDepositTimestamp) external view returns (uint16);

    function depositFeePercent() external view returns (uint16);
    function withdrawFeePercent() external view returns (uint16);
    function openPositionFeePercent() external view returns (uint16);
    function closePositionFeePercent() external view returns (uint16);
    function openPositionLPFeePercent() external view returns (uint16);
    function closePositionLPFeePercent() external view returns (uint16);

    function openPositionFees() external view returns (uint16 openPositionFeePercentResult, uint16 buyingPremiumFeeMaxPercentResult);

    function turbulenceIndicatorPercent() external view returns (uint16);
}
