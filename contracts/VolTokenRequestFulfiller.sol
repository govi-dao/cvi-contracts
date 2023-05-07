// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8;

import "./RequestFulfiller.sol";
import "./interfaces/IVolatilityToken.sol";

contract VolTokenRequestFulfiller is RequestFulfiller {

    uint8 public constant MINT_REQUEST_TYPE = 1;
    uint8 public constant BURN_REQUEST_TYPE = 2;

    function isRequestKeepersFulfillable(uint256 _requestId) internal view override returns (bool isFulfillable) {
         (,,,, address owner,, uint32 targetTimestamp, bool useKeepers,) = IVolatilityToken(address(requestManager)).requests(_requestId);
        if (owner != address(0) && useKeepers && block.timestamp >= targetTimestamp) {
            isFulfillable = true;
        }
    }

    function fulfillRequest(uint256 _requestId) internal override returns (bool wasFulfilled) {
        IVolatilityToken volatilityToken = IVolatilityToken(address(requestManager));

        (uint8 requestType,,,,,,,, uint16 maxBuyingPremiumFeePercentage) = volatilityToken.requests(_requestId);

        if (requestType == MINT_REQUEST_TYPE) {
            (, bool success) = volatilityToken.fulfillMintRequest(_requestId, maxBuyingPremiumFeePercentage, true);
            if (success) {
                wasFulfilled = true;
            }
        } else if (requestType == BURN_REQUEST_TYPE) {
            volatilityToken.fulfillBurnRequest(_requestId, true);
            wasFulfilled = true;
        }
    }
}
