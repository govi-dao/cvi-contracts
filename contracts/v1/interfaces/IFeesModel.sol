// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "./ICVIOracle.sol";
import "./IFeesCalculator.sol";

interface IFeesModel {
    function updateSnapshots() external returns (uint256);

    function setCVIOracle(ICVIOracle newOracle) external;
    function setFeesCalculator(IFeesCalculator newCalculator) external;
    function setLatestOracleRoundId(uint80 newOracleRoundId) external;
    function setMaxOracleValuesUsed(uint80 newMaxOracleValuesUsed) external;

    function calculateFundingFees(uint256 startTime, uint256 positionUnitsAmount) external view returns (uint256);
    function calculateFundingFees(uint256 startTime, uint256 endTime, uint256 positionUnitsAmount) external view returns (uint256);
    function calculateFundingFeesAddendum(uint256 positionUnitsAmount) external view returns (uint256);
}
