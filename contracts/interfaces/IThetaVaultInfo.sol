// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

interface IThetaVaultInfo {
    function totalVaultLeveragedAmount() external view returns (uint256);
    function vaultPositionUnits() external view returns (uint256);
    function extraLiqidityPercentage() external view returns (uint16);
    function minDexPercentageAllowed() external view returns (uint16);
}
