// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "./IInbox.sol";
import "./IFeesCollector.sol";
import "./../external/IUniswapV2Router02.sol";
import "./AggregatorV3Interface.sol";

interface IFeesCollectorManagement {
	function sendFunds(uint256 ethGOVIPrice) external;

    function setUSDCETHPriceAggregator(AggregatorV3Interface newUSDCETHPriceAggregator) external;
    function setRouter(IUniswapV2Router02 newRouter) external;
    function setStaking(IFeesCollector newStaking) external;
    function setStakingVaultAddress(address newStakingVaultAddress) external;
    function setArbitrumContractAddress(address newArbitrumContractAddress) external;
    function setArbitrumInbox(IInbox newArbitrumInbox) external;

    function setMinETHForTransfer(uint256 newMinETHForTransfer) external;
    function setMinUDSCForConversion(uint256 newMinUSDCForConversion) external;
    function setMaxSubmissionFee(uint256 newMaxSubmissionFee) external;
    function setMaxSlippage(uint16 newMaxSlippagePercent) external;

    function setSendToArbitrum(bool newSendToArbitrum) external;
    function setConvertUSDC(bool newConvertUSDC) external;
    function setBuyBack(bool newBuyBack) external;

    function setFundsSender(address newFundsSender) external;
    function setEnableWhitelist(bool enableWhitelist) external;
    function setAllowedSenderAddress(address account, bool isAllowed) external;

    function setTreasuryAddress(address newTreasuryAddress) external;
    function setTreasuryTransferPercentage(uint16 newTreasuryTransferPercentage) external;
    function setUseNative(bool newUseNative) external;
    function setWrappedToken(IERC20Upgradeable newWrappedToken) external;
    function setSendPercentage(uint16 newSendPercentage) external;

    receive() external payable;
}
