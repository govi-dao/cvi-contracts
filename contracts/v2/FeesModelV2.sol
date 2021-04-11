// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "../v1/utils/SafeMath80.sol";
import "../v1/utils/SafeMath8.sol";

import "./interfaces/IFeesModelV2.sol";

contract FeesModelV2 is IFeesModelV2, Ownable {

    using SafeMath for uint256;
    using SafeMath8 for uint8;
    using SafeMath80 for uint80;

    uint256 public constant PRECISION_DECIMALS = 1e10;

    IFeesModel private feesModelProxy;
    IFeesCalculatorV2 private feesCalculator;
    ICVIOracleV2 private cviOracle;

    uint80 public latestOracleRoundId;
    uint256 public latestSnapshotTimestamp;
    
    mapping(uint256 => uint256) public cviSnapshots;

    struct SnapshotUpdate {
        uint256 newSnapshot;
        uint256 singleUnitFundingFee;
        uint256 totalHours;
        uint256 totalRounds;
        uint80 newLatestRoundId;
        bool updatedSnapshot;
        bool updatedLatestRoundId;
        bool updatedLatestTimestamp;
        bool updatedTurbulenceData;
    }

    constructor(uint80 _latestOracleRoundId, uint256 _latestSnapshotTimestamp, uint256 latestSnapshot, 
                IFeesModel _feesModelProxy, IFeesCalculatorV2 _feesCalculator, ICVIOracleV2 _cviOracle) public {
        feesModelProxy = _feesModelProxy;
        feesCalculator = _feesCalculator;
        cviOracle = _cviOracle;
        latestOracleRoundId = _latestOracleRoundId;
        latestSnapshotTimestamp = _latestSnapshotTimestamp;
        cviSnapshots[_latestSnapshotTimestamp] = latestSnapshot;
    }

    function updateSnapshots() external override returns (uint256 singleUnitFundingFee) {
        SnapshotUpdate memory updateData = _updateSnapshots();

        if (updateData.updatedSnapshot) {
            cviSnapshots[block.timestamp] = updateData.newSnapshot;
        }

        if (updateData.updatedLatestRoundId) {
            latestOracleRoundId = updateData.newLatestRoundId;
        }

        if (updateData.updatedLatestTimestamp) {
            latestSnapshotTimestamp = uint128(block.timestamp);
        }

        if (updateData.updatedTurbulenceData) {
            feesCalculator.updateTurbulenceIndicatorPercent(updateData.totalHours, updateData.totalRounds);
        }

        return (updateData.singleUnitFundingFee);
    }

    function setCVIOracle(ICVIOracle _newOracle) external override onlyOwner {
    }

    function setCVIOracleV2(ICVIOracleV2 _newOracleV2) external override onlyOwner {
        cviOracle = _newOracleV2;
    }

    function setFeesCalculator(IFeesCalculator _newCalculator) external override onlyOwner {
    }

    function setFeesCalculatorV2(IFeesCalculatorV2 _newCalculatorV2) external override onlyOwner {
        feesCalculator = _newCalculatorV2;
    }

    function setLatestOracleRoundId(uint80 _newOracleRoundId) external override onlyOwner {
        latestOracleRoundId = _newOracleRoundId;
    }

    function setMaxOracleValuesUsed(uint80 _newMaxOracleValuesUsed) external override onlyOwner {
    }

    function setFeesModelProxy(IFeesModel _newFeesModelProxy) external override onlyOwner {
        feesModelProxy = _newFeesModelProxy;
    }

    function calculateFundingFees(uint256 startTime, uint256 endTime, uint256 positionUnitsAmount) external view override returns (uint256) {
        return _calculateFundingFees(startTime, cviSnapshots[endTime], positionUnitsAmount);
    }

    function calculateFundingFees(uint256 startTime, uint256 positionUnitsAmount) external view override returns (uint256) {
        return _calculateFundingFees(startTime, cviSnapshots[latestSnapshotTimestamp], positionUnitsAmount);
    }

    function calculateFundingFeesAddendum(uint256 positionUnitsAmount) external view override returns (uint256) {
        return this.calculateLatestFundingFees(latestSnapshotTimestamp, positionUnitsAmount);
    }

    function calculateLatestFundingFees(uint256 startTime, uint256 positionUnitsAmount) external view override returns (uint256) {
        SnapshotUpdate memory updateData = _updateSnapshots();
        uint256 latestSnapshot = updateData.updatedSnapshot ? updateData.newSnapshot : cviSnapshots[latestSnapshotTimestamp];
        return _calculateFundingFees(startTime, latestSnapshot, positionUnitsAmount);
    }

    function calculateLatestTurbulenceIndicatorPercent() external view override returns (uint16) {
        SnapshotUpdate memory updateData = _updateSnapshots();
        if (updateData.updatedTurbulenceData) {
            return feesCalculator.calculateTurbulenceIndicatorPercent(updateData.totalHours, updateData.totalRounds);
        } else {
            return feesCalculator.turbulenceIndicatorPercent();
        }
    }
 
    function _calculateFundingFees(uint256 startTime, uint256 endSnapshot, uint256 positionUnitsAmount) private view returns (uint256) {
        uint256 startSnapshot = cviSnapshots[startTime];
        if (startSnapshot == 0 && address(feesModelProxy) != address(0)) {
            startSnapshot = feesModelProxy.calculateFundingFees(0, startTime, PRECISION_DECIMALS);
        }

        return endSnapshot.sub(startSnapshot).mul(positionUnitsAmount) / PRECISION_DECIMALS;
    }

    function _updateSnapshots() private view returns (SnapshotUpdate memory snapshotUpdate) {
        if (cviSnapshots[block.timestamp] != 0) { // Block was already updated
            snapshotUpdate.singleUnitFundingFee = 0;
            return snapshotUpdate;
        }

        (uint16 cviValue, uint80 periodEndRoundId, uint256 periodEndTimestamp) = cviOracle.getCVILatestRoundDataAndTimestamp();

        if (latestSnapshotTimestamp == 0) { // For first recorded block
            snapshotUpdate.newSnapshot = PRECISION_DECIMALS;
            snapshotUpdate.updatedSnapshot = true;
            snapshotUpdate.newLatestRoundId = periodEndRoundId;
            snapshotUpdate.updatedLatestRoundId = true;
            snapshotUpdate.updatedLatestTimestamp = true;
            snapshotUpdate.singleUnitFundingFee = 0;
            return snapshotUpdate;
        }

        uint256 latestTimestamp = latestSnapshotTimestamp;

        uint80 periodStartRoundId = latestOracleRoundId;
        require(periodEndRoundId >= periodStartRoundId, "Bad round id");

        uint256 totalRounds = periodEndRoundId - periodStartRoundId;

        uint256 cviValuesNum = totalRounds > 0 ? 2 : 1;
        IFeesCalculator.CVIValue[] memory cviValues = new IFeesCalculator.CVIValue[](cviValuesNum);
        
        if (totalRounds > 0) {
            (uint16 periodStartCVIValue, uint256 periodStartTimestamp) = cviOracle.getCVIRoundData(periodStartRoundId);
            uint256 timeSinceLastSnapshot = periodEndTimestamp.sub(latestTimestamp);
            cviValues[0] = IFeesCalculator.CVIValue(timeSinceLastSnapshot, periodStartCVIValue);
            cviValues[1] = IFeesCalculator.CVIValue(block.timestamp.sub(periodEndTimestamp), cviValue);
            snapshotUpdate.newLatestRoundId = periodEndRoundId;
            snapshotUpdate.updatedLatestRoundId = true;

            uint256 betweenRoundsTime = periodEndTimestamp.sub(periodStartTimestamp);
            uint256 totalHours = betweenRoundsTime / 1 hours;

            snapshotUpdate.totalHours = totalHours;
            snapshotUpdate.totalRounds = totalRounds;
            snapshotUpdate.updatedTurbulenceData = true;
        } else {
            cviValues[0] = IFeesCalculator.CVIValue(block.timestamp.sub(latestTimestamp), cviValue);
        }

        uint256 singleUnitFundingFee = feesCalculator.calculateSingleUnitFundingFee(cviValues);

        snapshotUpdate.singleUnitFundingFee = 0;
        snapshotUpdate.newSnapshot = cviSnapshots[latestTimestamp].add(singleUnitFundingFee);
        snapshotUpdate.updatedSnapshot = true;
        snapshotUpdate.updatedLatestTimestamp = true;
    }
}
