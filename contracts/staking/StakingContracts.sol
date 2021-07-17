// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./StakingRewards.sol";

contract USDTLPStakingRewards is StakingRewards {
    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken
    ) StakingRewards(_owner, _rewardsDistribution, _rewardsToken, _stakingToken) {}
}

contract ETHLPStakingRewards is StakingRewards {
    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken
    ) StakingRewards(_owner, _rewardsDistribution, _rewardsToken, _stakingToken) {}
}

contract COTIETHStakingRewards is StakingRewards {
    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken
    ) StakingRewards(_owner, _rewardsDistribution, _rewardsToken, _stakingToken) {}
}

contract COTIETHSLPStakingRewards is StakingRewards {
    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken
    ) StakingRewards(_owner, _rewardsDistribution, _rewardsToken, _stakingToken) {}
}

contract GOVIETHStakingRewards is StakingRewards {
    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken
    ) StakingRewards(_owner, _rewardsDistribution, _rewardsToken, _stakingToken) {}
}

contract GOVIETHSLPStakingRewards is StakingRewards {
    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsToken,
        address _stakingToken
    ) StakingRewards(_owner, _rewardsDistribution, _rewardsToken, _stakingToken) {}
}
