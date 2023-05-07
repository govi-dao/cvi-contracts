// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./interfaces/ICVIOracle.sol";
import "./interfaces/AggregatorV3Interface.sol";

import "@openzeppelin/contracts/access/Ownable.sol";

contract CVIOracle is ICVIOracle, Ownable {

    uint256 private constant PRECISION_DECIMALS = 10000;
    uint256 private constant CVI_DECIMALS_TRUNCATE = 1e16;

    AggregatorV3Interface public immutable cviAggregator;
    AggregatorV3Interface public cviDeviationAggregator;
    bool public deviationCheck = false;
    uint16 public maxDeviation = 1000;

    uint8 public leverage;
    uint256 public maxCVIValue;

    constructor(AggregatorV3Interface _cviAggregator, AggregatorV3Interface _cviDeviationAggregator, uint256 _maxCVIValue, uint8 _leverage) {
    	cviAggregator = _cviAggregator;
        cviDeviationAggregator = _cviDeviationAggregator;
        maxCVIValue = _maxCVIValue;
        leverage = _leverage;
    }

    function getCVIRoundData(uint80 _roundId) external view override returns (uint32 cviValue, uint256 cviTimestamp) {
        (, int256 cviOracleValue,, uint256 cviOracleTimestamp,) = cviAggregator.getRoundData(_roundId);
        cviTimestamp = cviOracleTimestamp;
        cviValue = getTruncatedCVIValue(cviOracleValue);
    }

    function getCVILatestRoundData() external view override returns (uint32 cviValue, uint80 cviRoundId, uint256 cviTimestamp) {
        (uint80 oracleRoundId, int256 cviOracleValue,, uint256 oracleTimestamp,) = cviAggregator.latestRoundData();
        uint32 truncatedCVIOracleValue = getTruncatedCVIValue(cviOracleValue);

        if (deviationCheck) {
            (, int256 cviDeviationOracleValue,,,) = cviDeviationAggregator.latestRoundData();
            uint32 truncatedCVIDeviationOracleValue = getTruncatedCVIValue(cviDeviationOracleValue);

            uint256 deviation = truncatedCVIDeviationOracleValue > truncatedCVIOracleValue ? truncatedCVIDeviationOracleValue - truncatedCVIOracleValue : truncatedCVIOracleValue - truncatedCVIDeviationOracleValue;

            require(deviation * PRECISION_DECIMALS / truncatedCVIDeviationOracleValue <= maxDeviation, "Deviation too large");
        }

        return (truncatedCVIOracleValue, oracleRoundId, oracleTimestamp);
    }

    function setDeviationCheck(bool _newDeviationCheck) external override onlyOwner {
        deviationCheck = _newDeviationCheck;
    }

    function setMaxDeviation(uint16 _newMaxDeviation) external override onlyOwner {
        maxDeviation = _newMaxDeviation;
    }

    function getTruncatedCVIValue(int256 cviOracleValue) private view returns (uint32) {
        uint256 cviValue = uint256(cviOracleValue) * leverage;
        if (cviValue > maxCVIValue) {
            require(uint32(maxCVIValue / CVI_DECIMALS_TRUNCATE) > 0, "CVI must be positive");
            return uint32(maxCVIValue / CVI_DECIMALS_TRUNCATE);
        }

        require(uint32(cviValue / CVI_DECIMALS_TRUNCATE) > 0, "CVI must be positive");
        return uint32(cviValue / CVI_DECIMALS_TRUNCATE);
    }
}
