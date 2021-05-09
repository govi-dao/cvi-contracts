// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ILiquidationV2.sol";

contract LiquidationV2 is ILiquidationV2, Ownable {

    using SafeMath for uint256;

    uint8 private constant MAX_LEVERAGE = 8;
    uint16 private constant MAX_CVI_VALUE = 20000;

    uint16 public liquidationMinRewardPercent = 5;
    uint256 public constant LIQUIDATION_MAX_FEE_PERCENTAGE = 1000;

    uint16[MAX_LEVERAGE] public liquidationMinThresholdPercents = [50, 50, 100, 100, 150, 150, 200, 200];
    uint16[MAX_LEVERAGE] public liquidationMaxRewardPercents = [30, 30, 30, 30, 30, 30, 30, 30];

    function setMinLiquidationThresholdPercents(uint16[MAX_LEVERAGE] calldata _newMinThresholdPercents) external override onlyOwner {
        for (uint256 i = 0; i < MAX_LEVERAGE; i++) {
            require(_newMinThresholdPercents[i] >= liquidationMaxRewardPercents[i], "Threshold less than some max");    
        }

        liquidationMinThresholdPercents = _newMinThresholdPercents;
    }

    function setMinLiquidationRewardPercent(uint16 _newMinRewardPercent) external override onlyOwner {
        for (uint256 i = 0; i < MAX_LEVERAGE; i++) {
            require(_newMinRewardPercent <= liquidationMaxRewardPercents[i], "Min greater than some max");    
        }
        
        liquidationMinRewardPercent = _newMinRewardPercent;
    }

    function setMaxLiquidationRewardPercents(uint16[MAX_LEVERAGE] calldata _newMaxRewardPercents) external override onlyOwner {
        for (uint256 i = 0; i < MAX_LEVERAGE; i++) {
            require(_newMaxRewardPercents[i] <= liquidationMinThresholdPercents[i], "Some max greater than threshold");
            require(_newMaxRewardPercents[i] >= liquidationMinRewardPercent, "Some max less than min");
        }

        liquidationMaxRewardPercents = _newMaxRewardPercents;
    }

    function isLiquidationCandidate(uint256 _positionBalance, bool _isPositive, uint168 _positionUnitsAmount, uint16 _openCVIValue, uint8 _leverage) public view override returns (bool) {
        return (!_isPositive ||  _positionBalance < uint256(_positionUnitsAmount).mul(liquidationMinThresholdPercents[_leverage - 1]).mul(_openCVIValue).div(MAX_CVI_VALUE).div(_leverage) / LIQUIDATION_MAX_FEE_PERCENTAGE);
    }

    function getLiquidationReward(uint256 _positionBalance, bool _isPositive, uint168 _positionUnitsAmount, uint16 _openCVIValue, uint8 _leverage) external view override returns (uint256 finderFeeAmount) {
        if (!isLiquidationCandidate(_positionBalance, _isPositive, _positionUnitsAmount, _openCVIValue, _leverage)) {
            return 0;
        }

        uint256 originalBalance = uint256(_positionUnitsAmount).mul(_openCVIValue).div(MAX_CVI_VALUE).div(_leverage);
        uint256 minLiuquidationReward = originalBalance.mul(liquidationMinRewardPercent).div(LIQUIDATION_MAX_FEE_PERCENTAGE);

        if (!_isPositive || _positionBalance < minLiuquidationReward) {
            return minLiuquidationReward;
        }

        uint256 maxLiquidationReward = originalBalance.mul(liquidationMaxRewardPercents[_leverage - 1]).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
        
        if (_isPositive && _positionBalance >= minLiuquidationReward && _positionBalance <= maxLiquidationReward) {
            finderFeeAmount = _positionBalance;
        } else {
            finderFeeAmount = maxLiquidationReward;
        }
    }
}
