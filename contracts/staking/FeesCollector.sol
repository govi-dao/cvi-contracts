// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/KeeperCompatibleInterface.sol";
import "./../interfaces/IFeesCollectorManagement.sol";
import "./../interfaces/IWETH.sol";

contract FeesCollector is Initializable, IFeesCollector, KeeperCompatibleInterface, IFeesCollectorManagement, OwnableUpgradeable {

	uint16 public constant MAX_PERCENTAGE = 10000;

    using SafeERC20Upgradeable for IERC20Upgradeable;

    IERC20Upgradeable public usdcToken;
    IERC20Upgradeable public goviToken;
    IERC20Upgradeable public wrappedToken;
    IFeesCollector public staking;
    address public stakingVaultAddress;
    address public arbitrumContractAddress;
    IUniswapV2Router02 public router;
    AggregatorV3Interface public usdcETHPriceAggregator;
    IInbox public arbitrumInbox;
    address public treasuryAddress;

    uint16 public treasuryTransferPercentage;
    uint16 public maxSlippage;

    uint256 public minETHForTransfer;
    uint256 public minUSDCForConversion;
    uint256 public maxSubmissionFee;

    bool public enableWhitelist;
    bool public sendToArbitrum;
    bool public convertUSDC;
    bool public buyBack;
    bool public useNative;

    address public fundsSender;
    mapping (address => bool) public allowedSenders;

    uint16 public sendPercentage;

    function initialize(IERC20Upgradeable _usdcToken, IERC20Upgradeable _goviToken, IFeesCollector _staking, address _stakingVaultAddress, address _arbitrumContractAddress, IUniswapV2Router02 _router, 
        AggregatorV3Interface _usdcETHPriceAggregator, IInbox _arbitrumInbox, address _treasuryAddress, IERC20Upgradeable _wrappedToken) public initializer {

        usdcToken = _usdcToken;
        goviToken = _goviToken;
        staking = _staking;
        stakingVaultAddress = _stakingVaultAddress;
        arbitrumContractAddress = _arbitrumContractAddress;
        router = _router;
        usdcETHPriceAggregator = _usdcETHPriceAggregator;
        arbitrumInbox = _arbitrumInbox;
        treasuryAddress = _treasuryAddress;
        wrappedToken = _wrappedToken;
        OwnableUpgradeable.__Ownable_init();

        treasuryTransferPercentage = 1500;
        maxSlippage = 100;
        minETHForTransfer = 0.3 ether;
        minUSDCForConversion = 1500e6;
        maxSubmissionFee = 0.1 ether;
        sendPercentage = 2000;

        enableWhitelist = true;
        sendToArbitrum = false;
        convertUSDC = true;
        buyBack = true;
        useNative = true;

        usdcToken.safeApprove(address(router), type(uint256).max);
        wrappedToken.safeApprove(address(router), type(uint256).max);
        goviToken.safeApprove(address(staking), type(uint256).max);
        wrappedToken.safeApprove(address(staking), type(uint256).max);
    }

    receive() external override payable {

    }

    function sendProfit(uint256 _amount, IERC20 _token) external override {
        require(convertUSDC, "Not allowed");
        require(IERC20Upgradeable(address(_token)) == usdcToken, "Non-USDC profit");
        IERC20Upgradeable(address(_token)).safeTransferFrom(msg.sender, address(this), _amount);
    }

    function sendFunds(uint256 _goviETHPrice) external override {
        require(msg.sender == fundsSender, "Not allowed");
        _sendFunds(_goviETHPrice);
    }

    function checkUpkeep(
        bytes calldata /* checkData */
    ) external view override returns (bool upkeepNeeded, bytes memory performData) {
        upkeepNeeded = isUpkeepNeeded();
        return (upkeepNeeded, performData);
    }

    function performUpkeep(
        bytes calldata /* performData */
    ) external override {
        require(!enableWhitelist || allowedSenders[msg.sender], "Not allowed");
        require(sendToArbitrum, "Not allowed");
        _sendFunds(0);
    }

    function setUSDCETHPriceAggregator(AggregatorV3Interface _newUSDCETHPriceAggregator) external override onlyOwner {
        usdcETHPriceAggregator = _newUSDCETHPriceAggregator;
    }

    function setRouter(IUniswapV2Router02 _newRouter) external override onlyOwner{
        usdcToken.safeApprove(address(router), 0);
        router = _newRouter;
        usdcToken.safeApprove(address(router), type(uint256).max);
    }

    function setStaking(IFeesCollector _newStaking) external override onlyOwner {
        goviToken.safeApprove(address(staking), 0);
        wrappedToken.safeApprove(address(staking), 0);
        staking = _newStaking;
        goviToken.safeApprove(address(staking), type(uint256).max);
        wrappedToken.safeApprove(address(staking), type(uint256).max);
    }

    function setStakingVaultAddress(address _newStakingVaultAddress) external override onlyOwner {
        stakingVaultAddress = _newStakingVaultAddress;
    } 

    function setArbitrumContractAddress(address _newArbitrumContractAddress) external override onlyOwner {
        arbitrumContractAddress = _newArbitrumContractAddress;
    }

    function setArbitrumInbox(IInbox _newArbitrumInbox) external override onlyOwner {
        arbitrumInbox = _newArbitrumInbox;
    }

    function setTreasuryAddress(address _newTreasuryAddress) external override onlyOwner {
        treasuryAddress = _newTreasuryAddress;
    }

    function setTreasuryTransferPercentage(uint16 _newTreasuryTransferPercentage) external override onlyOwner {
        treasuryTransferPercentage = _newTreasuryTransferPercentage;
    }

    function setSendPercentage(uint16 _newSendPercentage) external override onlyOwner {
        sendPercentage = _newSendPercentage;
    }

    function setMinETHForTransfer(uint256 _newMinETHForTransfer) external override onlyOwner {
        require(_newMinETHForTransfer >= maxSubmissionFee, "Smaller than submission fee");
        minETHForTransfer = _newMinETHForTransfer;
    }

    function setMinUDSCForConversion(uint256 _newMinUSDCForConversion) external override onlyOwner {
        minUSDCForConversion = _newMinUSDCForConversion;
    }

    function setMaxSubmissionFee(uint256 _newMaxSubmissionFee) external override onlyOwner {
        require(_newMaxSubmissionFee <= minETHForTransfer, "Larger than min transfer ETH");
        maxSubmissionFee = _newMaxSubmissionFee;
    }

    function setMaxSlippage(uint16 _newMaxSlippagePercent) external override onlyOwner {
        maxSlippage = _newMaxSlippagePercent;
    }

    function setSendToArbitrum(bool _newSendToArbitrum) external override onlyOwner {
        sendToArbitrum = _newSendToArbitrum;
    }

    function setConvertUSDC(bool _newConvertUSDC) external override onlyOwner {
        convertUSDC = _newConvertUSDC;
    }

    function setBuyBack(bool _newBuyBack) external override onlyOwner {
        buyBack = _newBuyBack;
    }

    function setFundsSender(address _newFundsSender) external override onlyOwner {
        fundsSender = _newFundsSender;
    }

    function setEnableWhitelist(bool _enableWhitelist) external override onlyOwner {
        enableWhitelist = _enableWhitelist;
    }

    function setAllowedSenderAddress(address _account, bool _isAllowed) external override onlyOwner {
        allowedSenders[_account] = _isAllowed;
    }

    function setUseNative(bool _newUseNative) external override onlyOwner {
        useNative = _newUseNative;
    }

    function setWrappedToken(IERC20Upgradeable _newWrappedToken) external override onlyOwner {
        wrappedToken = _newWrappedToken;
    }

    function _sendFunds(uint256 _ethGOVIPrice) private {
        if (sendToArbitrum || convertUSDC) {
            _convertUSDCToETH();
        }

        if (!sendToArbitrum) {
            _sendToStaking(_ethGOVIPrice);
        }
    }

    function _convertUSDCToETH() private {
        bool shouldConvert = isUpkeepNeeded();
        require(!sendToArbitrum || shouldConvert, "Not enough funds");

        if (shouldConvert) {
            uint256 usdcAmount = usdcToken.balanceOf(address(this));

            if (usdcAmount >= minUSDCForConversion) {
                address[] memory path = new address[](2);
                path[0] = address(usdcToken);
                path[1] = address(wrappedToken);

                (, int256 usdcETHPrice,,,) = usdcETHPriceAggregator.latestRoundData();
                require(usdcETHPrice > 0, "Price not positive");
                uint256 ethMinOut = usdcAmount * uint256(usdcETHPrice) * (MAX_PERCENTAGE - maxSlippage) / MAX_PERCENTAGE / (10 ** ERC20Upgradeable(address(usdcToken)).decimals());

                if (useNative) {
                    router.swapExactTokensForETH(usdcAmount, ethMinOut, path, address(this), block.timestamp);
                } else {
                    router.swapExactTokensForTokens(usdcAmount, ethMinOut, path, address(this), block.timestamp);
                }
            }

            uint256 transferAmount = getETHBalance();

            if (sendToArbitrum) {
                arbitrumInbox.createRetryableTicket{value: transferAmount}(arbitrumContractAddress, 0, transferAmount, arbitrumContractAddress, arbitrumContractAddress, 0, 0, "0x");
            }
        }
    }

    function _sendToStaking(uint256 _ethGOVIPrice) private {
        uint256 ethAmount = getETHBalance() * sendPercentage / MAX_PERCENTAGE;
        require(ethAmount > 0, "Not enough funds");

        if(treasuryAddress != address(0) && treasuryTransferPercentage > 0) {
            uint256 sendToTreasuryAmount = ethAmount * treasuryTransferPercentage / MAX_PERCENTAGE;
            if(useNative) {
                payable(treasuryAddress).transfer(sendToTreasuryAmount);
            } else {
                wrappedToken.safeTransfer(treasuryAddress, sendToTreasuryAmount);
            }
            ethAmount = ethAmount - sendToTreasuryAmount;
        }

        if (buyBack) {
            address[] memory path = new address[](2);
            path[0] = address(wrappedToken);
            path[1] = address(goviToken);

            uint256 goviMinOut = ethAmount * _ethGOVIPrice * (MAX_PERCENTAGE - maxSlippage) / MAX_PERCENTAGE / (10 ** ERC20Upgradeable(address(goviToken)).decimals());

            uint[] memory outAmounts;
            if (useNative) {
                outAmounts = router.swapExactETHForTokens{value: ethAmount}(goviMinOut, path, address(this), block.timestamp);
            } else {
                outAmounts = router.swapExactTokensForTokens(ethAmount, goviMinOut, path, address(this), block.timestamp);
            }

            goviToken.safeTransfer(stakingVaultAddress, outAmounts[1]);
        } else {
            IWETH(address(wrappedToken)).deposit{value: ethAmount}();
            staking.sendProfit(ethAmount, IERC20(address(wrappedToken)));
        }
    }

    function isUpkeepNeeded() private view returns (bool) {
        uint256 usdcAmount = usdcToken.balanceOf(address(this));
        uint256 totalETH = getETHBalance();

        if (usdcAmount >= minUSDCForConversion) {
            address[] memory path = new address[](2);
            path[0] = address(usdcToken);
            path[1] = address(wrappedToken);
            totalETH += router.getAmountsOut(usdcAmount, path)[1];
        }

        return (totalETH >= minETHForTransfer);
    }

    function getETHBalance() private view returns (uint256) { 
        if (useNative) {
            return address(this).balance;
        } else {
            return wrappedToken.balanceOf(address(this));
        }
    }
}