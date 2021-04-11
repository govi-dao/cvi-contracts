// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IFactorRewards.sol";

contract FactorRewards is IFactorRewards, Ownable {

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 public constant PRECISION_DECIMALS = 100000;

    IERC20 private immutable cviToken;

    IPlatformV2 public platform;

    uint256 public dailyReward = 2300e18;
    uint256 public maxClaimPeriod = 30 days;

    uint256 public rewardsFactor = PRECISION_DECIMALS;
    uint256 public lastRewardsFactor;
    uint256 public rewardsFactorValidTimestamp;

    mapping(address => mapping(uint256 => uint256)) public claimedPositionUnits;
    mapping(uint256 => uint256) public totalRewardsPerDay;

    constructor(IERC20 _cviToken) public {
        cviToken = _cviToken;
    }

    function claimReward() external override {
        uint256 today = block.timestamp / 1 days;

        require(address(platform) != address(0), "Platform not set");

        //TODO: Handle leverage
        (uint256 positionUnitsAmount, uint8 leverage, uint16 openCVI, uint256 creationTimestamp, uint256 originalCreationTimestamp) = platform.positions(msg.sender);
        require(positionUnitsAmount != 0, "No position units");
        require(block.timestamp <= creationTimestamp + maxClaimPeriod, "Claim too late");

        uint256 currDailyRewardGiven = totalRewardsPerDay[today];
        uint256 currDailyReward = dailyReward;
        require(currDailyRewardGiven < currDailyReward, "Daily reward spent");

        uint256 currRewardFactor = block.timestamp > rewardsFactorValidTimestamp ? rewardsFactor : lastRewardsFactor;
        uint256 rewardAmount = positionUnitsAmount.mul(currRewardFactor) / PRECISION_DECIMALS;

        if (currDailyRewardGiven.add(rewardAmount) > currDailyReward) {
            rewardAmount = currDailyReward.sub(currDailyRewardGiven);
        }

        uint256 currClaimedPositionUnits = claimedPositionUnits[msg.sender][originalCreationTimestamp];
        require(positionUnitsAmount > currClaimedPositionUnits, "Available reward already claimed");

        rewardAmount = (positionUnitsAmount - currClaimedPositionUnits).mul(currRewardFactor) / PRECISION_DECIMALS;
        claimedPositionUnits[msg.sender][originalCreationTimestamp] = currClaimedPositionUnits.add(positionUnitsAmount - currClaimedPositionUnits);
        totalRewardsPerDay[today] = currDailyRewardGiven.add(rewardAmount);

        cviToken.safeTransfer(msg.sender, rewardAmount);
    }

    function setPlatform(IPlatformV2 _newPlatform) external override onlyOwner {
        platform = _newPlatform;
    }

    function setDailyReward(uint256 _newDailyReward) external override onlyOwner {
        dailyReward = _newDailyReward;
    }

    function setRewardsFactor(uint256 _newRewardsFactor) external override onlyOwner {
        lastRewardsFactor = rewardsFactor;
        rewardsFactor = _newRewardsFactor;
        rewardsFactorValidTimestamp = block.timestamp.add(maxClaimPeriod);
    }

    function setMaxClaimPeriod(uint256 _newMaxClaimPeriod) external override onlyOwner {
        maxClaimPeriod = _newMaxClaimPeriod;
    }
}