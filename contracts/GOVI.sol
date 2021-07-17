// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract GOVI is ERC20, Ownable {
  constructor() ERC20("GOVI", "GOVI") {
    _mint(msg.sender, 32000000e18); // 32 million
  }
}
