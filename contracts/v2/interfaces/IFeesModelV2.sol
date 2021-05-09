// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "../../v1/interfaces/IFeesModel.sol";
import "./ICVIOracleV2.sol";
import "./IFeesCalculatorV2.sol";

interface IFeesModelV2 is IFeesModel {
	function setCVIOracleV2(ICVIOracleV2 newOracleV2) external;
	function setFeesCalculatorV2(IFeesCalculatorV2 newCalculatorV2) external;
    function setFeesModelProxy(IFeesModel newFeesModelProxy) external;

    function calculateLatestFundingFees(uint256 startTime, uint256 positionUnitsAmount) external view returns (uint256);
	function calculateLatestTurbulenceIndicatorPercent() external view returns (uint16);
}
