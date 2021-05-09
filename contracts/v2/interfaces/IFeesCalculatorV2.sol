// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "../../v1/interfaces/IFeesCalculator.sol";

interface IFeesCalculatorV2 is IFeesCalculator {
    function updateTurbulenceIndicatorPercent(uint256 totalHours, uint256 newRounds) external returns (uint16);
    function calculateTurbulenceIndicatorPercent(uint256 totalHours, uint256 newRounds) external view returns (uint16);
    function calculateBuyingPremiumFeeWithTurbulence(uint256 _tokenAmount, uint256 _collateralRatio, uint16 _turbulenceIndicatorPercent) external view returns (uint256 buyingPremiumFee);

    function turbulenceIndicatorPercent() external view returns (uint16);
}
