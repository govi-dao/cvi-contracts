// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IStakingVault {
	function withdraw(uint256 amount) external;
	function extractGOVI() external;
    function setWithdrawer(address withdrawer) external;
}