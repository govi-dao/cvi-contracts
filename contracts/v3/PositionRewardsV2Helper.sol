// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./PositionRewardsV2.sol";

contract PositionRewardsV2Helper {

    using SafeMath for uint256;

    PositionRewardsV2 private positionRewards;

    constructor(PositionRewardsV2 _positionRewards) {
        positionRewards = _positionRewards;
    }

    function calculatePositionReward(uint256 _positionUnits, uint256 _positionTimestamp) external view returns (uint256 rewardAmount) {
        require(_positionUnits > 0, "Position units must be positive");

        uint256 rewardFactor = positionRewards.rewardFactor();
        uint256 factoredPositionUnits = _positionUnits.mul(calculatePositionUnitsFactor(_positionTimestamp)) / positionRewards.PRECISION_DECIMALS();

        rewardAmount = _calculatePositionReward(factoredPositionUnits, positionRewards.rewardMaxLinearPositionUnits(), 
            positionRewards.rewardMaxLinearGOVI().div(rewardFactor), positionRewards.maxSingleReward().div(rewardFactor));

        if (positionRewards.lastRewardMaxLinearPositionUnits() != 0 && positionRewards.lastRewardMaxLinearGOVI() != 0 && positionRewards.lastMaxSingleReward() != 0) {
            uint256 lastRewardAmount = _calculatePositionReward(factoredPositionUnits, positionRewards.lastRewardMaxLinearPositionUnits(), 
                positionRewards.lastRewardMaxLinearGOVI().div(rewardFactor), positionRewards.lastMaxSingleReward().div(rewardFactor));

            if (rewardAmount > lastRewardAmount) {
                rewardAmount = lastRewardAmount;
            }
        }

        rewardAmount = rewardAmount.mul(rewardFactor);
    }

    function _calculatePositionReward(uint256 factoredPositionUnits, uint256 _rewardMaxLinearPositionUnits, uint256 _rewardMaxLinearGOVI, uint256 _maxSingleReward) private view returns (uint256 rewardAmount) {
        if (factoredPositionUnits <= _rewardMaxLinearPositionUnits) {
            rewardAmount = factoredPositionUnits.mul(_rewardMaxLinearGOVI) / _rewardMaxLinearPositionUnits;
        } else {
            (uint256 alpha, uint256 beta, uint256 gamma) = calculateAlphaBetaGamma(_maxSingleReward, _rewardMaxLinearPositionUnits, _rewardMaxLinearGOVI);

            // reward = c - (alpha / ((x + beta)^2 + gamma)
            uint256 betaPlusFactoredPositionUnits = beta.add(factoredPositionUnits);

            rewardAmount = _maxSingleReward.sub(alpha.div(betaPlusFactoredPositionUnits.mul(betaPlusFactoredPositionUnits).add(gamma)));
        }
    }

    function calculateAlphaBetaGamma(uint256 _maxSingleReward, uint256 _rewardMaxLinearX, uint256 _rewardMaxLinearY) private pure returns (uint256 alpha, uint256 beta, uint256 gamma) {
        // beta = c / a (a = y0/x0)
        beta = _maxSingleReward.mul(_rewardMaxLinearX) / _rewardMaxLinearY;

        // alpha = (2 * c ^ 2 * beta) / a (a = y0/x0)
        alpha = _maxSingleReward.mul(_maxSingleReward).mul(2).mul(beta).mul(_rewardMaxLinearX) / _rewardMaxLinearY;

        // gamma = (2 * c * beta - a * beta ^ 2) / a (a=y0/x0)
        gamma = (_maxSingleReward.mul(2).mul(beta).mul(_rewardMaxLinearX) / _rewardMaxLinearY).sub(beta.mul(beta));

        require(alpha > 0, "Alpha must be positive");
        require(beta > 0, "Beta must be positive");
        require(gamma > 0, "Gamma must be positive");
    }

    function calculatePositionUnitsFactor(uint256 _positionTimestamp) private view returns (uint256) {
        uint256 _maxRewardTime = positionRewards.maxRewardTime();
        uint256 time = block.timestamp.sub(_positionTimestamp);

        if (time > _maxRewardTime) {
            time = _maxRewardTime;
        }

        return positionRewards.PRECISION_DECIMALS().add(time.mul(positionRewards.maxRewardTimePercentageGain()) / _maxRewardTime);
    }
}
