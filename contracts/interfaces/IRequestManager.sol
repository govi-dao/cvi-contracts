// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IRequestManager {

	function nextRequestId() external view returns (uint256);
    function minRequestId() external view returns (uint256);
    function maxMinRequestIncrements() external view returns (uint256);
}
