// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "./interfaces/IPlatform.sol";

contract Platform is Initializable, IPlatform, OwnableUpgradeable, ERC20Upgradeable, ReentrancyGuardUpgradeable {

    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint80 public latestOracleRoundId;
    uint32 public latestSnapshotTimestamp;
    uint32 public maxTimeAllowedAfterLatestRound;

    bool private canPurgeLatestSnapshot;
    bool public emergencyWithdrawAllowed;
    bool private purgeSnapshots;

    uint8 public maxAllowedLeverage;
    uint16 public override maxCVIValue;

    uint168 public constant MAX_FEE_PERCENTAGE = 10000;
    uint256 public constant PRECISION_DECIMALS = 1e10;

    uint256 public initialTokenToLPTokenRate;

    IERC20Upgradeable public token;
    ICVIOracle public cviOracle;
    ILiquidation public liquidation;
    IFeesCalculator public feesCalculator;
    IFeesCollector public feesCollector;
    IRewardsCollector public rewards;

    uint256 public lpsLockupPeriod;
    uint256 public override buyersLockupPeriod;

    uint256 public totalPositionUnitsAmount;
    uint256 public totalFundingFeesAmount;
    uint256 public totalLeveragedTokensAmount;

    address public stakingContractAddress;
    
    mapping(uint256 => uint256) public cviSnapshots;

    mapping(address => uint256) public lastDepositTimestamp;
    mapping(address => Position) public override positions;

    mapping(address => bool) public noLockPositionAddresses;
    mapping(address => bool) public noPremiumFeeAllowedAddresses;
    mapping(address => bool) public increaseSharedPoolAllowedAddresses;

    mapping(address => bool) public revertLockedTransfered;

    function initialize(IERC20Upgradeable _token, string memory _lpTokenName, string memory _lpTokenSymbolName, uint256 _initialTokenToLPTokenRate, uint16 _maxCVIValue,
        IFeesCalculator _feesCalculator,
        ICVIOracle _cviOracle,
        ILiquidation _liquidation) public initializer {

        maxTimeAllowedAfterLatestRound = 5 hours;
        canPurgeLatestSnapshot = false;
        emergencyWithdrawAllowed = false;
        purgeSnapshots = true;

        maxAllowedLeverage = 1;

        lpsLockupPeriod = 3 days;
        buyersLockupPeriod = 6 hours;

        stakingContractAddress = address(0);

        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();
        OwnableUpgradeable.__Ownable_init();
        ERC20Upgradeable.__ERC20_init(_lpTokenName, _lpTokenSymbolName);

        token = _token;
        initialTokenToLPTokenRate = _initialTokenToLPTokenRate;
        maxCVIValue = _maxCVIValue;
        feesCalculator = _feesCalculator;
        cviOracle = _cviOracle;
        liquidation = _liquidation;
    }

    function deposit(uint256 _tokenAmount, uint256 _minLPTokenAmount) external virtual override returns (uint256 lpTokenAmount) {
        return _deposit(_tokenAmount, _minLPTokenAmount);
    }

    function withdraw(uint256 _tokenAmount, uint256 _maxLPTokenBurnAmount) external override returns (uint256 burntAmount, uint256 withdrawnAmount) {
        (burntAmount, withdrawnAmount) = _withdraw(_tokenAmount, false, _maxLPTokenBurnAmount);
    }

    function withdrawLPTokens(uint256 _lpTokensAmount) external override returns (uint256 burntAmount, uint256 withdrawnAmount) {
        require(_lpTokensAmount > 0); // "Amount must be positive"
        (burntAmount, withdrawnAmount) = _withdraw(0, true, _lpTokensAmount);
    }

    function increaseSharedPool(uint256 _tokenAmount) external virtual override {
        _increaseSharedPool(_tokenAmount);
    }

    function openPositionWithoutPremiumFee(uint168 _tokenAmount, uint16 _maxCVI, uint8 _leverage) external override virtual returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        require(noPremiumFeeAllowedAddresses[msg.sender]); // "Not allowed"
        return _openPosition(_tokenAmount, _maxCVI, 0, _leverage, false, false);
    }

    function openPositionWithoutVolumeFee(uint168 _tokenAmount, uint16 _maxCVI, uint16 _maxBuyingPremiumFeePercentage, uint8 _leverage) external override virtual returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        require(noPremiumFeeAllowedAddresses[msg.sender]); // "Not allowed"
        return _openPosition(_tokenAmount, _maxCVI, _maxBuyingPremiumFeePercentage, _leverage, true, false);
    }

    function openPosition(uint168 _tokenAmount, uint16 _maxCVI, uint16 _maxBuyingPremiumFeePercentage, uint8 _leverage) external override virtual returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        return _openPosition(_tokenAmount, _maxCVI, _maxBuyingPremiumFeePercentage, _leverage, true, true);
    }

    function closePositionWithoutVolumeFee(uint168 _positionUnitsAmount, uint16 _minCVI) external override virtual returns (uint256 tokenAmount) {
        require(noPremiumFeeAllowedAddresses[msg.sender]); // "Not allowed"
        return _closePosition(_positionUnitsAmount, _minCVI, 0, false);
    }

    function closePosition(uint168 _positionUnitsAmount, uint16 _minCVI, uint16 _maxClosingPremiumFeePercentage) external override virtual returns (uint256 tokenAmount) {
        return _closePosition(_positionUnitsAmount, _minCVI, _maxClosingPremiumFeePercentage, true);
    }

    function _closePosition(uint168 _positionUnitsAmount, uint16 _minCVI, uint16 _maxClosingPremiumFeePercentage, bool _chargeVolumeFee) private nonReentrant returns (uint256 tokenAmount) {
        require(_positionUnitsAmount > 0); // "Position units not positive"
        require(_minCVI > 0 && _minCVI <= maxCVIValue); // "Bad min CVI value"

        Position storage position = positions[msg.sender];

        require(position.positionUnitsAmount >= _positionUnitsAmount); // "Not enough opened position units"
        require(block.timestamp - position.creationTimestamp >= buyersLockupPeriod  || noLockPositionAddresses[msg.sender], "Position locked");

        (uint16 cviValue, uint256 latestSnapshot,) = updateSnapshots(true);
        require(cviValue >= _minCVI, "CVI too low");

        uint256 positionBalance;
        uint256 fundingFees;
        uint256 marginDebt;

        {
            bool wasLiquidated;

            (positionBalance, fundingFees, marginDebt, wasLiquidated) = _closePosition(position, _positionUnitsAmount, latestSnapshot, cviValue);

            // If was liquidated, balance is negative, nothing to return
            if (wasLiquidated) {
                return 0;
            }
        }

        uint256 lastCollateralRatio = totalPositionUnitsAmount * PRECISION_DECIMALS / totalLeveragedTokensAmount;
        (totalPositionUnitsAmount, totalFundingFeesAmount) = subtractTotalPositionUnits(_positionUnitsAmount, fundingFees);

        uint256 closingPremiumFeePercentage = 0;

        {
            if (_chargeVolumeFee) {
                uint256 collateralRatio = totalPositionUnitsAmount * PRECISION_DECIMALS / (totalLeveragedTokensAmount - positionBalance - marginDebt);

                feesCalculator.updateCloseAdjustedTimestamp(collateralRatio, lastCollateralRatio);
                closingPremiumFeePercentage = feesCalculator.calculateClosingPremiumFee(positionBalance, collateralRatio, lastCollateralRatio, _chargeVolumeFee);

                require(closingPremiumFeePercentage <= _maxClosingPremiumFeePercentage, "Premium fee too high");
            } else if (feesCalculator.openPositionLPFeePercent() > 0) {
                closingPremiumFeePercentage = feesCalculator.closePositionLPFeePercent();
            }
        }

        position.positionUnitsAmount = position.positionUnitsAmount - _positionUnitsAmount;

        uint256 closePositionFee = positionBalance * feesCalculator.calculateClosePositionFeePercent(position.creationTimestamp, noLockPositionAddresses[msg.sender]) / MAX_FEE_PERCENTAGE;
        uint256 closingPremiumFee = positionBalance * closingPremiumFeePercentage / MAX_FEE_PERCENTAGE;

        emit ClosePosition(msg.sender, positionBalance + fundingFees, closePositionFee + closingPremiumFee + fundingFees, position.positionUnitsAmount, position.leverage, cviValue);

        if (position.positionUnitsAmount == 0) {
            delete positions[msg.sender];
        }

        totalLeveragedTokensAmount = totalLeveragedTokensAmount - positionBalance - marginDebt + closingPremiumFee;
        tokenAmount = positionBalance - closePositionFee - closingPremiumFee;

        collectProfit(closePositionFee);
        transferFunds(tokenAmount);
    }

    function _closePosition(Position storage _position, uint256 _positionUnitsAmount, uint256 _latestSnapshot, uint16 _cviValue) private returns (uint256 positionBalance, uint256 fundingFees, uint256 marginDebt, bool wasLiquidated) {
        fundingFees = _calculateFundingFees(cviSnapshots[_position.creationTimestamp], _latestSnapshot, _positionUnitsAmount);
        
        (uint256 currentPositionBalance, bool isPositive, uint256 __marginDebt) = __calculatePositionBalance(_positionUnitsAmount, _position.leverage, _cviValue, _position.openCVIValue, fundingFees);
        
        // Position might be liquidable but balance is positive, we allow to avoid liquidity in such a condition
        if (!isPositive) {
            checkAndLiquidatePosition(msg.sender, false); // Will always liquidate
            wasLiquidated = true;
            fundingFees = 0;
        } else {
            positionBalance = currentPositionBalance;
            marginDebt = __marginDebt;
        }
    }

    function liquidatePositions(address[] calldata _positionOwners) external override nonReentrant returns (uint256 finderFeeAmount) {
        updateSnapshots(true);
        bool liquidationOccured = false;
        for ( uint256 i = 0; i < _positionOwners.length; i++) {
            Position memory position = positions[_positionOwners[i]];

            if (position.positionUnitsAmount > 0) {
                (bool wasLiquidated, uint256 liquidatedAmount, bool isPositive) = checkAndLiquidatePosition(_positionOwners[i], false);

                if (wasLiquidated) {
                    liquidationOccured = true;
                    finderFeeAmount = finderFeeAmount + liquidation.getLiquidationReward(liquidatedAmount, isPositive, position.positionUnitsAmount, position.openCVIValue, position.leverage);
                }
            }
        }

        require(liquidationOccured, "No liquidable position");

        totalLeveragedTokensAmount = totalLeveragedTokensAmount - finderFeeAmount;
        transferFunds(finderFeeAmount);
    }

    function setSubContracts(IFeesCollector _newCollector, ICVIOracle _newOracle, IRewardsCollector _newRewards, ILiquidation _newLiquidation, address _newStakingContractAddress) external override onlyOwner {
        if (address(feesCollector) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(feesCollector), 0);
        }

        feesCollector = _newCollector;

        if (address(_newCollector) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(_newCollector), type(uint256).max);
        }

        cviOracle = _newOracle;
        rewards = _newRewards;
        liquidation = _newLiquidation;
        stakingContractAddress = _newStakingContractAddress;
    }

    function setFeesCalculator(IFeesCalculator _newCalculator) external override onlyOwner {
        feesCalculator = _newCalculator;
    }

    function setLatestOracleRoundId(uint80 _newOracleRoundId) external override onlyOwner {
        latestOracleRoundId = _newOracleRoundId;
    }

    function setMaxTimeAllowedAfterLatestRound(uint32 _newMaxTimeAllowedAfterLatestRound) external override onlyOwner {
        require(_newMaxTimeAllowedAfterLatestRound >= 1 hours); // "Max time too short"
        maxTimeAllowedAfterLatestRound = _newMaxTimeAllowedAfterLatestRound;
    }

    function setLockupPeriods(uint256 _newLPLockupPeriod, uint256 _newBuyersLockupPeriod) external override onlyOwner {
        require(_newLPLockupPeriod <= 2 weeks); // "Lockup too long"
        lpsLockupPeriod = _newLPLockupPeriod;

        require(_newBuyersLockupPeriod <= 1 weeks); // "Lockup too long"
        buyersLockupPeriod = _newBuyersLockupPeriod;
    }

    function setAddressSpecificParameters(address _holderAddress, bool _shouldLockPosition, bool _noPremiumFeeAllowed, bool _increaseSharedPoolAllowed) external override onlyOwner {
        noLockPositionAddresses[_holderAddress] = !_shouldLockPosition;
        noPremiumFeeAllowedAddresses[_holderAddress] = _noPremiumFeeAllowed;
        increaseSharedPoolAllowedAddresses[_holderAddress] = _increaseSharedPoolAllowed;
    }

    function setRevertLockedTransfers(bool _revertLockedTransfers) external override {
        revertLockedTransfered[msg.sender] = _revertLockedTransfers;   
    }

    function setEmergencyParameters(bool _newEmergencyWithdrawAllowed, bool _newCanPurgeSnapshots) external override onlyOwner {
        emergencyWithdrawAllowed = _newEmergencyWithdrawAllowed;
        purgeSnapshots = _newCanPurgeSnapshots;
    }

    function setMaxAllowedLeverage(uint8 _newMaxAllowedLeverage) external override onlyOwner {
        maxAllowedLeverage = _newMaxAllowedLeverage;
    }

    function calculatePositionBalance(address _positionAddress) external view override returns (uint256 currentPositionBalance, bool isPositive, uint168 positionUnitsAmount, uint8 leverage, uint256 fundingFees, uint256 marginDebt) {
        positionUnitsAmount = positions[_positionAddress].positionUnitsAmount;
        leverage = positions[_positionAddress].leverage;
        require(positionUnitsAmount > 0); // "No position for given address"
        (currentPositionBalance, isPositive, fundingFees, marginDebt) = _calculatePositionBalance(_positionAddress, true);
    }

    function calculatePositionPendingFees(address _positionAddress, uint168 _positionUnitsAmount) external view override returns (uint256 pendingFees) {
        Position memory position = positions[_positionAddress];
        require(position.positionUnitsAmount > 0); // "No position for given address"
        require(_positionUnitsAmount <= position.positionUnitsAmount); // "Too many position units"
        pendingFees = _calculateFundingFees(cviSnapshots[position.creationTimestamp], 
            cviSnapshots[latestSnapshotTimestamp], _positionUnitsAmount) + calculateLatestFundingFees(latestSnapshotTimestamp, _positionUnitsAmount);
    }

    function totalBalance(bool _withAddendum) public view override returns (uint256 balance) {
        (uint16 cviValue,,) = cviOracle.getCVILatestRoundData();
        return _totalBalance(cviValue) + (_withAddendum ? calculateLatestFundingFees(latestSnapshotTimestamp, totalPositionUnitsAmount) : 0);
    }

    function calculateLatestTurbulenceIndicatorPercent() external view override returns (uint16) {
        (uint16 latestCVIValue, ) = cviOracle.getCVIRoundData(latestOracleRoundId);
        IFeesCalculator.SnapshotUpdate memory updateData = 
            feesCalculator.updateSnapshots(latestSnapshotTimestamp, cviSnapshots[block.timestamp], cviSnapshots[latestSnapshotTimestamp], latestOracleRoundId);
        if (updateData.updatedTurbulenceData) {
            return feesCalculator.calculateTurbulenceIndicatorPercent(updateData.totalTime, updateData.totalRounds, latestCVIValue, updateData.cviValue);
        } else {
            return feesCalculator.turbulenceIndicatorPercent();
        }
    }

    function collectTokens(uint256 _tokenAmount) internal virtual {
        token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
    }

    function _deposit(uint256 _tokenAmount, uint256 _minLPTokenAmount) internal nonReentrant returns (uint256 lpTokenAmount) {
        require(_tokenAmount > 0); // "Tokens amount must be positive"
        lastDepositTimestamp[msg.sender] = block.timestamp;

        (uint16 cviValue,, uint256 cviValueTimestamp) = updateSnapshots(true);
        require(cviValueTimestamp + maxTimeAllowedAfterLatestRound >= block.timestamp, "Latest cvi too long ago");

        uint256 depositFee = _tokenAmount * feesCalculator.depositFeePercent() / MAX_FEE_PERCENTAGE;

        uint256 tokenAmountToDeposit = _tokenAmount - depositFee;
        uint256 supply = totalSupply();
        uint256 balance = _totalBalance(cviValue);
    
        if (supply > 0 && balance > 0) {
            lpTokenAmount = tokenAmountToDeposit * supply / balance;
        } else {
            lpTokenAmount = tokenAmountToDeposit * initialTokenToLPTokenRate;
        }

        emit Deposit(msg.sender, _tokenAmount, lpTokenAmount, depositFee);

        require(lpTokenAmount >= _minLPTokenAmount, "Too few LP tokens");
        require(lpTokenAmount > 0); // "Too few tokens"

        totalLeveragedTokensAmount = totalLeveragedTokensAmount + tokenAmountToDeposit;

        _mint(msg.sender, lpTokenAmount);
        collectTokens(_tokenAmount);
        collectProfit(depositFee);
    }

    function _withdraw(uint256 _tokenAmount, bool _shouldBurnMax, uint256 _maxLPTokenBurnAmount) internal nonReentrant returns (uint256 burntAmount, uint256 withdrawnAmount) {
        require(lastDepositTimestamp[msg.sender] + lpsLockupPeriod <= block.timestamp, "Funds are locked");

        (uint16 cviValue,,) = updateSnapshots(true);

        if (_shouldBurnMax) {
            burntAmount = _maxLPTokenBurnAmount;
            _tokenAmount = burntAmount * _totalBalance(cviValue) / totalSupply();
        } else {
            require(_tokenAmount > 0); // "Tokens amount must be positive"

            // Note: rounding up (ceiling) the to-burn amount to prevent precision loss
            burntAmount = (_tokenAmount * totalSupply() - 1) / _totalBalance(cviValue) + 1;
            require(burntAmount <= _maxLPTokenBurnAmount, "Too much LP tokens to burn");
        }

        require(burntAmount <= balanceOf(msg.sender), "Not enough LP tokens for account");
        require(emergencyWithdrawAllowed || totalLeveragedTokensAmount - totalPositionUnitsAmount >= _tokenAmount, "Collateral ratio broken");

        totalLeveragedTokensAmount = totalLeveragedTokensAmount - _tokenAmount;

        uint256 withdrawFee = _tokenAmount * feesCalculator.withdrawFeePercent() / MAX_FEE_PERCENTAGE;
        withdrawnAmount = _tokenAmount - withdrawFee;

        emit Withdraw(msg.sender, _tokenAmount, burntAmount, withdrawFee);
        
        _burn(msg.sender, burntAmount);

        collectProfit(withdrawFee);
        transferFunds(withdrawnAmount);
    }

    function _increaseSharedPool(uint256 _tokenAmount) internal nonReentrant {
        require(increaseSharedPoolAllowedAddresses[msg.sender]); // "Not allowed"
        totalLeveragedTokensAmount = totalLeveragedTokensAmount + _tokenAmount;
        collectTokens(_tokenAmount);
    }

    struct OpenPositionLocals {
        uint256 totalLeveragedTokensAmount;
        uint256 collateralRatio;
        uint256 latestSnapshot;
        uint256 openPositionFee;
        uint256 maxPositionUnitsAmount;
        uint256 lastCollateralRatio;
        uint256 __positionUnitsAmount;
        uint256 cviValueTimestamp;
        uint168 addedPositionUnitsAmount;
        uint168 buyingPremiumFee;
        uint168 buyingPremiumFeePercentage;
        uint16 cviValue;
        uint16 openPositionFeePercent;
        uint16 buyingPremiumFeeMaxPercent;
    }

    function _openPosition(uint168 _tokenAmount, uint16 _maxCVI, uint168 _maxBuyingPremiumFeePercentage, uint8 _leverage, bool _chargePremiumFee, bool _chargeVolumeFee) internal nonReentrant returns (uint168 positionUnitsAmount, uint168 positionedTokenAmount) {
        require(_leverage > 0); // "Leverage must be positive"
        require(_leverage <= maxAllowedLeverage); // "Leverage excceeds max allowed"
        require(_tokenAmount > 0); // "Tokens amount must be positive"
        require(_maxCVI > 0 && _maxCVI <= maxCVIValue); // "Bad max CVI value"

        OpenPositionLocals memory locals;

        (locals.cviValue, locals.latestSnapshot, locals.cviValueTimestamp) = updateSnapshots(false);
        require(locals.cviValue <= _maxCVI, "CVI too high");
        require(locals.cviValueTimestamp + maxTimeAllowedAfterLatestRound >= block.timestamp, "Latest cvi too long ago");

        (locals.openPositionFeePercent, locals.buyingPremiumFeeMaxPercent) = feesCalculator.openPositionFees();

        locals.openPositionFee = _tokenAmount * _leverage * locals.openPositionFeePercent / MAX_FEE_PERCENTAGE;

        // Calculate buying premium fee, assuming the maxmimum 

        locals.totalLeveragedTokensAmount = totalLeveragedTokensAmount;

        if (_chargePremiumFee) {
            locals.lastCollateralRatio = totalPositionUnitsAmount * PRECISION_DECIMALS / locals.totalLeveragedTokensAmount;

            locals.maxPositionUnitsAmount = (uint256(_tokenAmount) - locals.openPositionFee) * _leverage * maxCVIValue / locals.cviValue;
            locals.collateralRatio = (totalPositionUnitsAmount + locals.maxPositionUnitsAmount) * PRECISION_DECIMALS / 
                (locals.totalLeveragedTokensAmount + (_tokenAmount - locals.openPositionFee) * _leverage);

            if (_chargeVolumeFee) {
                feesCalculator.updateAdjustedTimestamp(locals.collateralRatio, locals.lastCollateralRatio);
            }

            (locals.buyingPremiumFee, locals.buyingPremiumFeePercentage) = feesCalculator.calculateBuyingPremiumFee(_tokenAmount, _leverage, locals.collateralRatio, locals.lastCollateralRatio, _chargeVolumeFee);

            require(locals.buyingPremiumFeePercentage <= _maxBuyingPremiumFeePercentage, "Premium fee too high");
        } else if (feesCalculator.openPositionLPFeePercent() > 0) {
            locals.buyingPremiumFeePercentage = feesCalculator.openPositionLPFeePercent();
            locals.buyingPremiumFee = _tokenAmount * _leverage * locals.buyingPremiumFeePercentage / MAX_FEE_PERCENTAGE;
        }
        
        // Leaving buying premium in shared pool
        positionedTokenAmount = uint168((_tokenAmount - locals.openPositionFee - locals.buyingPremiumFee) * _leverage);
        
        Position storage position = positions[msg.sender];

        if (position.positionUnitsAmount > 0) {
            require(_leverage == position.leverage); // "Cannot merge different margin"
            MergePositionResults memory mergePositionResults = _mergePosition(position, locals.latestSnapshot, locals.cviValue, positionedTokenAmount, _leverage);
            positionUnitsAmount = mergePositionResults.positionUnitsAmount;
            locals.addedPositionUnitsAmount = mergePositionResults.addedPositionUnitsAmount;
            totalLeveragedTokensAmount = locals.totalLeveragedTokensAmount + positionedTokenAmount + mergePositionResults.positionBalance * _leverage + locals.buyingPremiumFee -
                mergePositionResults.marginDebt - mergePositionResults.positionBalance;
        } else {
            locals.__positionUnitsAmount = uint256(positionedTokenAmount) * maxCVIValue / locals.cviValue;
            positionUnitsAmount = uint168(locals.__positionUnitsAmount);
            require(positionUnitsAmount == locals.__positionUnitsAmount); // "Too much position units"

            locals.addedPositionUnitsAmount = positionUnitsAmount;

            Position memory newPosition = Position(positionUnitsAmount, _leverage, locals.cviValue, uint32(block.timestamp), uint32(block.timestamp));

            positions[msg.sender] = newPosition;
            totalPositionUnitsAmount = totalPositionUnitsAmount + positionUnitsAmount;

            totalLeveragedTokensAmount = locals.totalLeveragedTokensAmount + positionedTokenAmount + locals.buyingPremiumFee;
        }

        emit OpenPosition(msg.sender, _tokenAmount, _leverage, locals.openPositionFee + locals.buyingPremiumFee, positionUnitsAmount, locals.cviValue);

        collectTokens(_tokenAmount);
        collectProfit(locals.openPositionFee);

        require(totalPositionUnitsAmount <= totalLeveragedTokensAmount, "Not enough liquidity");

        if (address(rewards) != address(0) && locals.addedPositionUnitsAmount != 0) {
            rewards.reward(msg.sender, locals.addedPositionUnitsAmount, _leverage);
        }
    }

    struct MergePositionResults {
        uint168 positionUnitsAmount;
        uint168 addedPositionUnitsAmount;
        uint256 marginDebt;
        uint256 positionBalance;
    }

    struct MergePositionLocals {
        uint32 originalCreationTimestamp;
        uint168 oldPositionUnits;
        uint256 newPositionUnits;
        uint256 newTotalPositionUnitsAmount;
        uint256 newTotalFundingFeesAmount;
    }

    function _mergePosition(Position storage _position, uint256 _latestSnapshot, uint16 _cviValue, uint256 _leveragedTokenAmount, uint8 _leverage) private returns (MergePositionResults memory mergePositionResults) {
        MergePositionLocals memory locals;

        locals.oldPositionUnits = _position.positionUnitsAmount;
        locals.originalCreationTimestamp = _position.originalCreationTimestamp;
        (uint256 currentPositionBalance, uint256 fundingFees, uint256 __marginDebt, bool wasLiquidated) = _closePosition(_position, locals.oldPositionUnits, _latestSnapshot, _cviValue);
        
        // If was liquidated, balance is negative
        if (wasLiquidated) {
            currentPositionBalance = 0;
            locals.oldPositionUnits = 0;
            __marginDebt = 0;

            _position.originalCreationTimestamp = locals.originalCreationTimestamp;
        }

        locals.newPositionUnits = (currentPositionBalance * _leverage + _leveragedTokenAmount) * maxCVIValue / _cviValue;
        mergePositionResults.positionUnitsAmount = uint168(locals.newPositionUnits);
        require(mergePositionResults.positionUnitsAmount == locals.newPositionUnits); // "Too much position units"

        _position.creationTimestamp = uint32(block.timestamp);
        _position.positionUnitsAmount = mergePositionResults.positionUnitsAmount;
        _position.openCVIValue = _cviValue;
        _position.leverage = _leverage;

        (locals.newTotalPositionUnitsAmount, locals.newTotalFundingFeesAmount) = subtractTotalPositionUnits(locals.oldPositionUnits, fundingFees);
        totalFundingFeesAmount = locals.newTotalFundingFeesAmount;
        totalPositionUnitsAmount = locals.newTotalPositionUnitsAmount + mergePositionResults.positionUnitsAmount;
        mergePositionResults.marginDebt = __marginDebt;
        mergePositionResults.positionBalance = currentPositionBalance;

        if (locals.oldPositionUnits < mergePositionResults.positionUnitsAmount) {
            mergePositionResults.addedPositionUnitsAmount = mergePositionResults.positionUnitsAmount - locals.oldPositionUnits;
        }
    }

    function transferFunds(uint256 _tokenAmount) internal virtual {
        token.safeTransfer(msg.sender, _tokenAmount);
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal override {
        if (from == stakingContractAddress) {
            lastDepositTimestamp[to] = block.timestamp;
        } else if (lastDepositTimestamp[from] + lpsLockupPeriod > block.timestamp && 
            lastDepositTimestamp[from] > lastDepositTimestamp[to] && 
            to != stakingContractAddress) {
                require(!revertLockedTransfered[to], "Recipient refuses locked tokens");
                lastDepositTimestamp[to] = lastDepositTimestamp[from];
        }
    }

    function sendProfit(uint256 _amount, IERC20Upgradeable _token) internal virtual {
        feesCollector.sendProfit(_amount, IERC20(address(_token)));
    }

    function updateSnapshots(bool _canPurgeLatestSnapshot) private returns (uint16 latestCVIValue, uint256 latestSnapshot, uint256 latestCVIValueTimestamp) {
        uint80 originalLatestRoundId = latestOracleRoundId;
        uint256 latestTimestamp = latestSnapshotTimestamp;

        IFeesCalculator.SnapshotUpdate memory updateData = 
            feesCalculator.updateSnapshots(latestTimestamp, cviSnapshots[block.timestamp], cviSnapshots[latestTimestamp], latestOracleRoundId);

        if (updateData.updatedSnapshot) {
            cviSnapshots[block.timestamp] = updateData.latestSnapshot;
            totalFundingFeesAmount = totalFundingFeesAmount + (updateData.singleUnitFundingFee * totalPositionUnitsAmount / PRECISION_DECIMALS);
        }

        if (updateData.updatedLatestRoundId) {
            latestOracleRoundId = updateData.newLatestRoundId;
        }

        if (updateData.updatedTurbulenceData) {
            (latestCVIValue, ) = cviOracle.getCVIRoundData(originalLatestRoundId);
            feesCalculator.updateTurbulenceIndicatorPercent(updateData.totalTime, updateData.totalRounds, latestCVIValue, updateData.cviValue);
        }

        if (updateData.updatedLatestTimestamp) {
            latestSnapshotTimestamp = uint32(block.timestamp);

            // Delete old snapshot if it can be deleted (not an open snapshot) to save gas
            if (canPurgeLatestSnapshot && purgeSnapshots) {
                delete cviSnapshots[latestTimestamp];
            }

            // Update purge since timestamp has changed and it is safe
            canPurgeLatestSnapshot = _canPurgeLatestSnapshot;
        } else if (canPurgeLatestSnapshot) {
            // Update purge only from true to false, so if an open was in the block, will never be purged
            canPurgeLatestSnapshot = _canPurgeLatestSnapshot;
        }

        return (updateData.cviValue, updateData.latestSnapshot, updateData.cviValueTimestamp);
    }

    function _totalBalance(uint16 _cviValue) private view returns (uint256 balance) {
        return totalLeveragedTokensAmount + totalFundingFeesAmount - (totalPositionUnitsAmount * _cviValue) / maxCVIValue;
    }

    function collectProfit(uint256 amount) private {
        if (amount > 0 && address(feesCollector) != address(0)) {
            sendProfit(amount, token);
        }
    }

    function checkAndLiquidatePosition(address _positionAddress, bool _withAddendum) private returns (bool wasLiquidated, uint256 liquidatedAmount, bool isPositive) {
        (uint256 currentPositionBalance, bool isBalancePositive, uint256 fundingFees, uint256 marginDebt) = _calculatePositionBalance(_positionAddress, _withAddendum);
        isPositive = isBalancePositive;
        liquidatedAmount = currentPositionBalance;

        Position memory position = positions[_positionAddress];

        if (liquidation.isLiquidationCandidate(currentPositionBalance, isBalancePositive, position.positionUnitsAmount, position.openCVIValue, position.leverage)) {
            (uint256 newTotalPositionUnitsAmount, uint256 newTotalFundingFeesAmount) = subtractTotalPositionUnits(position.positionUnitsAmount, fundingFees);
            totalPositionUnitsAmount = newTotalPositionUnitsAmount;
            totalFundingFeesAmount = newTotalFundingFeesAmount;
            totalLeveragedTokensAmount = totalLeveragedTokensAmount - marginDebt;

            emit LiquidatePosition(_positionAddress, currentPositionBalance, isBalancePositive, position.positionUnitsAmount);

            delete positions[_positionAddress];
            wasLiquidated = true;
        }
    }

    function subtractTotalPositionUnits(uint168 _positionUnitsAmountToSubtract, uint256 _fundingFeesToSubtract) private view returns (uint256 newTotalPositionUnitsAmount, uint256 newTotalFundingFeesAmount) {
        newTotalPositionUnitsAmount = totalPositionUnitsAmount - _positionUnitsAmountToSubtract;
        newTotalFundingFeesAmount = totalFundingFeesAmount;
        if (newTotalPositionUnitsAmount == 0) {
            newTotalFundingFeesAmount = 0;
        } else {
            newTotalFundingFeesAmount = newTotalFundingFeesAmount - _fundingFeesToSubtract;
        }
    }

    function _calculatePositionBalance(address _positionAddress, bool _withAddendum) private view returns (uint256 currentPositionBalance, bool isPositive, uint256 fundingFees, uint256 marginDebt) {
        Position memory position = positions[_positionAddress];

        (uint16 cviValue,,) = cviOracle.getCVILatestRoundData();

        fundingFees = _calculateFundingFees(cviSnapshots[position.creationTimestamp], cviSnapshots[latestSnapshotTimestamp], position.positionUnitsAmount);
        if (_withAddendum) {
            fundingFees = fundingFees + calculateLatestFundingFees(latestSnapshotTimestamp, position.positionUnitsAmount);
        }
        
        (currentPositionBalance, isPositive, marginDebt) = __calculatePositionBalance(position.positionUnitsAmount, position.leverage, cviValue, position.openCVIValue, fundingFees);
    }

    function __calculatePositionBalance(uint256 _positionUnits, uint8 _leverage, uint16 _cviValue, uint16 _openCVIValue, uint256 _fundingFees) private view returns (uint256 currentPositionBalance, bool isPositive, uint256 marginDebt) {
        uint256 positionBalanceWithoutFees = _positionUnits * _cviValue / maxCVIValue;

        marginDebt = _leverage > 1 ? _positionUnits * _openCVIValue * (_leverage - 1) / maxCVIValue / _leverage : 0;
        uint256 totalDebt = marginDebt + _fundingFees;

        if (positionBalanceWithoutFees >= totalDebt) {
            currentPositionBalance = positionBalanceWithoutFees - totalDebt;
            isPositive = true;
        } else {
            currentPositionBalance = totalDebt - positionBalanceWithoutFees;
        }
    }

    function calculateLatestFundingFees(uint256 startTime, uint256 positionUnitsAmount) private view returns (uint256) {
        IFeesCalculator.SnapshotUpdate memory updateData = 
            feesCalculator.updateSnapshots(latestSnapshotTimestamp, cviSnapshots[block.timestamp], cviSnapshots[latestSnapshotTimestamp], latestOracleRoundId);
        return _calculateFundingFees(cviSnapshots[startTime], updateData.latestSnapshot, positionUnitsAmount);
    }

    function _calculateFundingFees(uint256 startTimeSnapshot, uint256 endTimeSnapshot, uint256 positionUnitsAmount) internal pure returns (uint256) {
        return (endTimeSnapshot - startTimeSnapshot) * positionUnitsAmount / PRECISION_DECIMALS;
    }
}
