// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "./../interfaces/IStaking.sol";
import "./../interfaces/IFeesCollector.sol";
import "./../interfaces/IStakingVault.sol";
import "./../interfaces/IWETH.sol";

contract Staking is IStaking, IFeesCollector, ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {

    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint256 public constant PRECISION_DECIMALS = 1e18;

    IERC20Upgradeable[] public claimableTokens;

	mapping(IERC20Upgradeable => bool) public claimableTokensSupported;

	mapping(IERC20Upgradeable => uint256) public totalProfits;
    mapping(address => mapping(IERC20Upgradeable => uint256)) public lastProfits;
    mapping(address => mapping(IERC20Upgradeable => uint256)) public savedProfits;

    mapping(address => uint256) public stakeTimestamps;

    IStakingVault public stakingVault;
    IERC20Upgradeable public goviToken;
    IWETH public wethToken;
    address public fallbackRecipient;

    uint256 public stakeLockupTime;

    uint256 public override rewardPerSecond;
    uint256 public override lastUpdateTime;

    function initialize(IERC20Upgradeable _goviToken, IStakingVault _stakingVault, IWETH _wethToken) public initializer {
        rewardPerSecond = 28000e18 / uint256(7 days);
        lastUpdateTime = block.timestamp;

        stakeLockupTime = 1 hours;

    	goviToken = _goviToken;
        stakingVault = _stakingVault;
        wethToken = _wethToken;
    	fallbackRecipient = msg.sender;

        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        OwnableUpgradeable.__Ownable_init();
        ERC20Upgradeable.__ERC20_init("xGOVI", "xGOVI");
    }

    receive() external override payable {

    }

    function sendProfit(uint256 _amount, IERC20 _token) external override nonReentrant {
        IERC20Upgradeable upgradeableToken = IERC20Upgradeable(address(_token));

    	require(claimableTokensSupported[upgradeableToken] && upgradeableToken != goviToken, "Token not supported");

    	if (totalSupply() > 0) {
    		addProfit(_amount, upgradeableToken);
            upgradeableToken.safeTransferFrom(msg.sender, address(this), _amount);
    	} else {
    		upgradeableToken.safeTransferFrom(msg.sender, fallbackRecipient, _amount);
    	}
    }

    function stake(uint256 _goviAmount) external override nonReentrant returns (uint256 xGOVIAmount) {
    	require(_goviAmount > 0, "Amount must be positive");

        withdrawFromVault();

        if (balanceOf(msg.sender) > 0) {
            saveProfit(balanceOf(msg.sender));
        }
        
        for (uint256 tokenIndex = 0; tokenIndex < claimableTokens.length; tokenIndex = tokenIndex + 1) {
            IERC20Upgradeable token = claimableTokens[tokenIndex];
            lastProfits[msg.sender][token] = totalProfits[token];           
        }

        stakeTimestamps[msg.sender] = block.timestamp;

        uint256 supply = totalSupply();
        uint256 balance = goviToken.balanceOf(address(this));
    
        if (supply > 0 && balance > 0) {
            xGOVIAmount = _goviAmount * supply / balance;
        } else {
            xGOVIAmount = _goviAmount; // Initial rate is 1:1
        }

        _mint(msg.sender, xGOVIAmount);
        goviToken.safeTransferFrom(msg.sender, address(this), _goviAmount);

        emit Staked(msg.sender, _goviAmount, xGOVIAmount, balanceOf(msg.sender));
    }

    function unstake(uint256 _xGOVIAmount) public override nonReentrant returns (uint256 goviAmount) {
    	require(_xGOVIAmount > 0, "Amount must be positive");
        require(_xGOVIAmount <= balanceOf(msg.sender), "Not enough staked");
    	require(stakeTimestamps[msg.sender] + stakeLockupTime <= block.timestamp, "Funds locked");

        withdrawFromVault();

    	saveProfit(_xGOVIAmount);

        goviAmount = _xGOVIAmount * goviToken.balanceOf(address(this)) / totalSupply();

        _burn(msg.sender, _xGOVIAmount);
    	goviToken.safeTransfer(msg.sender, goviAmount);

        emit Unstaked(msg.sender, _xGOVIAmount, goviAmount, balanceOf(msg.sender));
    }

    function claimProfit(IERC20Upgradeable token) external override nonReentrant returns (uint256 profit) {
    	_saveProfit(token, balanceOf(msg.sender));
    	
    	profit = _claimProfit(token);
    	require(profit > 0, "No profit for token");
    }

    function claimAllProfits() external override returns (uint256[] memory) {
        uint256[] memory profits = new uint256[](claimableTokens.length);
        saveProfit(balanceOf(msg.sender));

        uint256 totalProfit = 0;
        for (uint256 tokenIndex = 0; tokenIndex < claimableTokens.length; tokenIndex++) {
            uint256 currProfit = _claimProfit(claimableTokens[tokenIndex]);
            profits[tokenIndex] = currProfit;
            totalProfit = totalProfit + currProfit;
        }

        require(totalProfit > 0, "No profit");

        return profits;
    }

    function addClaimableToken(IERC20Upgradeable _newClaimableToken) external override onlyOwner {
        require(!claimableTokensSupported[_newClaimableToken], "Token already added");
        claimableTokensSupported[_newClaimableToken] = true;
        claimableTokens.push(_newClaimableToken);
    }

    function removeClaimableToken(IERC20Upgradeable _removedClaimableToken) external override onlyOwner {
        require(claimableTokensSupported[_removedClaimableToken], "Token not supported");

        bool isFound = false;
        for (uint256 tokenIndex = 0; tokenIndex < claimableTokens.length; tokenIndex = tokenIndex + 1) {
            if (claimableTokens[tokenIndex] == _removedClaimableToken) {
                isFound = true;
                claimableTokens[tokenIndex] = claimableTokens[claimableTokens.length - 1];
                claimableTokens.pop();
                break;
            }
        }
        require(isFound, "Token not found");

        claimableTokensSupported[_removedClaimableToken] = false;
    }

    function setStakingLockupTime(uint256 _newLockupTime) external override onlyOwner {
        stakeLockupTime = _newLockupTime;
    }

    function setRewardRate(uint256 _newRewardPerSecond) external override onlyOwner {
        withdrawFromVault(); // With old rates until now

        rewardPerSecond = _newRewardPerSecond;
    }

    function profitOf(address _account, IERC20Upgradeable _token) external view override returns (uint256) {
        return savedProfits[_account][_token] + unsavedProfit(_account, balanceOf(_account), _token);
    }

    function getClaimableTokens() external view override returns (IERC20Upgradeable[] memory) {
        return claimableTokens;
    }

    function _claimProfit(IERC20Upgradeable _token) private returns (uint256 profit) {
    	require(claimableTokensSupported[_token], "Token not supported");
		profit = savedProfits[msg.sender][_token];

		if (profit > 0) {
			savedProfits[msg.sender][_token] = 0;
			lastProfits[msg.sender][_token] = totalProfits[_token];

			if (address(_token) == address(wethToken)) {
				wethToken.withdraw(profit);
                payable(msg.sender).transfer(profit);
			} else {
				_token.safeTransfer(msg.sender, profit);
			}

            emit RewardClaimed(msg.sender, address(_token), profit);
		}
    }

    function addProfit(uint256 _amount, IERC20Upgradeable _token) private {
    	totalProfits[_token] = totalProfits[_token] + (_amount * PRECISION_DECIMALS / totalSupply());
        emit ProfitAdded(address(_token), _amount);
    }

    function withdrawFromVault() private {
        if (totalSupply() > 0) {
            uint256 rewardToWithdraw = (block.timestamp - lastUpdateTime) * rewardPerSecond;
            if (rewardToWithdraw > 0) {
                stakingVault.withdraw(rewardToWithdraw);
            }
        }

        lastUpdateTime = block.timestamp;
    }

    function saveProfit(uint256 _amount) private {
    	for (uint256 tokenIndex = 0; tokenIndex < claimableTokens.length; tokenIndex = tokenIndex + 1) {
    		IERC20Upgradeable token = claimableTokens[tokenIndex];
    		_saveProfit(token, _amount);
    	}
    }

    function _saveProfit(IERC20Upgradeable _token, uint256 _amount) private {
    	savedProfits[msg.sender][_token] = savedProfits[msg.sender][_token] + unsavedProfit(msg.sender, _amount, _token);
    }

    function unsavedProfit(address _account, uint256 _amount, IERC20Upgradeable _token) private view returns (uint256) {
        return (totalProfits[_token] - lastProfits[_account][_token]) * _amount / PRECISION_DECIMALS;
    }
}