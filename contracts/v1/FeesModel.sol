// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "./utils/SafeMath80.sol";
import "./utils/SafeMath8.sol";

import "./interfaces/ICVIOracle.sol";
import "./interfaces/IFeesCalculator.sol";
import "./interfaces/IFeesModel.sol";

contract FeesModel is IFeesModel, Ownable {

    using SafeMath for uint256;
    using SafeMath8 for uint8;
    using SafeMath80 for uint80;

    uint256 private constant PRECISION_DECIMALS = 1e10;
    uint80 private constant ROUND_JUMPS_PRECISION = 1000;

    IFeesCalculator private feesCalculator;
    ICVIOracle private cviOracle;

    uint80 public maxOracleValuesUsed = 10;

    uint80 private latestOracleRoundId;
    uint256 private latestSnapshotTimestamp;
    
    mapping(uint256 => uint256) private cviSnapshots;

    constructor(IFeesCalculator _feesCalculator, ICVIOracle _cviOracle) {
        feesCalculator = _feesCalculator;
        cviOracle = _cviOracle;
    }

    function updateSnapshots() external override returns (uint256) {
        if (cviSnapshots[block.timestamp] != 0) { // Block was already updated
            return 0;
        }

        if (latestSnapshotTimestamp == 0) { // For first recorded block
            cviSnapshots[block.timestamp] = PRECISION_DECIMALS;
            (,latestOracleRoundId) = cviOracle.getCVILatestRoundData();
            latestSnapshotTimestamp = block.timestamp;
            return 0;
        }

        uint80 periodStartRoundId = latestOracleRoundId;
        (uint16 lastCVIValue, uint256 latestCVITimestamp) = cviOracle.getCVIRoundData(periodStartRoundId);
        (,latestOracleRoundId) = cviOracle.getCVILatestRoundData();

        require(latestOracleRoundId >= periodStartRoundId, "Bad round id");

        uint80 cviValuesNumLeft = latestOracleRoundId.sub(periodStartRoundId).add(1);
        uint80 roundsJump = ROUND_JUMPS_PRECISION;

        if (cviValuesNumLeft > maxOracleValuesUsed) {
            roundsJump = cviValuesNumLeft.mul(ROUND_JUMPS_PRECISION).div(maxOracleValuesUsed.sub(1));
            cviValuesNumLeft = maxOracleValuesUsed;
        }

        uint80 currRoundId = latestOracleRoundId;
        if (cviValuesNumLeft > 2) {
            currRoundId = periodStartRoundId.add(roundsJump / ROUND_JUMPS_PRECISION);
        }

        uint256 lastCVITimestamp = latestSnapshotTimestamp;
        uint8 currCVIValueIndex = 0;

        IFeesCalculator.CVIValue[] memory cviValues = new IFeesCalculator.CVIValue[](cviValuesNumLeft);
        cviValuesNumLeft = cviValuesNumLeft.sub(1);

        // Note: this line is valid even when cviValuesNumLeft == 0
        uint256[] memory cviPeriods = new uint256[](cviValuesNumLeft);

        bool shouldUpdateTurbulence = false;

        while (cviValuesNumLeft > 0) {
            shouldUpdateTurbulence = true;

            (uint16 currCVIValue, uint256 currCVITimestamp) = cviOracle.getCVIRoundData(currRoundId);
            
            if (currCVIValueIndex == 0) {
                cviPeriods[currCVIValueIndex] = currCVITimestamp.sub(latestCVITimestamp);
            } else {
                cviPeriods[currCVIValueIndex] = currCVITimestamp.sub(lastCVITimestamp);
            }

            cviValues[currCVIValueIndex] = IFeesCalculator.CVIValue(currCVITimestamp.sub(lastCVITimestamp), lastCVIValue);
            currCVIValueIndex = currCVIValueIndex.add(1);

            lastCVITimestamp = currCVITimestamp;
            lastCVIValue = currCVIValue;

            cviValuesNumLeft = cviValuesNumLeft - 1;

            if (cviValuesNumLeft == 1) {
                currRoundId = latestOracleRoundId; // Always round to latest round on last jump
            } else if (cviValuesNumLeft > 1) {
                currRoundId = periodStartRoundId.add(roundsJump.mul(currCVIValueIndex) / ROUND_JUMPS_PRECISION);
            }
        }

        cviValues[currCVIValueIndex] = IFeesCalculator.CVIValue(block.timestamp.sub(lastCVITimestamp), lastCVIValue);
        uint256 singleUnitFundingFee = feesCalculator.calculateSingleUnitFundingFee(cviValues);
        
        if (shouldUpdateTurbulence) {
            feesCalculator.updateTurbulenceIndicatorPercent(cviPeriods);
        }        

        cviSnapshots[block.timestamp] = cviSnapshots[latestSnapshotTimestamp].add(singleUnitFundingFee);
        latestSnapshotTimestamp = block.timestamp;

        return singleUnitFundingFee;
    }

    function setCVIOracle(ICVIOracle _newOracle) external override onlyOwner {
        cviOracle = _newOracle;
    }

    function setFeesCalculator(IFeesCalculator _newCalculator) external override onlyOwner {
        feesCalculator = _newCalculator;
    }

    function setLatestOracleRoundId(uint80 _newOracleRoundId) external override onlyOwner {
        latestOracleRoundId = _newOracleRoundId;
    }

    function setMaxOracleValuesUsed(uint80 _newMaxOracleValuesUsed) external override onlyOwner {
        maxOracleValuesUsed = _newMaxOracleValuesUsed;
    }
    
    function calculateFundingFees(uint256 startTime, uint256 endTime, uint256 positionUnitsAmount) external view override returns (uint256) {
        return _calculateFundingFees(startTime, endTime, positionUnitsAmount);
    }

    function calculateFundingFees(uint256 startTime, uint256 positionUnitsAmount) external view override returns (uint256) {
        return _calculateFundingFees(startTime, latestSnapshotTimestamp, positionUnitsAmount);
    }

    function calculateFundingFeesAddendum(uint256 positionUnitsAmount) external view override returns (uint256) {
        if (positionUnitsAmount == 0 || latestSnapshotTimestamp == 0 || latestSnapshotTimestamp == block.timestamp) {
            return 0;
        }

        uint80 currRoundId = latestOracleRoundId;
        (uint16 latestCVIValue ,uint80 updatedLatestOracleRoundId) = cviOracle.getCVILatestRoundData();
        (uint16 lastCVIValue,) = cviOracle.getCVIRoundData(currRoundId);
        uint256 lastCVITimestamp = latestSnapshotTimestamp;

        IFeesCalculator.CVIValue[] memory cviValues = new IFeesCalculator.CVIValue[](updatedLatestOracleRoundId.sub(latestOracleRoundId).add(1));

        while (currRoundId < updatedLatestOracleRoundId) {
            currRoundId = currRoundId.add(1);
            (uint16 currCVIValue, uint256 currCVITimestamp) = cviOracle.getCVIRoundData(currRoundId);
            cviValues[currRoundId.sub(latestOracleRoundId).sub(1)] = IFeesCalculator.CVIValue(currCVITimestamp.sub(lastCVITimestamp), lastCVIValue);
            
            lastCVITimestamp = currCVITimestamp;
            lastCVIValue = currCVIValue;
       }

       cviValues[currRoundId.sub(latestOracleRoundId)] = IFeesCalculator.CVIValue(block.timestamp.sub(lastCVITimestamp), latestCVIValue);
       return positionUnitsAmount.mul(feesCalculator.calculateSingleUnitFundingFee(cviValues)).div(PRECISION_DECIMALS);
    }

    function _calculateFundingFees(uint256 startTime, uint256 endTime, uint256 positionUnitsAmount) private view returns (uint256) {
        return cviSnapshots[endTime].sub(cviSnapshots[startTime]).mul(positionUnitsAmount).div(PRECISION_DECIMALS);
    }
}
