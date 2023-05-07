// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../external/IUniswapV2Router02.sol";
import "../interfaces/IInbox.sol";

contract ExtractorInbox is IInbox {
    using SafeERC20 for IERC20;

    address public immutable newFeesCollectorAddress;

    constructor(address _newFeesCollectorAddress) {
        newFeesCollectorAddress = _newFeesCollectorAddress;
    }

    receive() external payable {

    }

    function createRetryableTicket(
        address /* destAddr */,
        uint256 /* arbTxCallValue */,
        uint256 /* maxSubmissionCost */,
        address /* submissionRefundAddress */,
        address /* valueRefundAddress */,
        uint256 /* maxGas */,
        uint256 /* gasPriceBid */,
        bytes calldata /* data */
    ) external payable override returns (uint256) {
        (bool sent,) = newFeesCollectorAddress.call{value: msg.value}("");
        require(sent, "Failed to send Ether");
        return 0;
    }
}