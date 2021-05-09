// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

import "../v1/interfaces/AggregatorV2V3Interface.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CVI Feed Oracle beta phase
 * @notice Based on the Chainlink FluxAggregator contract
 */
contract CVIFeedOracle is AggregatorV2V3Interface, Ownable {
  uint256 constant public override version = 0;

  uint8 public override decimals;
  int256 public override latestAnswer;
  uint256 public override latestTimestamp;
  uint256 public override latestRound;

  mapping(uint256 => int256) public override getAnswer;
  mapping(uint256 => uint256) public override getTimestamp;
  mapping(uint256 => uint256) private getStartedAt;

  constructor(
    uint8 _decimals,
    int256 _initialAnswer
  ) {
    decimals = _decimals;
    updateAnswer(_initialAnswer);
  }

  function updateAnswer(
    int256 _answer
  ) public onlyOwner {
    latestAnswer = _answer;
    latestTimestamp = block.timestamp;
    latestRound++;
    getAnswer[latestRound] = _answer;
    getTimestamp[latestRound] = block.timestamp;
    getStartedAt[latestRound] = block.timestamp;

    emit AnswerUpdated(_answer, latestRound, block.timestamp);
  }

  function updateRoundData(
    uint80 _roundId,
    int256 _answer,
    uint256 _timestamp,
    uint256 _startedAt
  ) public onlyOwner {
    latestRound = _roundId;
    latestAnswer = _answer;
    latestTimestamp = _timestamp;
    getAnswer[latestRound] = _answer;
    getTimestamp[latestRound] = _timestamp;
    getStartedAt[latestRound] = _startedAt;
  }

  function getRoundData(uint80 _roundId)
    external
    view
    override
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    )
  {
    return (
      _roundId,
      getAnswer[_roundId],
      getStartedAt[_roundId],
      getTimestamp[_roundId],
      _roundId
    );
  }

  function latestRoundData()
    external
    view
    override
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    )
  {
    return (
      uint80(latestRound),
      getAnswer[latestRound],
      getStartedAt[latestRound],
      getTimestamp[latestRound],
      uint80(latestRound)
    );
  }

  function setLatestRound(uint256 _latestRound) public onlyOwner {
    latestRound = _latestRound;
  }

  function description()
    external
    view
    override
    returns (string memory)
  {
    return "CVI Feed Oracle";
  }
}