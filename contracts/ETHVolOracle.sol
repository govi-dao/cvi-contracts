// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "./CVIOracle.sol";

contract ETHVolOracle is CVIOracle {
	constructor(AggregatorV3Interface _cviAggregator, AggregatorV3Interface _cviSanityAggregator, uint8 _oracleLeverage) CVIOracle(_cviAggregator, _cviSanityAggregator, 220e18 * _oracleLeverage, _oracleLeverage) {
    }
}