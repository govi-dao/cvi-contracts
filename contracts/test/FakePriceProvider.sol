// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "../interfaces/AggregatorV3Interface.sol";

contract FakePriceProvider is AggregatorV3Interface {
    uint256 public price;
    uint80 public roundId;
    uint8 public override decimals = 8;
    uint256 public override version = 0;

    mapping(uint80 => uint256) private prices;
    mapping(uint80 => uint256) private timestamps;

    constructor(uint256 _price) {
        price = _price;
        roundId = 1;
        prices[roundId] = price;
    }

    function setPrice(uint256 _price) external {
        roundId = roundId + 1;
        price = _price;
        prices[roundId] = price;
        timestamps[roundId] = block.timestamp;
    }

    function getRoundData(uint80 requestedRoundId) external override view returns (uint80 roundIdAnswer, int256 answer, uint256 startAnswerTimestamp, uint256 answerTimestamp, uint80 answeredInRound) {
        roundIdAnswer = requestedRoundId;
        answer = int(prices[requestedRoundId]);
        answerTimestamp = timestamps[requestedRoundId];
        startAnswerTimestamp = answerTimestamp;
        answeredInRound = requestedRoundId;
    }

    function description() external pure override returns(string memory) {
        return "Test implementation";
    }

    function latestAnswer() external view returns(int result) {
        (, result, , , ) = latestRoundData();
    }

    function latestRoundData()
        public
        override
        view
        returns (
            uint80 roundIdAnswer,
            int256 answer,
            uint256 startedAt,
            uint256 answerTimestamp,
            uint80 answeredInRound
        )
    {
        answer = int(price);
        roundIdAnswer = roundId;
        answerTimestamp = timestamps[roundId];
        startedAt = answerTimestamp;
        answeredInRound = roundId;
    }
}