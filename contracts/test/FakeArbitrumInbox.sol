// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./../interfaces/IInbox.sol";

contract FakeArbitrumInbox is IInbox {

    uint256 public submissionCost = 0.001 ether;

    constructor() {
    }

    receive() external payable {

    }

    function setSubmissionCost(uint256 _newSubmissionCost) external {
        submissionCost = _newSubmissionCost;
    }

    function createRetryableTicket(
        address destAddr,
        uint256 arbTxCallValue,
        uint256 maxSubmissionCost,
        address submissionRefundAddress,
        address /*valueRefundAddress*/,
        uint256 /*maxGas*/,
        uint256 /*gasPriceBid*/,
        bytes calldata /*data*/
    ) external payable override returns (uint256) {
        require(msg.value - maxSubmissionCost == arbTxCallValue, "Bad parameters");

    	uint256 transferAmount = msg.value - maxSubmissionCost;
    	uint256 submissionLeftOver = maxSubmissionCost - submissionCost;

    	payable(destAddr).transfer(transferAmount);
    	payable(submissionRefundAddress).transfer(submissionLeftOver);

    	return 0;
    }
}
