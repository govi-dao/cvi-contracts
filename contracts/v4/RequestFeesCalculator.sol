pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./../v1/utils/SafeMath16.sol";

import "./interfaces/IRequestFeesCalculator.sol";

contract RequestFeesCalculator is IRequestFeesCalculator, Ownable {

	using SafeMath for uint256;
	using SafeMath16 for uint16;

	uint168 public constant MAX_FEE_PERCENTAGE = 10000;

	uint32 public minTimeWindow = 1 hours;
	uint32 public maxTimeWindow = 3 hours;

	uint16 public minTimeDelayFeePercent = 0;
	uint16 public maxTimeDelayFeePercent = 100;

	uint32 public minWaitTime = 15 minutes;

	//TOOD: Default values
	uint16 public minTimePenaltyFeePercent = 300;
	uint16 public midTimePenaltyFeePercent = 300;
	uint16 public maxTimePenaltyFeePercent = 500;

	uint16 public findersFeePercent = 5000;

	uint32 public midTime = 1 hours;
	uint32 public maxTime = 12 hours;

	function calculateTimePenaltyFee(IVolatilityToken.Request calldata _request) external view override returns (uint16 feePercentage) {
		feePercentage = maxTimePenaltyFeePercent;

		if (block.timestamp < _request.targetTimestamp) {
			// Linear decreasing between minTimePenaltyFeePercent and 0
            require(block.timestamp >= uint256(_request.requestTimestamp).add(minWaitTime), "Min wait time not over");
			feePercentage = uint16(uint256(_request.targetTimestamp).sub(block.timestamp).mul(minTimePenaltyFeePercent).div(uint256(_request.targetTimestamp).sub(_request.requestTimestamp).sub(minWaitTime)));
		} else if (block.timestamp < uint256(_request.targetTimestamp).add(midTime)) {
			// Linear increasing between 0 and midTimePnealtyFee
			feePercentage = uint16((block.timestamp - _request.targetTimestamp).mul(midTimePenaltyFeePercent).div(midTime));
		} else if (block.timestamp < uint256(_request.targetTimestamp).add(maxTime)) {
			// Between midTimePenaltyFeePercent and maxTimePenaltyFeePercent
			feePercentage = uint16((block.timestamp - _request.targetTimestamp - midTime).mul(maxTimePenaltyFeePercent - midTimePenaltyFeePercent).div(maxTime - midTime).add(midTimePenaltyFeePercent));
		}
	}

    function calculateTimeDelayFee(uint256 _tokenAmount, uint256 _timeDelay) external view override returns (uint16 feePercentage) {
    	require(_timeDelay >= minTimeWindow, "Time delay too small");
    	require(_timeDelay <= maxTimeWindow, "Time delay too big");

        // Can convert to uint16 as result will mathematically never be larger, due to _timeDelay range verifications
    	feePercentage = maxTimeDelayFeePercent.sub(uint16((_timeDelay - minTimeWindow).mul(maxTimeDelayFeePercent - minTimeDelayFeePercent).div(maxTimeWindow - minTimeWindow)));
    }

    function calculateFindersFee(uint256 tokensLeftAmount) external view override returns (uint256 findersFeeAmount) {
    	return tokensLeftAmount.mul(findersFeePercent).div(MAX_FEE_PERCENTAGE);
    }

    function isLiquidable(IVolatilityToken.Request calldata _request) external view override returns (bool liquidable) {
    	if (block.timestamp > uint256(_request.targetTimestamp).add(maxTime)) {
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

    function setTimePenaltyFeeParameters(uint16 _minTimePenaltyFeePercent, uint32 _midTime, uint16 _midTimePenaltyFeePercent, uint32 _maxTime, uint16 _maxTimePenaltyFeePercent) external override onlyOwner {
    	require(_minTimePenaltyFeePercent <= MAX_FEE_PERCENTAGE, "Min fee larger than max fee");
    	require(_midTimePenaltyFeePercent <= MAX_FEE_PERCENTAGE, "Mid fee larger than max fee");
    	require(_maxTimePenaltyFeePercent <= MAX_FEE_PERCENTAGE, "Max fee larger than max fee");
    	require(_midTime <= _maxTime, "Max time before mid time");
    	require(_midTimePenaltyFeePercent <= _maxTimePenaltyFeePercent, "Max fee less than mid fee");

    	minTimePenaltyFeePercent = _minTimePenaltyFeePercent;
    	midTime = _midTime;
    	midTimePenaltyFeePercent = _midTimePenaltyFeePercent;
    	maxTime = _maxTime;
    	maxTimePenaltyFeePercent = _maxTimePenaltyFeePercent;
    }

    function setFindersFee(uint16 _findersFeePercent) external override onlyOwner {
    	require(_findersFeePercent <= MAX_FEE_PERCENTAGE, "Fee larger than max");
    	findersFeePercent = _findersFeePercent;
    }

    function getMaxFees(uint256 _tokenAmount) external view override returns (uint16 maxFeesPercent) {
		return maxTimePenaltyFeePercent;
    }
}