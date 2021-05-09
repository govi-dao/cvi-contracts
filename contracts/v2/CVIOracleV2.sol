// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "./interfaces/ICVIOracleV2.sol";
import "../v1/interfaces/AggregatorV3Interface.sol";

contract CVIOracleV2 is ICVIOracleV2 {

	using SafeMath for uint256;

    uint256 private constant CVI_DECIMALS_TRUNCATE = 1e16;
    uint256 private constant MAX_CVI_VALUE = 200e18;

    AggregatorV3Interface public immutable cviAggregator;

    constructor(AggregatorV3Interface _cviAggregator) {
    	cviAggregator = _cviAggregator;
    }

    function getCVIRoundData(uint80 _roundId) external view override returns (uint16 cviValue, uint256 cviTimestamp) {
        (,int256 cviOracleValue,,uint256 cviOracleTimestamp,) = cviAggregator.getRoundData(_roundId);
        cviTimestamp = cviOracleTimestamp;
        cviValue = getTruncatedCVIValue(cviOracleValue);
    }

    function getCVILatestRoundData() external view override returns (uint16 cviValue, uint80 cviRoundId) {
        (uint80 oracleRoundId, int256 cviOracleValue,,,) = cviAggregator.latestRoundData();
        cviRoundId = oracleRoundId;
        cviValue = getTruncatedCVIValue(cviOracleValue);
    }

    function getCVILatestRoundDataAndTimestamp() external view override returns (uint16 cviValue, uint80 cviRoundId, uint256 cviTimestamp) {
        (uint80 oracleRoundId, int256 cviOracleValue,, uint256 oracleTimestamp,) = cviAggregator.latestRoundData();
        return (getTruncatedCVIValue(cviOracleValue), oracleRoundId, oracleTimestamp);
    }

    function getTruncatedCVIValue(int256 cviOracleValue) private pure returns (uint16) {
        require(cviOracleValue > 0, "CVI must be positive");
        uint256 cviValue = uint256(cviOracleValue);
        if (cviValue > MAX_CVI_VALUE) {
            cviValue = MAX_CVI_VALUE / CVI_DECIMALS_TRUNCATE;
        }
        return uint16(cviValue / CVI_DECIMALS_TRUNCATE);
    }
}