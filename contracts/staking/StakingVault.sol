// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./../interfaces/IStakingVault.sol";

contract StakingVault is IStakingVault, Ownable {

	using SafeERC20 for IERC20;

	IERC20 public goviToken;
	address public withdrawer;

	constructor(IERC20 _goviToken) {
        goviToken = _goviToken;
    }

	function withdraw(uint256 amount) external override {
		require(msg.sender == withdrawer, "Not allowed");
		goviToken.transfer(msg.sender, amount);
	}

	function extractGOVI() external override onlyOwner {
    	goviToken.transfer(msg.sender, goviToken.balanceOf(address(this)));
    }

    function setWithdrawer(address _newWithdrawer) external override onlyOwner {
    	withdrawer = _newWithdrawer;
    }
}