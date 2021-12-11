// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interfaces/IPositionRewards.sol";

contract PositionRewards is Initializable, IPositionRewards, OwnableUpgradeable {

    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint256 public constant PRECISION_DECIMALS = 1e10;

    mapping(address => mapping(uint32 => uint256)) public claimedPositionUnits;

    uint256 public maxClaimPeriod;
    uint256 public maxRewardTime;
    uint256 public maxRewardTimePercentageGain;

    uint256 public maxDailyReward;

    uint256 public maxSingleReward;
    uint256 public rewardMaxLinearPositionUnits;
    uint256 public rewardMaxLinearGOVI;

    uint256 public rewardFactor;

    uint256 public lastMaxSingleReward;
    uint256 public lastRewardMaxLinearPositionUnits;
    uint256 public lastRewardMaxLinearGOVI;

    uint256 public rewardCalculationValidTimestamp;

    uint256 public todayClaimedRewards;
    uint256 public lastClaimedDay;

    IERC20Upgradeable public cviToken;

    IPlatform public platform;

    function initialize(IERC20Upgradeable _cviToken) public initializer {
        OwnableUpgradeable.__Ownable_init();
        cviToken = _cviToken;

        maxClaimPeriod = 30 days;
        maxRewardTime = 3 days;
        maxRewardTimePercentageGain = 25e8;
        maxDailyReward = 2300e18;
        maxSingleReward = 800e18;
        rewardMaxLinearPositionUnits = 20e18;
        rewardMaxLinearGOVI = 100e18;
        rewardFactor = 1e13;
    }

    function calculatePositionReward(uint256 _positionUnits, uint256 _positionTimestamp) external view override returns (uint256 rewardAmount) {
        require(_positionUnits > 0, "Position units must be positive");

        uint256 factoredPositionUnits = _positionUnits * calculatePositionUnitsFactor(_positionTimestamp) / PRECISION_DECIMALS;

        rewardAmount = __calculatePositionReward(factoredPositionUnits, rewardMaxLinearPositionUnits, 
            rewardMaxLinearGOVI / rewardFactor, maxSingleReward / rewardFactor);

        if (lastRewardMaxLinearPositionUnits != 0 && lastRewardMaxLinearGOVI != 0 && lastMaxSingleReward != 0) {
            uint256 lastRewardAmount = __calculatePositionReward(factoredPositionUnits, lastRewardMaxLinearPositionUnits, 
                lastRewardMaxLinearGOVI / rewardFactor, lastMaxSingleReward / rewardFactor);

            if (rewardAmount > lastRewardAmount) {
                rewardAmount = lastRewardAmount;
            }
        }

        rewardAmount = rewardAmount * rewardFactor;
    }

    function _calculatePositionReward(uint256 _positionUnits, uint256 _positionTimestamp) private view returns (uint256 rewardAmount) {
        require(_positionUnits > 0, "Position units must be positive");

        uint256 _rewardMaxLinearPositionUnits;
        uint256 _rewardMaxLinearGOVI;
        uint256 _maxSingleReward;

        if (block.timestamp > rewardCalculationValidTimestamp) {
            _rewardMaxLinearPositionUnits = rewardMaxLinearPositionUnits;
            _rewardMaxLinearGOVI = rewardMaxLinearGOVI / rewardFactor;
            _maxSingleReward = maxSingleReward / rewardFactor;
        } else {
            _rewardMaxLinearPositionUnits = lastRewardMaxLinearPositionUnits;
            _rewardMaxLinearGOVI = lastRewardMaxLinearGOVI / rewardFactor;
            _maxSingleReward = lastMaxSingleReward / rewardFactor;
        }

        uint256 factoredPositionUnits = _positionUnits * calculatePositionUnitsFactor(_positionTimestamp) / PRECISION_DECIMALS;

        rewardAmount = __calculatePositionReward(factoredPositionUnits, _rewardMaxLinearPositionUnits, _rewardMaxLinearGOVI, _maxSingleReward);
        rewardAmount = rewardAmount * rewardFactor;
        require(rewardAmount <= _maxSingleReward * rewardFactor, "Reward too big");
    }

    function __calculatePositionReward(uint256 factoredPositionUnits, uint256 _rewardMaxLinearPositionUnits, uint256 _rewardMaxLinearGOVI, uint256 _maxSingleReward) private pure returns (uint256 rewardAmount) {
        if (factoredPositionUnits <= _rewardMaxLinearPositionUnits) {
            rewardAmount = factoredPositionUnits * _rewardMaxLinearGOVI / _rewardMaxLinearPositionUnits;
        } else {
            (uint256 alpha, uint256 beta, uint256 gamma) = calculateAlphaBetaGamma(_maxSingleReward, _rewardMaxLinearPositionUnits, _rewardMaxLinearGOVI);

            // reward = c - (alpha / ((x + beta)^2 + gamma)
            uint256 betaPlusFactoredPositionUnits = beta + factoredPositionUnits;

            rewardAmount = _maxSingleReward - (alpha / (betaPlusFactoredPositionUnits ** 2 + gamma));
        }
    }

    function claimReward() external override {
        require(address(platform) != address(0), "Platform not set");

        (uint256 positionUnitsAmount, uint8 leverage,, uint32 creationTimestamp, uint32 originalCreationTimestamp) = platform.positions(msg.sender);
        require(positionUnitsAmount > 0, "No opened position");
        require(block.timestamp <= creationTimestamp + maxClaimPeriod, "Claim too late");

        uint256 today = block.timestamp / 1 days;
        require(today > creationTimestamp / 1 days, "Claim too early");

        // Reward position units will be the min from currently open and currently available
        // This resolves the issue of claiming after a merge
        uint32 positionDay = originalCreationTimestamp / 1 days;
        uint256 claimedPositions = claimedPositionUnits[msg.sender][positionDay];

        require (claimedPositions < positionUnitsAmount / leverage, "No reward");
        uint256 rewardPositionUnits = positionUnitsAmount / leverage - claimedPositions;

        uint256 rewardAmount = _calculatePositionReward(rewardPositionUnits, creationTimestamp);
        uint256 _maxDailyReward = maxDailyReward;

        uint256 updatedDailyClaimedReward = 0;

        if (today > lastClaimedDay) {
            lastClaimedDay = today;
        } else {
            updatedDailyClaimedReward = todayClaimedRewards;
        }

        updatedDailyClaimedReward = updatedDailyClaimedReward + rewardAmount;

        require(updatedDailyClaimedReward <= _maxDailyReward, "Daily reward spent");

        todayClaimedRewards = updatedDailyClaimedReward;
        claimedPositionUnits[msg.sender][positionDay] = claimedPositions + rewardPositionUnits;

        emit Claimed(msg.sender, rewardAmount);
        cviToken.safeTransfer(msg.sender, rewardAmount);
    }

    function setMaxDailyReward(uint256 _newMaxDailyReward) external override onlyOwner {
        maxDailyReward = _newMaxDailyReward;
    }

    function setRewardCalculationParameters(uint256 _newMaxSingleReward, uint256 _rewardMaxLinearPositionUnits, uint256 _rewardMaxLinearGOVI) external override onlyOwner {
        require(_newMaxSingleReward > 0, "Max reward must be positive");
        require(_rewardMaxLinearPositionUnits > 0, "Max linear x must be positive");
        require(_rewardMaxLinearGOVI > 0, "Max linear y must be positive");

        // Makes sure alpha and beta values for new values are positive
        calculateAlphaBetaGamma(_newMaxSingleReward / rewardFactor, _rewardMaxLinearPositionUnits, _rewardMaxLinearGOVI / rewardFactor);

        lastRewardMaxLinearPositionUnits = rewardMaxLinearPositionUnits;
        rewardMaxLinearPositionUnits = _rewardMaxLinearPositionUnits;

        lastRewardMaxLinearGOVI = rewardMaxLinearGOVI;
        rewardMaxLinearGOVI = _rewardMaxLinearGOVI;

        lastMaxSingleReward = maxSingleReward;
        maxSingleReward = _newMaxSingleReward;

        rewardCalculationValidTimestamp = block.timestamp + maxClaimPeriod;
    }

    function setRewardFactor(uint256 _newRewardFactor) external override onlyOwner {
        rewardFactor = _newRewardFactor;
    }

    function setMaxClaimPeriod(uint256 _newMaxClaimPeriod) external override onlyOwner {
        maxClaimPeriod = _newMaxClaimPeriod;
    }

    function setMaxRewardTime(uint256 _newMaxRewardTime) external override onlyOwner {
        require (_newMaxRewardTime > 0, "Max reward time not positive");
        maxRewardTime = _newMaxRewardTime;
    }

    function setMaxRewardTimePercentageGain(uint256 _newMaxRewardTimePercentageGain) external override onlyOwner {
        maxRewardTimePercentageGain = _newMaxRewardTimePercentageGain;
    }

    function setPlatform(IPlatform _newPlatform) external override onlyOwner {
        platform = _newPlatform;
    }

    function extractRewards() external override onlyOwner {
        cviToken.safeTransfer(msg.sender, cviToken.balanceOf(address(this)));
    }

    function calculateAlphaBetaGamma(uint256 _maxSingleReward, uint256 _rewardMaxLinearX, uint256 _rewardMaxLinearY) private pure returns (uint256 alpha, uint256 beta, uint256 gamma) {
        // beta = c / a (a = y0/x0)
        beta = _maxSingleReward * _rewardMaxLinearX / _rewardMaxLinearY;

        // alpha = (2 * c ^ 2 * beta) / a (a = y0/x0)
        alpha = 2 * _maxSingleReward ** 2 * beta * _rewardMaxLinearX / _rewardMaxLinearY;

        // gamma = (2 * c * beta - a * beta ^ 2) / a (a=y0/x0)
        gamma = 2 * _maxSingleReward * beta * _rewardMaxLinearX / _rewardMaxLinearY - beta ** 2;

        require(alpha > 0, "Alpha must be positive");
        require(beta > 0, "Beta must be positive");
        require(gamma > 0, "Gamma must be positive");
    }

    function calculatePositionUnitsFactor(uint256 _positionTimestamp) private view returns (uint256) {
        uint256 _maxRewardTime = maxRewardTime;
        uint256 time = block.timestamp - _positionTimestamp;

        if (time > _maxRewardTime) {
            time = _maxRewardTime;
        }

        return PRECISION_DECIMALS + (time * maxRewardTimePercentageGain / _maxRewardTime);
    }
}