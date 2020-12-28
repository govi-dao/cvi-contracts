// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./utils/SafeMath16.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ILiquidation.sol";

contract Liquidation is ILiquidation, Ownable {

    using SafeMath for uint256;
    using SafeMath16 for uint16;

    uint16 private liquidationMinThreshold = 50;
    uint16 private liquidationMinRewardAmount = 5;
    uint16 private liquidationMaxRewardAmount = 30;

    uint256 public constant LIQUIDATION_MAX_FEE_PERCENTAGE = 1000;

    function setMinLiquidationThreshold(uint16 _newMinThreshold) external override onlyOwner {
        liquidationMinThreshold = _newMinThreshold;
    }

    function setMinLiquidationReward(uint16 _newMinRewardAmount) external override onlyOwner {
        liquidationMinRewardAmount = _newMinRewardAmount;
    }

    function setMaxLiquidationReward(uint16 _newMaxRewardAmount) external override onlyOwner {
        liquidationMaxRewardAmount = _newMaxRewardAmount;
    }

    function isLiquidationCandidate(uint256 positionBalance, bool isPositive, uint256 positionUnitsAmount) public view override returns (bool) {
        return (!isPositive ||  positionBalance < positionUnitsAmount.mul(liquidationMinThreshold).div(LIQUIDATION_MAX_FEE_PERCENTAGE));
    }

    function getLiquidationReward(uint256 positionBalance, bool isPositive, uint256 positionUnitsAmount) external view override returns (uint256 finderFeeAmount) {
        if (!isPositive || positionBalance < positionUnitsAmount.mul(liquidationMinThreshold).div(LIQUIDATION_MAX_FEE_PERCENTAGE) ) {
            return positionUnitsAmount.mul(liquidationMinRewardAmount).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
        }
        
        if (isPositive && positionBalance >= positionUnitsAmount.mul(liquidationMinThreshold).div(LIQUIDATION_MAX_FEE_PERCENTAGE) && positionBalance <= positionUnitsAmount.mul(liquidationMaxRewardAmount).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) {
            finderFeeAmount = positionBalance;
        } else {
            finderFeeAmount = positionUnitsAmount.mul(liquidationMaxRewardAmount).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
        }
    }
}
