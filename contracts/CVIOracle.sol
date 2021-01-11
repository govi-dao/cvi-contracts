// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "./interfaces/ICVIOracle.sol";
import "./interfaces/AggregatorV3Interface.sol";

contract CVIOracle is ICVIOracle {

	using SafeMath for uint256;

    uint256 private constant CVI_DECIMALS_TRUNCATE = 10000;
    uint256 private constant MAX_CVI_VALUE = 200000000;

    AggregatorV3Interface public immutable cviAggregator;

    constructor(AggregatorV3Interface _cviAggregator) public {
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

    function getTruncatedCVIValue(int256 cviOracleValue) private pure returns (uint16) {
        require(cviOracleValue > 0, "CVI must be positive");
        uint256 cviValue = uint256(cviOracleValue);
        if (cviValue > MAX_CVI_VALUE) {
            cviValue = MAX_CVI_VALUE / CVI_DECIMALS_TRUNCATE;
        }
        return uint16(cviValue / CVI_DECIMALS_TRUNCATE);
    }
}