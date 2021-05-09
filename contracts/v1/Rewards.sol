// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IRewards.sol";

contract Rewards is IRewards, Ownable {

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    mapping(address => mapping(uint256 => uint256)) public dailyPerAddressReward;
    mapping(uint256 => uint256) public totalRewardsPerDay;
    mapping(uint256 => uint256) public dailyRewards;

    IERC20 private immutable cviToken;

    uint256 private dailyReward = 165_000e18;
    address public rewarder;

    constructor(IERC20 _cviToken) {
        cviToken = _cviToken;
    }

    modifier onlyRewarder {
        require(msg.sender == rewarder, "Not allowed");
        _;
    }

    function reward(address _account, uint256 _positionUnits) external override onlyRewarder {
        require(_positionUnits > 0, "Position units must be positive");

        uint256 today = block.timestamp / 1 days;

        if (dailyRewards[today] == 0) {
            dailyRewards[today] = dailyReward;
        }

        totalRewardsPerDay[today] = totalRewardsPerDay[today].add(_positionUnits);
        dailyPerAddressReward[_account][today] = dailyPerAddressReward[_account][today].add(_positionUnits);
    }

    function claimReward(uint256[] memory _openPositionDays) external override {
        require(_openPositionDays.length > 0, "No days provided");
        for (uint256 i = 0; i < _openPositionDays.length; i++) {
            _claimReward(_openPositionDays[i]);
        }
    }

    function _claimReward(uint256 _openPositionDay) internal {
        uint256 today = block.timestamp / 1 days;
        require(today > _openPositionDay, "Open day is today or future");

        uint256 userRewardPart = dailyPerAddressReward[msg.sender][_openPositionDay];
        require(userRewardPart > 0, "No reward");

        uint256 rewardAmount = userRewardPart.mul(dailyRewards[_openPositionDay]).div(totalRewardsPerDay[_openPositionDay]);
        dailyPerAddressReward[msg.sender][_openPositionDay] = 0;

        cviToken.safeTransfer(msg.sender, rewardAmount);
    }

    function setRewarder(address _newRewarder) external override onlyOwner {
        rewarder = _newRewarder;
    }

    function setDailyReward(uint256 _newDailyReward) external override onlyOwner {
        dailyReward = _newDailyReward;
    }
}