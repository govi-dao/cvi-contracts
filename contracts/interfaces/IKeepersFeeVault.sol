// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IKeepersFeeVault {
	function extractUSDC() external;
    function setExtractor(address extractor) external;
}