// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./IRequestManager.sol";

interface IRequestFulfiller {
    function setRequestManager(IRequestManager requestManager) external;
    function setEnableWhitelist(bool enableWhitelist) external;
    function setFulfillerAddress(address user, bool isAllowed) external;
}
