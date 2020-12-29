// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.6.2;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IRewards.sol";
import "./ICVIOracle.sol";
import "./IFeesModel.sol";
import "./IFeesCollector.sol";
import "./IFeesCalculator.sol";
import "./ILiquidation.sol";

interface IPlatform {

    event Deposit(address indexed account, uint256 tokenAmount, uint256 lpTokensAmount, uint256 feeAmount);
    event Withdraw(address indexed account, uint256 tokenAmount, uint256 lpTokensAmount, uint256 feeAmount);
    event OpenPosition(address indexed account, uint256 tokenAmount, uint256 feeAmount, uint256 positionUnitsAmount, uint256 cviValue);
    event ClosePosition(address indexed account, uint256 tokenAmount, uint256 feeAmount, uint256 positionUnitsAmount, uint256 cviValue);
    event LiquidatePosition(address indexed positionAddress, uint256 currentPositionBalance, bool isBalancePositive, uint256 positionUnitsAmount);

    function deposit(uint256 tokenAmount, uint256 minLPTokenAmount) external returns (uint256 lpTokenAmount);
    function withdraw(uint256 tokenAmount, uint256 maxLPTokenBurnAmount) external returns (uint256 burntAmount, uint256 withdrawnAmount);
    function withdrawLPTokens(uint256 lpTokenAmount) external returns (uint256 burntAmount, uint256 withdrawnAmount);

    function openPosition(uint256 tokenAmount, uint16 _maxCVI) external returns (uint256 positionUnitsAmount);
    function closePosition(uint256 positionUnitsAmount, uint16 _minCVI) external returns (uint256 tokenAmount);

    function liquidatePositions(address[] calldata positionOwners) external returns (uint256 finderFeeAmount);

    function setRevertLockedTransfers(bool revertLockedTransfers) external;

    function setFeesCollector(IFeesCollector newCollector) external;
    function setFeesCalculator(IFeesCalculator newCalculator) external;
    function setFeesModel(IFeesModel newModel) external;
    function setCVIOracle(ICVIOracle newOracle) external;
    function setRewards(IRewards newRewards) external;
    function setLiquidation(ILiquidation _newLiquidation) external;

    function setLPLockupPeriod(uint256 newLPLockupPeriod) external;
    function setBuyersLockupPeriod(uint256 newBuyersLockupPeriod) external;

    function getToken() external view returns (IERC20);

    function calculatePositionBalance(address positionAddress) external view returns (uint256 currentPositionBalance, bool isPositive, uint256 positionUnitsAmount);
    function calculatePositionPendingFees(address _positionAddress) external view returns (uint256 pendingFees);

    function totalBalance() external view returns (uint256 balance);
    function totalBalanceWithAddendum() external view returns (uint256 balance);

    function getLiquidableAddresses() external view returns (address[] memory);
}
