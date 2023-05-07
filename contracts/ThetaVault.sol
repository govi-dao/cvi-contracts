// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8;

import '@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol';
import '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';

import './interfaces/IThetaVault.sol';
import './interfaces/IRequestManager.sol';
import './external/IUniswapV2Pair.sol';
import './external/IUniswapV2Router02.sol';
import './external/IUniswapV2Factory.sol';

contract ThetaVault is Initializable, IThetaVault, IRequestManager, OwnableUpgradeable, ERC20Upgradeable, ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct Request {
        uint8 requestType; // 1 => deposit, 2 => withdraw
        uint168 tokenAmount;
        uint32 targetTimestamp;
        address owner;
        bool shouldStake;
    }

    uint8 public constant DEPOSIT_REQUEST_TYPE = 1;
    uint8 public constant WITHDRAW_REQUEST_TYPE = 2;

    uint256 public constant PRECISION_DECIMALS = 1e10;
    uint16 public constant MAX_PERCENTAGE = 10000;

    uint16 public constant UNISWAP_REMOVE_MAX_FEE_PERCENTAGE = 5;

    address public fulfiller;

    IERC20Upgradeable public token;
    IPlatform public platform;
    IVolatilityToken public override volToken;
    IUniswapV2Router02 public router;

    uint256 public override nextRequestId;
    mapping(uint256 => Request) public override requests;
    mapping(address => uint256) public lastDepositTimestamp;

    uint256 public initialTokenToThetaTokenRate;

    uint256 public totalDepositRequestsAmount;
    uint256 public override totalVaultLeveragedAmount; // Obsolete

    uint16 public minPoolSkewPercentage;
    uint16 public override extraLiqidityPercentage;
    uint256 public depositCap;
    uint256 public requestDelay;
    uint256 public lockupPeriod;
    uint256 public liquidationPeriod;

    uint256 public override minRequestId;
    uint256 public override maxMinRequestIncrements;
    uint256 public minDepositAmount;
    uint256 public minWithdrawAmount;

    uint256 public totalHoldingsAmount;
    uint16 public depositHoldingsPercentage;

    uint16 public override minDexPercentageAllowed;

    IRewardRouter public rewardRouter;

    function initialize(uint256 _initialTokenToThetaTokenRate, IPlatform _platform, IVolatilityToken _volToken, IRewardRouter _rewardRouter, IERC20Upgradeable _token, IUniswapV2Router02 _router, string memory _lpTokenName, string memory _lpTokenSymbolName) public initializer {
        require(address(_platform) != address(0));
        require(address(_volToken) != address(0));
        require(address(_token) != address(0));
        require(address(_router) != address(0));
        require(_initialTokenToThetaTokenRate > 0);

        nextRequestId = 1;
        minRequestId = 1;
        initialTokenToThetaTokenRate = _initialTokenToThetaTokenRate;
        minPoolSkewPercentage = 300;
        extraLiqidityPercentage = 1500;
        depositCap = type(uint256).max;
        requestDelay = 0.5 hours;
        lockupPeriod = 24 hours;
        liquidationPeriod = 3 days;
        maxMinRequestIncrements = 30;
        minDepositAmount = 100000;
        minWithdrawAmount = 10 ** 16;
        depositHoldingsPercentage = 1500;
        minDexPercentageAllowed = 3000;

        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        OwnableUpgradeable.__Ownable_init();
        ERC20Upgradeable.__ERC20_init(_lpTokenName, _lpTokenSymbolName);

        platform = _platform;
        token = _token;
        volToken = _volToken;
        router = _router;
        rewardRouter = _rewardRouter;

        token.safeApprove(address(platform), type(uint256).max);
        token.safeApprove(address(router), type(uint256).max);
        token.safeApprove(address(volToken), type(uint256).max);
        IERC20Upgradeable(address(volToken)).safeApprove(address(router), type(uint256).max);
        IERC20Upgradeable(address(getPair())).safeApprove(address(router), type(uint256).max);
        IERC20Upgradeable(address(volToken)).safeApprove(address(volToken), type(uint256).max);
    }

    function name() public view virtual override returns (string memory) {
        return 'Theta CVI LP';
    }

    function symbol() public view virtual override returns (string memory) {
        return 'T-CVI-LP';
    }

    function submitDepositRequest(uint168 _tokenAmount/* , bool _shouldStake */) external override returns (uint256 requestId) {
        require(_tokenAmount >= minDepositAmount, 'Too small');
        // require(!_shouldStake || address(rewardRouter) != address(0), 'Router not set');
        return submitRequest(DEPOSIT_REQUEST_TYPE, _tokenAmount, false);
    }

    function submitWithdrawRequest(uint168 _thetaTokenAmount) external override returns (uint256 requestId) {
        require(_thetaTokenAmount >= minWithdrawAmount, 'Too small');
        require(lastDepositTimestamp[msg.sender] + lockupPeriod <= block.timestamp, 'Deposit locked');
        return submitRequest(WITHDRAW_REQUEST_TYPE, _thetaTokenAmount, false);
    }

    struct FulfillDepositLocals {
        uint256 mintVolTokenUSDCAmount;
        uint256 addedLiquidityUSDCAmount;
        uint256 mintedVolTokenAmount;
        uint256 platformLiquidityAmount;
        uint256 holdingsAmount;
    }

    function fulfillDepositRequest(uint256 _requestId) external override returns (uint256 thetaTokensMinted) {
        uint168 amountToFulfill;
        address owner;
        uint256 volTokenPositionBalance;

        bool shouldStake = requests[_requestId].shouldStake;
        {
            bool wasLiquidated;
            (amountToFulfill, owner, wasLiquidated) = preFulfillRequest(_requestId, requests[_requestId], DEPOSIT_REQUEST_TYPE);

            if (wasLiquidated) {
                return 0;
            }

            deleteRequest(_requestId);

            // Note: reverts if pool is skewed after arbitrage, as intended
            uint256 balance;
            (balance, volTokenPositionBalance) = _rebalance(amountToFulfill);

            // Mint theta lp tokens
            if (totalSupply() > 0 && balance > 0) {
                thetaTokensMinted = (amountToFulfill * totalSupply()) / balance;
            } else {
                thetaTokensMinted = amountToFulfill * initialTokenToThetaTokenRate;
            }
        }

        require(thetaTokensMinted > 0); // 'Too few tokens'
        _mint(owner, thetaTokensMinted);

        lastDepositTimestamp[owner] = block.timestamp;

        // Avoid crashing in case an old request existed when totalDepositRequestsAmount was initialized
        if (totalDepositRequestsAmount < amountToFulfill) {
            totalDepositRequestsAmount = 0;
        } else {
            totalDepositRequestsAmount -= amountToFulfill;
        }

        FulfillDepositLocals memory locals = deposit(amountToFulfill, volTokenPositionBalance);

        if (shouldStake) {
            rewardRouter.stakeForAccount(StakedTokenName.THETA_VAULT, owner, thetaTokensMinted);
        }

        emit FulfillDeposit(_requestId, owner, amountToFulfill, locals.platformLiquidityAmount, locals.mintVolTokenUSDCAmount, locals.mintedVolTokenAmount, 
            locals.addedLiquidityUSDCAmount, thetaTokensMinted);
    }

    struct FulfillWithdrawLocals {
        uint256 withdrawnLiquidity;
        uint256 platformLPTokensToRemove;
        uint256 removedVolTokensAmount;
        uint256 dexRemovedUSDC;
        uint256 burnedVolTokensUSDCAmount;
    }

    function fulfillWithdrawRequest(uint256 _requestId) external override returns (uint256 tokenWithdrawnAmount) {
        (uint168 amountToFulfill, address owner, bool wasLiquidated) = preFulfillRequest(_requestId, requests[_requestId], WITHDRAW_REQUEST_TYPE);

        if (!wasLiquidated) {
            _rebalance(0);

            FulfillWithdrawLocals memory locals;

            locals.platformLPTokensToRemove = (amountToFulfill * IERC20Upgradeable(address(platform)).balanceOf(address(this))) / totalSupply();
            uint256 poolLPTokensAmount = (amountToFulfill * IERC20Upgradeable(address(getPair())).balanceOf(address(this))) /
                totalSupply();
            if (poolLPTokensAmount > 0) {
                (locals.removedVolTokensAmount, locals.dexRemovedUSDC) = router.removeLiquidity(address(volToken), address(token), poolLPTokensAmount, 0, 0, address(this), block.timestamp);
                locals.burnedVolTokensUSDCAmount = burnVolTokens(locals.removedVolTokensAmount);
            }

            (, locals.withdrawnLiquidity) = platform.withdrawLPTokens(locals.platformLPTokensToRemove);

            uint256 withdrawHoldings = totalHoldingsAmount * amountToFulfill / totalSupply();
            tokenWithdrawnAmount = withdrawHoldings + locals.withdrawnLiquidity + locals.dexRemovedUSDC + locals.burnedVolTokensUSDCAmount;
            totalHoldingsAmount -= withdrawHoldings;

            _burn(address(this), amountToFulfill);
            deleteRequest(_requestId);

            token.safeTransfer(owner, tokenWithdrawnAmount);

            emit FulfillWithdraw(_requestId, owner, tokenWithdrawnAmount, locals.withdrawnLiquidity, locals.removedVolTokensAmount, locals.burnedVolTokensUSDCAmount, locals.dexRemovedUSDC, amountToFulfill);
        }
    }

    function liquidateRequest(uint256 _requestId) external override nonReentrant {
        Request memory request = requests[_requestId];
        require(request.requestType != 0); // 'Request id not found'
        require(isLiquidable(_requestId), 'Not liquidable');

        _liquidateRequest(_requestId);
    }

    function rebalance() external override onlyOwner {
        _rebalance(0);
    }

    function _rebalance(uint256 _arbitrageAmount) private returns (uint256 balance, uint256 volTokenPositionBalance) {
        // Note: reverts if pool is skewed, as intended
        uint256 intrinsicDEXVolTokenBalance;
        uint256 usdcPlatformLiquidity;
        uint256 dexUSDCAmount;
        (balance, usdcPlatformLiquidity, intrinsicDEXVolTokenBalance, volTokenPositionBalance, dexUSDCAmount) = totalBalanceWithArbitrage(_arbitrageAmount);

        uint256 adjustedPositionUnits = platform.totalPositionUnitsAmount() * (MAX_PERCENTAGE + extraLiqidityPercentage) / MAX_PERCENTAGE;
        uint256 totalLeveragedTokensAmount = platform.totalLeveragedTokensAmount();

        // No need to rebalance if no position units for vault (i.e. dex not initialized yet)
        if (dexUSDCAmount > 0) {
            if (totalLeveragedTokensAmount > adjustedPositionUnits + minDepositAmount) {
                uint256 extraLiquidityAmount = totalLeveragedTokensAmount - adjustedPositionUnits;

                (, uint256 withdrawnAmount) = platform.withdraw(extraLiquidityAmount, type(uint256).max);

                deposit(withdrawnAmount, volTokenPositionBalance);
            } else if (totalLeveragedTokensAmount + minDepositAmount < adjustedPositionUnits) {
                uint256 liquidityMissing = adjustedPositionUnits - totalLeveragedTokensAmount;

                if (intrinsicDEXVolTokenBalance + dexUSDCAmount > liquidityMissing && 
                    (intrinsicDEXVolTokenBalance + dexUSDCAmount - liquidityMissing) * MAX_PERCENTAGE / balance >= minDexPercentageAllowed) {
                    uint256 poolLPTokensToRemove = liquidityMissing * IERC20Upgradeable(address(getPair())).totalSupply() / (intrinsicDEXVolTokenBalance + dexUSDCAmount);

                    (uint256 removedVolTokensAmount, uint256 dexRemovedUSDC) = router.removeLiquidity(address(volToken), address(token), poolLPTokensToRemove, 0, 0, address(this), block.timestamp);
                    uint256 totalUSDC = burnVolTokens(removedVolTokensAmount) + dexRemovedUSDC;

                    platform.deposit(totalUSDC, 0);
                }
            }

            (balance,, intrinsicDEXVolTokenBalance, volTokenPositionBalance, dexUSDCAmount,) = totalBalance();
        }
    }

    function vaultPositionUnits() external view override returns (uint256) {
        (uint256 dexVolTokensAmount, ) = getReserves();
        IERC20Upgradeable poolPair = IERC20Upgradeable(address(getPair()));
        if (IERC20Upgradeable(address(volToken)).totalSupply() == 0 || poolPair.totalSupply() == 0) {
            return 0;
        }

        uint256 dexVaultVolTokensAmount = (dexVolTokensAmount * poolPair.balanceOf(address(this))) / poolPair.totalSupply();

        (uint256 totalPositionUnits, , , , ) = platform.positions(address(volToken));
        return totalPositionUnits * dexVaultVolTokensAmount / IERC20Upgradeable(address(volToken)).totalSupply();
    }

    function setRewardRouter(IRewardRouter _rewardRouter) external override onlyOwner {
        rewardRouter = _rewardRouter;
    }

    function setFulfiller(address _newFulfiller) external override onlyOwner {
        fulfiller = _newFulfiller;
    }

    function setMinAmounts(uint256 _newMinDepositAmount, uint256 _newMinWithdrawAmount) external override onlyOwner {
        minDepositAmount = _newMinDepositAmount;
        minWithdrawAmount = _newMinWithdrawAmount;
    }

    function setDepositHoldings(uint16 _newDepositHoldingsPercentage) external override onlyOwner {
        depositHoldingsPercentage = _newDepositHoldingsPercentage;
    }

    function setMinPoolSkew(uint16 _newMinPoolSkewPercentage) external override onlyOwner {
        minPoolSkewPercentage = _newMinPoolSkewPercentage;
    }

    function setLiquidityPercentages(uint16 _newExtraLiquidityPercentage, uint16 _minDexPercentageAllowed) external override onlyOwner {
        extraLiqidityPercentage = _newExtraLiquidityPercentage;
        minDexPercentageAllowed = _minDexPercentageAllowed;
    }

    function setRequestDelay(uint256 _newRequestDelay) external override onlyOwner {
        requestDelay = _newRequestDelay;
    }

    function setDepositCap(uint256 _newDepositCap) external override onlyOwner {
        depositCap = _newDepositCap;
    }

    function setPeriods(uint256 _newLockupPeriod, uint256 _newLiquidationPeriod) external override onlyOwner {
        lockupPeriod = _newLockupPeriod;
        liquidationPeriod = _newLiquidationPeriod;
    }

    function totalBalance() public view override returns (uint256 balance, uint256 usdcPlatformLiquidity, uint256 intrinsicDEXVolTokenBalance, uint256 volTokenPositionBalance, uint256 dexUSDCAmount, uint256 dexVolTokensAmount) {
        (intrinsicDEXVolTokenBalance, volTokenPositionBalance, dexUSDCAmount, dexVolTokensAmount,) = calculatePoolValue();
        (balance, usdcPlatformLiquidity) = _totalBalance(intrinsicDEXVolTokenBalance, dexUSDCAmount);
    }

    function totalBalanceWithArbitrage(uint256 _usdcArbitrageAmount) private returns (uint256 balance, uint256 usdcPlatformLiquidity, uint256 intrinsicDEXVolTokenBalance, uint256 volTokenPositionBalance, uint256 dexUSDCAmount) {
        (intrinsicDEXVolTokenBalance, volTokenPositionBalance, dexUSDCAmount) = 
            calculatePoolValueWithArbitrage(_usdcArbitrageAmount);
        (balance, usdcPlatformLiquidity) = _totalBalance(intrinsicDEXVolTokenBalance, dexUSDCAmount);
    }

    function _totalBalance(uint256 _intrinsicDEXVolTokenBalance, uint256 _dexUSDCAmount) private view returns (uint256 balance, uint256 usdcPlatformLiquidity)
    {
        IERC20Upgradeable poolPair = IERC20Upgradeable(address(getPair()));
        uint256 poolLPTokens = poolPair.balanceOf(address(this));
        uint256 vaultIntrinsicDEXVolTokenBalance = 0;
        uint256 vaultDEXUSDCAmount = 0;

        if (poolLPTokens > 0 && poolPair.totalSupply() > 0) {
            vaultIntrinsicDEXVolTokenBalance = (_intrinsicDEXVolTokenBalance * poolLPTokens) / poolPair.totalSupply();
            vaultDEXUSDCAmount = (_dexUSDCAmount * poolLPTokens) / poolPair.totalSupply();
        }

        usdcPlatformLiquidity = getUSDCPlatformLiquidity();
        balance = totalHoldingsAmount + usdcPlatformLiquidity + vaultIntrinsicDEXVolTokenBalance + vaultDEXUSDCAmount;
    }

    function deposit(uint256 _tokenAmount, uint256 _volTokenPositionBalance) private returns (FulfillDepositLocals memory locals)
    {
        (uint256 dexVolTokensAmount, uint256 dexUSDCAmount) = getReserves();

        uint256 dexVolTokenPrice;
        uint256 intrinsicVolTokenPrice;
        bool dexHasLiquidity = true;

        if (dexVolTokensAmount == 0 || dexUSDCAmount == 0) {
            dexHasLiquidity = false;
        } else {
            intrinsicVolTokenPrice =
                (_volTokenPositionBalance * 10**ERC20Upgradeable(address(volToken)).decimals()) /
                IERC20Upgradeable(address(volToken)).totalSupply();
            dexVolTokenPrice = (dexUSDCAmount * 10**ERC20Upgradeable(address(volToken)).decimals()) / dexVolTokensAmount;
        }

        if (dexHasLiquidity) {
            (locals.mintVolTokenUSDCAmount, locals.platformLiquidityAmount, locals.holdingsAmount) = calculateDepositAmounts(
                _tokenAmount,
                dexVolTokenPrice,
                intrinsicVolTokenPrice
            );

            totalHoldingsAmount += locals.holdingsAmount;

            platform.deposit(locals.platformLiquidityAmount, 0);
            (locals.addedLiquidityUSDCAmount, locals.mintedVolTokenAmount) = addDEXLiquidity(locals.mintVolTokenUSDCAmount);
        } else {
            locals.platformLiquidityAmount = _tokenAmount;
            platform.deposit(locals.platformLiquidityAmount, 0);
        }
    }

    function calculatePoolValue() private view returns (uint256 intrinsicDEXVolTokenBalance, uint256 volTokenBalance, uint256 dexUSDCAmount, uint256 dexVolTokensAmount, bool isPoolSkewed) {
        (dexVolTokensAmount, dexUSDCAmount) = getReserves();

        bool isPositive = true;
        (uint256 currPositionUnits, , , , ) = platform.positions(address(volToken));
        if (currPositionUnits != 0) {
            (volTokenBalance, isPositive,,,,) = platform.calculatePositionBalance(address(volToken));
        }
        require(isPositive); // 'Negative balance'

        // No need to check skew if pool is still empty
        if (dexVolTokensAmount > 0 && dexUSDCAmount > 0) {
            // Multiply by vol token decimals to get intrinsic worth in USDC
            intrinsicDEXVolTokenBalance =
                (dexVolTokensAmount * volTokenBalance) /
                IERC20Upgradeable(address(volToken)).totalSupply();
            uint256 delta = intrinsicDEXVolTokenBalance > dexUSDCAmount ? intrinsicDEXVolTokenBalance - dexUSDCAmount : dexUSDCAmount - intrinsicDEXVolTokenBalance;

            if (delta > (intrinsicDEXVolTokenBalance * minPoolSkewPercentage) / MAX_PERCENTAGE) {
                isPoolSkewed = true;
            }
        }
    }

    function calculatePoolValueWithArbitrage(uint256 _usdcArbitrageAmount) private returns (uint256 intrinsicDEXVolTokenBalance, uint256 volTokenBalance, uint256 dexUSDCAmount) {
        bool isPoolSkewed;
        (intrinsicDEXVolTokenBalance, volTokenBalance, dexUSDCAmount,, isPoolSkewed) = calculatePoolValue();

        if (isPoolSkewed) {
            attemptArbitrage(_usdcArbitrageAmount + totalHoldingsAmount, intrinsicDEXVolTokenBalance, dexUSDCAmount);
            (intrinsicDEXVolTokenBalance, volTokenBalance, dexUSDCAmount,, isPoolSkewed) = calculatePoolValue();
            require(!isPoolSkewed, 'Too skewed');
        }
    }

    function attemptArbitrage(uint256 _usdcAmount, uint256 _intrinsicDEXVolTokenBalance, uint256 _dexUSDCAmount) private {
        uint256 usdcAmountNeeded = _dexUSDCAmount > _intrinsicDEXVolTokenBalance ? (_dexUSDCAmount - _intrinsicDEXVolTokenBalance) / 2 : 
            (_intrinsicDEXVolTokenBalance - _dexUSDCAmount) / 2; // A good estimation to close arbitrage gap

        uint256 withdrawnLiquidity = 0;
        if (_usdcAmount < usdcAmountNeeded) {
            uint256 leftAmount = usdcAmountNeeded - _usdcAmount;

            // Get rest of amount needed from platform liquidity (will revert if not enough collateral)
            // Revert is ok here, befcause in that case, there is no way to arbitrage and resolve the skew,
            // and no requests will fulfill anyway
            (, withdrawnLiquidity) = platform.withdrawLPTokens(
                (leftAmount * IERC20Upgradeable(address(platform)).totalSupply()) / platform.totalBalance(true)
            );

            usdcAmountNeeded = withdrawnLiquidity + _usdcAmount;
        }

        uint256 updatedUSDCAmount;
        if (_dexUSDCAmount > _intrinsicDEXVolTokenBalance) {
            // Price is higher than intrinsic value, mint at lower price, then buy on dex
            uint256 mintedVolTokenAmount = mintVolTokens(usdcAmountNeeded);

            address[] memory path = new address[](2);
            path[0] = address(volToken);
            path[1] = address(token);

            // Note: No need for slippage since we checked the price in this current block
            uint256[] memory amounts = router.swapExactTokensForTokens(mintedVolTokenAmount, 0, path, address(this), block.timestamp);

            updatedUSDCAmount = amounts[1];
        } else {
            // Price is lower than intrinsic value, buy on dex, then burn at higher price

            address[] memory path = new address[](2);
            path[0] = address(token);
            path[1] = address(volToken);

            // Note: No need for slippage since we checked the price in this current block
            uint256[] memory amounts = router.swapExactTokensForTokens(usdcAmountNeeded, 0, path, address(this), block.timestamp);

            updatedUSDCAmount = burnVolTokens(amounts[1]);
        }

        // Make sure we didn't lose by doing arbitrage (for example, mint/burn fees exceeds arbitrage gain)
        require(updatedUSDCAmount > usdcAmountNeeded); // 'Arbitrage failed'

        // Deposit arbitrage gains back to vault as platform liquidity as well
        platform.deposit(updatedUSDCAmount - usdcAmountNeeded + withdrawnLiquidity, 0);
    }

    function preFulfillRequest(uint256 _requestId, Request memory _request, uint8 _expectedType) private nonReentrant returns (uint168 amountToFulfill, address owner, bool wasLiquidated) {
        require(_request.owner != address(0)); // 'Invalid request id'
        require(msg.sender == fulfiller || msg.sender == _request.owner); // 'Not allowed'
        require(_request.requestType == _expectedType); // 'Wrong request type'
        require(block.timestamp >= _request.targetTimestamp, 'Too soon');

        if (isLiquidable(_requestId)) {
            _liquidateRequest(_requestId);
            wasLiquidated = true;
        } else {
            amountToFulfill = _request.tokenAmount;
            owner = _request.owner;
        }
    }

    function submitRequest(uint8 _type, uint168 _tokenAmount, bool _shouldStake) private nonReentrant returns (uint256 requestId) {
        require(_tokenAmount > 0); // 'Token amount must be positive'

        (uint256 balance,,,,,) = totalBalance();

        if (_type == DEPOSIT_REQUEST_TYPE) {
            require(balance + _tokenAmount + totalDepositRequestsAmount <= depositCap, 'Cap reached');
        }

        requestId = nextRequestId;
        nextRequestId = nextRequestId + 1; // Overflow allowed to keep id cycling

        uint32 targetTimestamp = uint32(block.timestamp + requestDelay);

        requests[requestId] = Request(_type, _tokenAmount, targetTimestamp, msg.sender, _shouldStake);

        if (_type == DEPOSIT_REQUEST_TYPE) {
            totalDepositRequestsAmount += _tokenAmount;
        }

        collectRelevantTokens(_type, _tokenAmount);

        emit SubmitRequest(requestId, _type, _tokenAmount, targetTimestamp, msg.sender, balance, totalSupply());
    }

    function calculateDepositAmounts(uint256 _totalAmount, uint256 _dexVolTokenPrice, uint256 _intrinsicVolTokenPrice) private view returns (uint256 mintVolTokenUSDCAmount, uint256 platformLiquidityAmount, uint256 holdingsAmount) {
        holdingsAmount = _totalAmount * depositHoldingsPercentage / MAX_PERCENTAGE;
        uint256 leftAmount = _totalAmount - holdingsAmount;

        (uint256 cviValue, , ) = platform.cviOracle().getCVILatestRoundData();

        uint256 maxCVIValue = platform.maxCVIValue();
        (uint256 currentBalance,,,,,) = platform.calculatePositionBalance(address(volToken));

        mintVolTokenUSDCAmount = (cviValue * _intrinsicVolTokenPrice * MAX_PERCENTAGE * leftAmount) /
            (_intrinsicVolTokenPrice * extraLiqidityPercentage * maxCVIValue +
                (cviValue * _dexVolTokenPrice + _intrinsicVolTokenPrice * maxCVIValue) * MAX_PERCENTAGE);

        // Note: must be not-first mint (otherwise dex is empty, and this function won't be called)
        uint256 expectedMintedVolTokensAmount = (mintVolTokenUSDCAmount *
            IERC20Upgradeable(address(volToken)).totalSupply()) / currentBalance;

        (uint256 dexVolTokensAmount, uint256 dexUSDCAmount) = getReserves();
        uint256 usdcDEXAmount = (expectedMintedVolTokensAmount * dexUSDCAmount) / dexVolTokensAmount;

        platformLiquidityAmount = leftAmount - mintVolTokenUSDCAmount - usdcDEXAmount;
    }

    function addDEXLiquidity(uint256 _mintVolTokensUSDCAmount) private returns (uint256 addedLiquidityUSDCAmount, uint256 mintedVolTokenAmount) {
        mintedVolTokenAmount = mintVolTokens(_mintVolTokensUSDCAmount);

        (uint256 dexVolTokenAmount, uint256 dexUSDCAmount) = getReserves();
        uint256 _usdcDEXAmount = (mintedVolTokenAmount * dexUSDCAmount) / dexVolTokenAmount;

        uint256 addedVolTokenAmount;

        (addedVolTokenAmount, addedLiquidityUSDCAmount, ) = router.addLiquidity(address(volToken), address(token), mintedVolTokenAmount, _usdcDEXAmount, 
            mintedVolTokenAmount, _usdcDEXAmount, address(this), block.timestamp);

        require(addedLiquidityUSDCAmount == _usdcDEXAmount);
        require(addedVolTokenAmount == mintedVolTokenAmount);

        (dexVolTokenAmount, dexUSDCAmount) = getReserves();
    }

    function withdrawPlatformLiqudity(uint256 _lpTokensAmount, bool _catchRevert) private returns (uint256 withdrawnLiquidity, bool transactionSuccess) {
        transactionSuccess = true;

        if (_catchRevert) {
            (bool success, bytes memory returnData) = 
                address(platform).call(abi.encodePacked(platform.withdrawLPTokens.selector, abi.encode(_lpTokensAmount)));
            
            if (success) {
                (, withdrawnLiquidity) = abi.decode(returnData, (uint256, uint256));
            } else {
                transactionSuccess = false;
            }
        } else {
            (, withdrawnLiquidity) = platform.withdrawLPTokens(_lpTokensAmount);
        }
    }

    function burnVolTokens(uint256 _tokensToBurn) private returns (uint256 burnedVolTokensUSDCAmount) {
        uint168 __tokensToBurn = uint168(_tokensToBurn);
        require(__tokensToBurn == _tokensToBurn); // Sanity, should very rarely fail
        burnedVolTokensUSDCAmount = volToken.burnTokens(__tokensToBurn);
    }

    function mintVolTokens(uint256 _usdcAmount) private returns (uint256 mintedVolTokenAmount) {
        uint168 __usdcAmount = uint168(_usdcAmount);
        require(__usdcAmount == _usdcAmount); // Sanity, should very rarely fail
        mintedVolTokenAmount = volToken.mintTokens(__usdcAmount);
    }

    function collectRelevantTokens(uint8 _requestType, uint256 _tokenAmount) private {
        if (_requestType == WITHDRAW_REQUEST_TYPE) {
            require(balanceOf(msg.sender) >= _tokenAmount, 'Not enough tokens');
            IERC20Upgradeable(address(this)).safeTransferFrom(msg.sender, address(this), _tokenAmount);
        } else {
            token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
        }
    }

    function isLiquidable(uint256 _requestId) private view returns (bool) {
        return (requests[_requestId].targetTimestamp + liquidationPeriod < block.timestamp);
    }

    function _liquidateRequest(uint256 _requestId) private {
        Request memory request = requests[_requestId];

        if (request.requestType == DEPOSIT_REQUEST_TYPE) {
            totalDepositRequestsAmount -= request.tokenAmount;
        }

        deleteRequest(_requestId);

        if (request.requestType == WITHDRAW_REQUEST_TYPE) {
            IERC20Upgradeable(address(this)).safeTransfer(request.owner, request.tokenAmount);
        } else {
            token.safeTransfer(request.owner, request.tokenAmount);
        }

        emit LiquidateRequest(_requestId, request.requestType, request.owner, msg.sender, request.tokenAmount);
    }

    function deleteRequest(uint256 _requestId) private {
        delete requests[_requestId];

        uint256 currMinRequestId = minRequestId;
        uint256 increments = 0;
        bool didIncrement = false;

        while (currMinRequestId < nextRequestId && increments < maxMinRequestIncrements && requests[currMinRequestId].owner == address(0)) {
            increments++;
            currMinRequestId++;
            didIncrement = true;
        }

        if (didIncrement) {
            minRequestId = currMinRequestId;
        }
    }

    function getPair() private view returns (IUniswapV2Pair pair) {
        return IUniswapV2Pair(IUniswapV2Factory(router.factory()).getPair(address(volToken), address(token)));
    }

    function getReserves() public view override returns (uint256 volTokenAmount, uint256 usdcAmount) {
        (uint256 amount1, uint256 amount2, ) = getPair().getReserves();

        if (address(volToken) < address(token)) {
            volTokenAmount = amount1;
            usdcAmount = amount2;
        } else {
            volTokenAmount = amount2;
            usdcAmount = amount1;
        }
    }

    function getUSDCPlatformLiquidity() private view returns (uint256 usdcPlatformLiquidity) {
        uint256 platformLPTokensAmount = IERC20Upgradeable(address(platform)).balanceOf(address(this));

        if (platformLPTokensAmount > 0) {
            usdcPlatformLiquidity = (platformLPTokensAmount * platform.totalBalance(true)) / IERC20Upgradeable(address(platform)).totalSupply();
        }
    }
}
