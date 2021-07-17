// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity ^0.8;

import "../ElasticToken.sol";

contract TestElasticToken is ElasticToken {

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        ElasticToken.__ElasticToken_init(name_, symbol_, decimals_);

        scalingFactor = SCALING_FACTOR_DECIMALS;
    }

    function mint(address to, uint256 amount) public validRecipient(to) {
        _mint(to, amount);
    }

    function burn(address to, uint256 amount) public validRecipient(to) {
        _burn(to, amount);
    }

    function sclingFactor() public view returns (uint256) {
        return scalingFactor;
    }
}
