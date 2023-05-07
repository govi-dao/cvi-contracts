// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8;

import "./RequestFulfiller.sol";
import "./interfaces/IThetaVault.sol";

contract ThetaVaultRequestFulfiller is RequestFulfiller {

    uint8 public constant DEPOSIT_REQUEST_TYPE = 1;
    uint8 public constant WITHDRAW_REQUEST_TYPE = 2;

    function isRequestKeepersFulfillable(uint256 _requestId) internal view override returns (bool isFulfillable) {
        (,, uint32 targetTimestamp, address owner,) = IThetaVault(address(requestManager)).requests(_requestId);
        if (owner != address(0) && block.timestamp >= targetTimestamp) {
            isFulfillable = true;
        }
    }

    function fulfillRequest(uint256 _requestId) internal override returns (bool wasFulfilled) {
        IThetaVault thetaVault = IThetaVault(address(requestManager));

        (uint8 requestType,,,,) = thetaVault.requests(_requestId);

        if (requestType == DEPOSIT_REQUEST_TYPE) {
            thetaVault.fulfillDepositRequest(_requestId);
        } else if (requestType == WITHDRAW_REQUEST_TYPE) {
            thetaVault.fulfillWithdrawRequest(_requestId);
        }

        wasFulfilled = true;
    }
}
