// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

import "../../v1/interfaces/ICVIOracle.sol";

interface ICVIOracleV2 is ICVIOracle {
	function getCVILatestRoundDataAndTimestamp() external view returns (uint16 cviValue, uint80 cviRoundId, uint256 periodTimestamp);
}
