// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IKeepersFeeVault.sol";

contract KeepersFeeVault is IKeepersFeeVault, Ownable {

	using SafeERC20 for IERC20;

	IERC20 public usdcToken;
	address public extractor;

	constructor(IERC20 _usdcToken) {
        usdcToken = _usdcToken;
    }

	function extractUSDC() external override {
		require(msg.sender == extractor, "Not allowed");

        uint256 balance = usdcToken.balanceOf(address(this));
        require(balance > 0, "No funds");

    	usdcToken.safeTransfer(msg.sender, balance);
    }

    function setExtractor(address _newExtractor) external override onlyOwner {
    	extractor = _newExtractor;
    }
}
