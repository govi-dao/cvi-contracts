// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IRequestFeesCalculator.sol";

contract RequestFeesCalculator is IRequestFeesCalculator, Ownable {

	uint168 public constant MAX_FEE_PERCENTAGE = 10000;

	uint32 public minTimeWindow = 1 hours;
	uint32 public maxTimeWindow = 3 hours;

	uint16 public minTimeDelayFeePercent = 0;
	uint16 public maxTimeDelayFeePercent = 100;

	uint32 public override minWaitTime = 15 minutes;

	uint16 public beforeTargetTimeMaxPenaltyFeePercent = 300;
	uint16 public afterTargetMidTimePenaltyFeePercent = 300;
	uint16 public afterTargetMaxTimePenaltyFeePercent = 500;

	uint16 public findersFeePercent = 5000;

    uint16 public keepersFeePercent = 100;
    uint256 public keepersFeeMax = 4e6;

	uint32 public afterTargetMidTime = 1 hours;
	uint32 public afterTargetMaxTime = 12 hours;

	function calculateTimePenaltyFee(IVolatilityToken.Request calldata _request) external view override returns (uint16 feePercentage) {
		feePercentage = afterTargetMaxTimePenaltyFeePercent;

		if (block.timestamp < _request.targetTimestamp) {
			// Linear decreasing between beforeTargetTimeMaxPenaltyFeePercent and 0
            require(block.timestamp >= _request.requestTimestamp + minWaitTime, "Min wait time not over");
			feePercentage = uint16((_request.targetTimestamp - block.timestamp) * beforeTargetTimeMaxPenaltyFeePercent / (_request.targetTimestamp - _request.requestTimestamp - minWaitTime));
		} else if (block.timestamp < _request.targetTimestamp + afterTargetMidTime) {
			// Linear increasing between 0 and afterTargetMidTimePenaltyFeePercent
			feePercentage = uint16((block.timestamp - _request.targetTimestamp) * afterTargetMidTimePenaltyFeePercent / afterTargetMidTime);
		} else if (block.timestamp < _request.targetTimestamp + afterTargetMaxTime) {
			// Between afterTargetMidTimePenaltyFeePercent and afterTargetMaxTimePenaltyFeePercent
			feePercentage = uint16(((block.timestamp - _request.targetTimestamp - afterTargetMidTime) * (afterTargetMaxTimePenaltyFeePercent - afterTargetMidTimePenaltyFeePercent) / 
                (afterTargetMaxTime - afterTargetMidTime)) + afterTargetMidTimePenaltyFeePercent);
		}
	}

    function calculateTimeDelayFee(uint256 _timeDelay) external view override returns (uint16 feePercentage) {
    	require(_timeDelay >= minTimeWindow, "Time delay too small");
    	require(_timeDelay <= maxTimeWindow, "Time delay too big");

        // Can convert to uint16 as result will mathematically never be larger, due to _timeDelay range verifications
    	feePercentage = uint16(maxTimeDelayFeePercent - (_timeDelay - minTimeWindow) * (maxTimeDelayFeePercent - minTimeDelayFeePercent) / (maxTimeWindow - minTimeWindow));
    }

    function calculateFindersFee(uint256 _tokensLeftAmount) external view override returns (uint256 findersFeeAmount) {
    	return _tokensLeftAmount * findersFeePercent / MAX_FEE_PERCENTAGE;
    }

    function calculateKeepersFee(uint256 _tokensAmount) external view override returns (uint256 keepersFeeAmount) {
        uint256 percentageAmount =  _tokensAmount * keepersFeePercent / MAX_FEE_PERCENTAGE;

        if (percentageAmount >= keepersFeeMax) {
            return keepersFeeMax;
        }

        return percentageAmount;
    }

    function isLiquidable(IVolatilityToken.Request calldata _request) external view override returns (bool liquidable) {
    	if (block.timestamp > _request.targetTimestamp + afterTargetMaxTime) {
    		return true;
    	}

    	return false;
    }

    function setTimeWindow(uint32 _minTimeWindow, uint32 _maxTimeWindow) external override onlyOwner {
    	require(_minTimeWindow <= _maxTimeWindow, "Max is less than min");

    	minTimeWindow = _minTimeWindow;
    	maxTimeWindow = _maxTimeWindow;
    }

    function setTimeDelayFeesParameters(uint16 _minTimeDelayFeePercent, uint16 _maxTimeDelayFeePercent) external override onlyOwner {
    	require(_minTimeDelayFeePercent <= MAX_FEE_PERCENTAGE, "Min fee larger than max fee");
    	require(_maxTimeDelayFeePercent <= MAX_FEE_PERCENTAGE, "Max fee larger than max fee");
    	require(_minTimeDelayFeePercent <= _maxTimeDelayFeePercent, "Max is less than min");
    	minTimeDelayFeePercent = _minTimeDelayFeePercent;
    	maxTimeDelayFeePercent = _maxTimeDelayFeePercent;
    }

    function setMinWaitTime(uint32 _minWaitTime) external override onlyOwner {
    	require(_minWaitTime < minTimeWindow, "Min wait time in window");
    	minWaitTime = _minWaitTime;
    }

    function setTimePenaltyFeeParameters(uint16 _beforeTargetTimeMaxPenaltyFeePercent, uint32 _afterTargetMidTime, uint16 _afterTargetMidTimePenaltyFeePercent, uint32 _afterTargetMaxTime, uint16 _afterTargetMaxTimePenaltyFeePercent) external override onlyOwner {
    	require(_beforeTargetTimeMaxPenaltyFeePercent <= MAX_FEE_PERCENTAGE, "Min fee larger than max fee");
    	require(_afterTargetMidTimePenaltyFeePercent <= MAX_FEE_PERCENTAGE, "Mid fee larger than max fee");
    	require(_afterTargetMaxTimePenaltyFeePercent <= MAX_FEE_PERCENTAGE, "Max fee larger than max fee");
    	require(_afterTargetMidTime <= _afterTargetMaxTime, "Max time before mid time");
    	require(_afterTargetMidTimePenaltyFeePercent <= _afterTargetMaxTimePenaltyFeePercent, "Max fee less than mid fee");

    	beforeTargetTimeMaxPenaltyFeePercent = _beforeTargetTimeMaxPenaltyFeePercent;
    	afterTargetMidTime = _afterTargetMidTime;
    	afterTargetMidTimePenaltyFeePercent = _afterTargetMidTimePenaltyFeePercent;
    	afterTargetMaxTime = _afterTargetMaxTime;
    	afterTargetMaxTimePenaltyFeePercent = _afterTargetMaxTimePenaltyFeePercent;
    }

    function setFindersFee(uint16 _findersFeePercent) external override onlyOwner {
    	require(_findersFeePercent <= MAX_FEE_PERCENTAGE, "Fee larger than max");
    	findersFeePercent = _findersFeePercent;
    }

    function setKeepersFeePercent(uint16 _keepersFeePercent) external override onlyOwner {
        require(_keepersFeePercent <= MAX_FEE_PERCENTAGE, "Fee larger than max");
        keepersFeePercent = _keepersFeePercent;   
    }

    function setKeepersFeeMax(uint256 _keepersFeeMax) external override onlyOwner {
        keepersFeeMax = _keepersFeeMax;
    }

    function getMaxFees() external view override returns (uint16 maxFeesPercent) {
		return afterTargetMaxTimePenaltyFeePercent;
    }
}