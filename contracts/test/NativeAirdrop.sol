// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";

contract NativeAirdrop is Ownable {
    receive() external payable {
    }
      /**
     * @dev admin function to bulk distribute to users 
     */
    function distribute(address payable[] memory addresses, uint256[] memory amounts) public onlyOwner {
        uint256 numAddresses = addresses.length;
        uint256 numAmounts = amounts.length;
        require(numAddresses == numAmounts, "Invalid parameters");

        for (uint256 i = 0; i < addresses.length; i++) {
            require(amounts[i] > 0, "Invalid transfer amount");
            require(addresses[i] != address(0), "Invalid destination address");
            addresses[i].transfer(amounts[i]);
        }

    }
}