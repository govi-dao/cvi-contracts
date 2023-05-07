// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./../interfaces/ITreasury.sol";

contract Treasury is ITreasury, Ownable {

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {

    }

	function extract() external override onlyOwner {
        payable(msg.sender).transfer(address(this).balance);
    }
}