// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;

import "../v1/interfaces/AggregatorV3Interface.sol";

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
    }

    function description() external view override returns(string memory) {
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
            uint256,
            uint256 answerTimestamp,
            uint80
        )
    {
        answer = int(price);
        roundIdAnswer = roundId;
        answerTimestamp = timestamps[roundId];
    }
}