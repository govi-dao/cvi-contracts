// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/KeeperCompatibleInterface.sol";
import "./interfaces/IRequestFulfiller.sol";

abstract contract RequestFulfiller is IRequestFulfiller, OwnableUpgradeable, KeeperCompatibleInterface {

    IRequestManager public requestManager;

    bool public enableWhitelist;
    mapping (address => bool) public fulfillers;

    function initialize(IRequestManager _requestManager) external initializer {
        OwnableUpgradeable.__Ownable_init();

        enableWhitelist = true;
        requestManager = _requestManager;
    }

    function setRequestManager(IRequestManager _requestManager) external override onlyOwner {
        requestManager = _requestManager;
    }

    function setEnableWhitelist(bool _enableWhitelist) external override onlyOwner {
        enableWhitelist = _enableWhitelist;
    }

    function setFulfillerAddress(address user, bool isAllowed) external override onlyOwner {
        fulfillers[user] = isAllowed;
    }

    function checkUpkeep(bytes calldata /* checkData */) external view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256[] memory fulfillableRequestIds = isUpkeepNeeded();
        return (fulfillableRequestIds[0] != 0, abi.encode(fulfillableRequestIds));
    }

    function performUpkeep(bytes calldata performData) external override {
        uint256 startGas = gasleft();
        require(!enableWhitelist || fulfillers[msg.sender], "Not allowed");
        uint256[] memory fulfillableRequestIds = abi.decode(performData, (uint256[]));
        
        require(fulfillableRequestIds[0] != 0, "No fulfillable requests");

        bool hasAnyFulfilled = false;
        for (uint256 i = 0; i < fulfillableRequestIds.length; i++) {
            if(startGas - gasleft() > 4500000) {
                break;
            }

            uint256 requestId = fulfillableRequestIds[i];

            // Skip last item, which is always 0 (but don't assume it' s always there for safety)
            if (requestId != 0) {
                bool wasFulfilled = fulfillRequest(requestId);
                if (wasFulfilled) {
                    hasAnyFulfilled = true;
                }
            }
        }

        require(hasAnyFulfilled, "Failed to fulfill requests");
    }

    function isUpkeepNeeded() private view returns (uint256[] memory fulfillableRequestIds) {
        uint256 nextRequestId = requestManager.nextRequestId();
        uint256 maxMinRequestIncrements = requestManager.maxMinRequestIncrements();
        uint256 minRequestId = requestManager.minRequestId();

        uint256 endRequestId = nextRequestId < minRequestId + maxMinRequestIncrements ? nextRequestId : minRequestId + maxMinRequestIncrements;
        fulfillableRequestIds = new uint256[](endRequestId - minRequestId + 1); // Critical to add 1, so there will always be a 0 ending to the array (and at least 1 cell, never empty)
        uint256 currFulfillableRequestIndex = 0;
        for (uint256 currRequest = minRequestId; currRequest < endRequestId; currRequest++) {
            if (isRequestKeepersFulfillable(currRequest)) {
                fulfillableRequestIds[currFulfillableRequestIndex] = currRequest;
                currFulfillableRequestIndex++;
            }
        }
    }

    function isRequestKeepersFulfillable(uint256 _requestId) internal virtual view returns (bool isFulfillable);

    function fulfillRequest(uint256 _requestId) internal virtual returns (bool wasFulfilled);
}
