// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/KeeperCompatibleInterface.sol";
import "./interfaces/IRebaser.sol";

contract Rebaser is IRebaser, Ownable, KeeperCompatibleInterface {
    IVolatilityToken public volatilityToken;
    IUniswapV2Pair[] public pairs;

    uint256 public lastUpkeepTime;
    uint32 public upkeepInterval = 1 days;
    uint32 public upkeepTimeWindow = 15 minutes;

    bool public enableWhitelist = true;
    mapping (address => bool) public rebasers; // whitelist

    constructor(IVolatilityToken _volatilityToken, IUniswapV2Pair[] memory _uniswapPairs) {
        volatilityToken = _volatilityToken;
        pairs = _uniswapPairs;
        lastUpkeepTime = (block.timestamp / 1 days) * 1 days; // 12 AM at the day of deployment
    }

    function rebase() public override {
        require(!enableWhitelist || rebasers[msg.sender], "Whitelisted addresses only");
        require(address(volatilityToken) != address(0), "Set volatility token");
        require(block.timestamp % 1 days <= upkeepTimeWindow, "Bad time window");
        volatilityToken.rebaseCVI();
        for (uint16 i = 0; i < pairs.length; i++) {
            if (address(pairs[i]) != address(0)) {
                pairs[i].sync();
            }
        }
    }

    function setVolatilityToken(IVolatilityToken _volatilityToken) external override onlyOwner {
        volatilityToken = _volatilityToken;
    }

    function setUniswapPairs(IUniswapV2Pair[] calldata _uniswapPairs) external override onlyOwner {
        pairs = _uniswapPairs;
    }

    function setUpkeepInterval(uint32 _upkeepInterval) external override onlyOwner {
        upkeepInterval = _upkeepInterval;
    }

    function setUpkeepTimeWindow(uint32 _upkeepTimeWindow) external override onlyOwner {
        upkeepTimeWindow = _upkeepTimeWindow;
    }

    function setEnableWhitelist(bool _enableWhitelist) external override onlyOwner {
        enableWhitelist = _enableWhitelist;
    }

    function setRebaserAddress(address user, bool isAllowed) external override onlyOwner {
        rebasers[user] = isAllowed;
    }

    function checkUpkeep(
        bytes calldata /* checkData */
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        upkeepNeeded = isUpkeepNeeded();
        return (upkeepNeeded, performData);
    }

    function performUpkeep(
        bytes calldata /* performData */
    ) external override {
        require(!enableWhitelist || rebasers[msg.sender], "Whitelisted addresses only");
        require(isUpkeepNeeded(), "Bad time window");
        lastUpkeepTime = (block.timestamp / 1 days) * 1 days;
        rebase();
    }

    function isUpkeepNeeded() private view returns (bool) {
        return block.timestamp - lastUpkeepTime >= upkeepInterval && block.timestamp % 1 days <= upkeepTimeWindow;
    }
}
