// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./utils/SafeMath16.sol";
import "./interfaces/IPlatform.sol";

contract Platform is IPlatform, Ownable, ERC20 {

    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    struct Position {
        uint256 positionUnitsAmount;
        uint256 creationTimestamp;
        uint256 pendingFees; // Funding fees calculated for earlier positions before merge (if occured)
        uint256 positionAddressesIndex;    
    }  

    uint256 public constant MAX_FEE_PERCENTAGE = 10000;
    uint256 public constant MAX_PERCENTAGE = 1000000;

    uint256 public constant PRECISION_DECIMALS = 1e10;

    uint256 public constant MAX_CVI_VALUE = 20000;

    uint256 public immutable initialTokenToLPTokenRate;

    IERC20 private token;
    ICVIOracle private cviOracle;
    IRewards private rewards;
    ILiquidation private liquidation;
    IFeesModel private feesModel;
    IFeesCalculator private feesCalculator;
    IFeesCollector private feesCollector;

    uint256 public lpsLockupPeriod = 3 days;
    uint256 public buyersLockupPeriod = 24 hours;

    uint256 public totalPositionUnitsAmount;
    uint256 public totalFundingFeesAmount;

    bool public emergencyWithdrawAllowed = false;

    mapping(address => uint256) public lastDepositTimestamp;
    mapping(address => Position) public positions;

    mapping(address => bool) public revertLockedTransfered;

    address[] private holdersAddresses;

    constructor(IERC20 _token, string memory _lpTokenName, string memory _lpTokenSymbolName, uint256 _initialTokenToLPTokenRate,
        IFeesModel _feesModel,
        IFeesCalculator _feesCalculator,
        ICVIOracle _cviOracle,
        ILiquidation _liquidation) ERC20(_lpTokenName, _lpTokenSymbolName) {

        token = _token;
        initialTokenToLPTokenRate = _initialTokenToLPTokenRate;
        feesModel = _feesModel;
        feesCalculator = _feesCalculator;
        cviOracle = _cviOracle;
        liquidation = _liquidation;
    }

    function deposit(uint256 _tokenAmount, uint256 _minLPTokenAmount) external override returns (uint256 lpTokenAmount) {
        lpTokenAmount = _deposit(_tokenAmount, _minLPTokenAmount, true);
    }    

    function withdraw(uint256 _tokenAmount, uint256 _maxLPTokenBurnAmount) external override returns (uint256 burntAmount, uint256 withdrawnAmount) {
        (burntAmount, withdrawnAmount) = _withdraw(_tokenAmount, false, _maxLPTokenBurnAmount, true);
    }

    function withdrawLPTokens(uint256 _lpTokensAmount) external override returns (uint256 burntAmount, uint256 withdrawnAmount) {
        require(_lpTokensAmount > 0, "Amount must be positive");
        (burntAmount, withdrawnAmount) = _withdraw(0, true, _lpTokensAmount, true);
    }

    function openPosition(uint256 _tokenAmount, uint16 _maxCVI) external override returns (uint256 positionUnitsAmount) {
        positionUnitsAmount = _openPosition(_tokenAmount, _maxCVI, true);
    }

    function closePosition(uint256 _positionUnitsAmount, uint16 _minCVI) external override returns (uint256 tokenAmount) {
        tokenAmount = _closePosition(_positionUnitsAmount, _minCVI, true);
    }

    function liquidatePositions(address[] calldata _positionOwners) external override returns (uint256 finderFeeAmount) {
        finderFeeAmount = _liquidatePositions(_positionOwners);
    }

    function setCVIOracle(ICVIOracle _newOracle) external override onlyOwner {
        cviOracle = _newOracle;
    }

    function setRewards(IRewards _newRewards) external override onlyOwner {
        rewards = _newRewards;
    }

    function setLiquidation(ILiquidation _newLiquidation) external override onlyOwner {
        liquidation = _newLiquidation;
    }

    function setFeesCollector(IFeesCollector _newCollector) external override onlyOwner {
        feesCollector = _newCollector;
        if (address(_newCollector) != address(0)) {
            token.safeApprove(address(feesCollector), uint256(-1));
        }
    }

    function setFeesModel(IFeesModel _newModel) external override onlyOwner {
        feesModel = _newModel;
    }
    
    function setLPLockupPeriod(uint256 _newLPLockupPeriod) external override onlyOwner {
        require(_newLPLockupPeriod <= 2 weeks, "Lockup too long");
        lpsLockupPeriod = _newLPLockupPeriod;
    }

    function setBuyersLockupPeriod(uint256 _newBuyersLockupPeriod) external override onlyOwner {
        require(_newBuyersLockupPeriod <= 1 weeks, "Lockup too long");
        buyersLockupPeriod = _newBuyersLockupPeriod;
    }

    function setRevertLockedTransfers(bool _revertLockedTransfers) external override {
        revertLockedTransfered[msg.sender] = _revertLockedTransfers;   
    }

    function setFeesCalculator(IFeesCalculator _newCalculator) external override onlyOwner {
        feesCalculator = _newCalculator;
    }

    function setEmergencyWithdrawAllowed(bool _newEmergencyWithdrawAllowed) external override onlyOwner {
        emergencyWithdrawAllowed = _newEmergencyWithdrawAllowed;
    }

    function getToken() external view override returns (IERC20) {
        return token;
    }

    function calculatePositionBalance(address _positionAddress) public view override returns (uint256 currentPositionBalance, bool isPositive, uint256 positionUnitsAmount) {
        positionUnitsAmount = positions[_positionAddress].positionUnitsAmount;
        require(positionUnitsAmount > 0, "No position for given address");
        (currentPositionBalance, isPositive) = _calculatePositionBalance(_positionAddress);
    }

    function calculatePositionPendingFees(address _positionAddress) public view override returns (uint256 pendingFees) {
        Position memory position = positions[_positionAddress];
        pendingFees = position.pendingFees.add(feesModel.calculateFundingFees(position.creationTimestamp, position.positionUnitsAmount))
        .add(feesModel.calculateFundingFeesAddendum(position.positionUnitsAmount));
    }

    function totalBalance() public view override returns (uint256 balance) {
        (uint16 cviValue,) = cviOracle.getCVILatestRoundData();
        return token.balanceOf(address(this)).sub(totalPositionUnitsAmount.mul(cviValue).div(MAX_CVI_VALUE)).add(totalFundingFeesAmount);
    }

    function totalBalanceWithAddendum() public view override returns (uint256 balance) {
        return totalBalance().add(feesModel.calculateFundingFeesAddendum(totalPositionUnitsAmount));
    }

    function getLiquidableAddresses() external view override returns (address[] memory) {
        address[] memory addressesToLiquidate = new address[](holdersAddresses.length);

        uint256 liquidationAddressesAmount = 0;
        for (uint256 i = 0; i < holdersAddresses.length; i++) {
            (uint256 currentPositionBalance, bool isBalancePositive) = _calculatePositionBalance(holdersAddresses[i]);

            if (liquidation.isLiquidationCandidate(currentPositionBalance, isBalancePositive, positions[holdersAddresses[i]].positionUnitsAmount)) {
                addressesToLiquidate[liquidationAddressesAmount] = holdersAddresses[i];
                liquidationAddressesAmount = liquidationAddressesAmount.add(1);
            }
        }

        address[] memory addressesToActuallyLiquidate = new address[](liquidationAddressesAmount);
        for (uint256 i = 0; i < liquidationAddressesAmount; i++) {
            addressesToActuallyLiquidate[i] = addressesToLiquidate[i];
        }

        return addressesToActuallyLiquidate;
    }

    function _deposit(uint256 _tokenAmount, uint256 _minLPTokenAmount, bool _transferTokens) internal returns (uint256 lpTokenAmount) {
        require(_tokenAmount > 0, "Tokens amount must be positive");
        lastDepositTimestamp[msg.sender] = block.timestamp;

        updateSnapshots();

        uint256 depositFee = _tokenAmount.mul(uint256(feesCalculator.depositFeePercent())).div(MAX_FEE_PERCENTAGE);

        uint256 tokenAmountToDeposit = _tokenAmount.sub(depositFee);
        uint256 supply = totalSupply();
        uint256 balance = totalBalance();
    
        if (supply > 0 && balance > 0) {
                lpTokenAmount = tokenAmountToDeposit.mul(supply).div(balance);
        } else {
                lpTokenAmount = tokenAmountToDeposit.mul(initialTokenToLPTokenRate);
        }

        emit Deposit(msg.sender, _tokenAmount, lpTokenAmount, depositFee);

        require(lpTokenAmount >= _minLPTokenAmount, "Too few LP tokens");
        require(lpTokenAmount > 0, "Too few tokens");
        _mint(msg.sender, lpTokenAmount);

        if (_transferTokens) {
            token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
        }

        collectProfit(depositFee);
    }

    function _withdraw(uint256 _tokenAmount, bool _shouldBurnMax, uint256 _maxLPTokenBurnAmount, bool _transferTokens) internal returns (uint256 burntAmount, uint256 withdrawnAmount) {
        require(lastDepositTimestamp[msg.sender].add(lpsLockupPeriod) <= block.timestamp, "Funds are locked");

        updateSnapshots();

        if (_shouldBurnMax) {
            burntAmount = _maxLPTokenBurnAmount;
            _tokenAmount = burntAmount.mul(totalBalance()).div(totalSupply());
        } else {
            require(_tokenAmount > 0, "Tokens amount must be positive");

            // Note: rounding up (ceiling) the to-burn amount to prevent precision loss
            burntAmount = _tokenAmount.mul(totalSupply()).sub(1).div(totalBalance()).add(1);
            require(burntAmount <= _maxLPTokenBurnAmount, "Too much LP tokens to burn");
        }

        require(burntAmount <= balanceOf(msg.sender), "Not enough LP tokens for account");
        
        uint256 withdrawFee = _tokenAmount.mul(uint256(feesCalculator.withdrawFeePercent())).div(MAX_FEE_PERCENTAGE);
        withdrawnAmount = _tokenAmount.sub(withdrawFee);

        require(emergencyWithdrawAllowed || token.balanceOf(address(this)).sub(totalPositionUnitsAmount) >= withdrawnAmount, "Collateral ratio broken");

        emit Withdraw(msg.sender, _tokenAmount, burntAmount, withdrawFee);
        
        _burn(msg.sender, burntAmount);

        if (_transferTokens) {
            token.safeTransfer(msg.sender, withdrawnAmount);
        }

        collectProfit(withdrawFee);
    }

    function _openPosition(uint256 _tokenAmount, uint16 _maxCVI, bool _transferTokens) internal returns (uint256 positionUnitsAmount) {
        require(_tokenAmount > 0, "Tokens amount must be positive");
        require(_maxCVI > 0 && _maxCVI <= MAX_CVI_VALUE, "Bad max CVI value");

        (uint16 cviValue,) = cviOracle.getCVILatestRoundData();
        require(cviValue <= _maxCVI, "CVI too high");

        updateSnapshots();

        uint256 openPositionFee = _tokenAmount.mul(uint256(feesCalculator.openPositionFeePercent())).div(MAX_FEE_PERCENTAGE);
        uint256 positionUnitsAmountWithoutPremium =  _tokenAmount.sub(openPositionFee).mul(MAX_CVI_VALUE).div(cviValue);
        uint256 minPositionUnitsAmount = positionUnitsAmountWithoutPremium.mul(MAX_FEE_PERCENTAGE.sub(feesCalculator.buyingPremiumFeeMaxPercent())).div(MAX_FEE_PERCENTAGE);

        uint256 collateralRatio = 0;
        if (token.balanceOf(address(this)) > 0) {
            collateralRatio = (totalPositionUnitsAmount.add(minPositionUnitsAmount)).mul(PRECISION_DECIMALS).div(token.balanceOf(address(this)).add(_tokenAmount).sub(openPositionFee));
        }
        uint256 buyingPremiumFee = feesCalculator.calculateBuyingPremiumFee(_tokenAmount, collateralRatio);
        
        // Leaving buying premium in shared pool
        uint256 tokenAmountToOpenPosition = _tokenAmount.sub(openPositionFee).sub(buyingPremiumFee);

        positionUnitsAmount = tokenAmountToOpenPosition.mul(MAX_CVI_VALUE).div(cviValue);
        
        totalPositionUnitsAmount = totalPositionUnitsAmount.add(positionUnitsAmount);
        if (positions[msg.sender].positionUnitsAmount > 0) {
            Position storage position = positions[msg.sender];
            position.pendingFees = position.pendingFees.add(feesModel.calculateFundingFees(position.creationTimestamp, 
                block.timestamp, position.positionUnitsAmount));
            position.positionUnitsAmount = position.positionUnitsAmount.add(positionUnitsAmount);
            position.creationTimestamp = block.timestamp;
        } else {
            Position memory newPosition = Position(positionUnitsAmount, block.timestamp, 0, holdersAddresses.length);

            positions[msg.sender] = newPosition;
            holdersAddresses.push(msg.sender);
        }   

        emit OpenPosition(msg.sender, _tokenAmount, openPositionFee.add(buyingPremiumFee), positions[msg.sender].positionUnitsAmount, cviValue);

        if (_transferTokens) {
            token.safeTransferFrom(msg.sender, address(this), _tokenAmount);
        }

        collectProfit(openPositionFee);

        // Note: checking collateral ratio after transfering tokens to cover cases where token transfer induces a fee, for example
        require(totalPositionUnitsAmount <= token.balanceOf(address(this)), "Not enough liquidity");

        if (address(rewards) != address(0)) {
            rewards.reward(msg.sender, positionUnitsAmount);
        }
    }

    function _closePosition(uint256 _positionUnitsAmount, uint16 _minCVI, bool _transferTokens) internal returns (uint256 tokenAmount) {
        require(_positionUnitsAmount > 0, "Position units not positive");
        require(_minCVI > 0 && _minCVI <= MAX_CVI_VALUE, "Bad min CVI value");
        require(positions[msg.sender].positionUnitsAmount >= _positionUnitsAmount, "Not enough opened position units");
        require(block.timestamp.sub(positions[msg.sender].creationTimestamp) >= buyersLockupPeriod, "Position locked");

        (uint16 cviValue,) = cviOracle.getCVILatestRoundData();
        require(cviValue >= _minCVI, "CVI too low");

        updateSnapshots();

        Position storage position = positions[msg.sender];
        uint256 positionBalance = _positionUnitsAmount.mul(cviValue).div(MAX_CVI_VALUE);
        uint256 tokenAmountBeforeFees = positionBalance;
        uint256 fundingFees = feesModel.calculateFundingFees(position.creationTimestamp, block.timestamp, _positionUnitsAmount);
        uint256 realizedPendingFees = position.pendingFees.mul(_positionUnitsAmount).div(position.positionUnitsAmount);

        if (positionBalance <= fundingFees.add(realizedPendingFees)) {
            checkAndLiquidatePosition(msg.sender); // Will always liquidate
            return 0;
        } else {
            positionBalance = positionBalance.sub(fundingFees.add(realizedPendingFees));
        }

        uint256 closePositionFee = positionBalance
            .mul(uint256(feesCalculator.calculateClosePositionFeePercent(position.creationTimestamp)))
            .div(MAX_FEE_PERCENTAGE);

        position.positionUnitsAmount = position.positionUnitsAmount.sub(_positionUnitsAmount);
        totalPositionUnitsAmount = totalPositionUnitsAmount.sub(_positionUnitsAmount);

        if (position.positionUnitsAmount > 0) {
            position.pendingFees = position.pendingFees.sub(realizedPendingFees);
        } else {
            removePosition(msg.sender);
        }

        tokenAmount = positionBalance.sub(closePositionFee);

        emit ClosePosition(msg.sender, tokenAmountBeforeFees, closePositionFee.add(realizedPendingFees).add(fundingFees), positions[msg.sender].positionUnitsAmount, cviValue);

        collectProfit(closePositionFee);
        
        if (_transferTokens) {
            token.safeTransfer(msg.sender, tokenAmount);
        }
    }

    function _liquidatePositions(address[] calldata _positionOwners) internal returns (uint256 finderFeeAmount) {
        updateSnapshots();
        bool liquidationOccured = false;
        for ( uint256 i = 0; i < _positionOwners.length; i++) {
            uint256 positionUnitsAmount = positions[_positionOwners[i]].positionUnitsAmount;
            (bool wasLiquidated, uint256 liquidatedAmount, bool isPositive) = checkAndLiquidatePosition(_positionOwners[i]);

            if (wasLiquidated) {
                liquidationOccured = true;
                finderFeeAmount = finderFeeAmount.add(liquidation.getLiquidationReward(liquidatedAmount, isPositive, positionUnitsAmount));
            }
        }

        require(liquidationOccured, "No reported position was found to be liquidatable");
        token.safeTransfer(msg.sender, finderFeeAmount);
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal override {
        if (lastDepositTimestamp[from].add(lpsLockupPeriod) > block.timestamp && 
            lastDepositTimestamp[from] > lastDepositTimestamp[to]) {
                require(!revertLockedTransfered[to], "Recipient refuses locked tokens");
                lastDepositTimestamp[to] = lastDepositTimestamp[from];
        }
    }

    function updateSnapshots() private {
        uint256 singleUnitFundingFee = feesModel.updateSnapshots();
        totalFundingFeesAmount = totalFundingFeesAmount.add(singleUnitFundingFee.mul(totalPositionUnitsAmount).div(PRECISION_DECIMALS));
    }

    function collectProfit(uint256 amount) private {
        if (address(feesCollector) != address(0)) {
            feesCollector.sendProfit(amount, token);
        }
    }

    function checkAndLiquidatePosition(address _positionAddress) private returns (bool wasLiquidated, uint256 liquidatedAmount, bool isPositive) {
        (uint256 currentPositionBalance, bool isBalancePositive) = _calculatePositionBalance(_positionAddress);
        isPositive = isBalancePositive;
        liquidatedAmount = currentPositionBalance;

        if (liquidation.isLiquidationCandidate(currentPositionBalance, isBalancePositive, positions[_positionAddress].positionUnitsAmount)) {
            liquidatePosition(_positionAddress, currentPositionBalance, isBalancePositive);
            wasLiquidated = true;
        }
    }

    function liquidatePosition(address _positionAddress, uint256 liquidatedAmount, bool isPositive) private {
        Position memory position = positions[_positionAddress];
        totalPositionUnitsAmount = totalPositionUnitsAmount.sub(position.positionUnitsAmount);
        totalFundingFeesAmount = totalFundingFeesAmount.sub(position.pendingFees);
        removePosition(_positionAddress);
        emit LiquidatePosition(_positionAddress, liquidatedAmount, isPositive, position.positionUnitsAmount);
    }

    function removePosition(address _positionAddress) private {
        uint256 positionIndex = positions[_positionAddress].positionAddressesIndex;
        if (holdersAddresses.length > 1) {
            holdersAddresses[positionIndex] = holdersAddresses[holdersAddresses.length.sub(1)];
            positions[holdersAddresses[positionIndex]].positionAddressesIndex = positionIndex;
        }
        holdersAddresses.pop();
        delete positions[_positionAddress];
    }

    function _calculatePositionBalance(address _positionAddress) private view returns (uint256 currentPositionBalance, bool isPositive) {
        Position memory position = positions[_positionAddress];

        (uint16 cviValue,) = cviOracle.getCVILatestRoundData();

        uint256 pendingFeesAmount = position.pendingFees.add(feesModel.calculateFundingFees(position.creationTimestamp, position.positionUnitsAmount))
        .add(feesModel.calculateFundingFeesAddendum(position.positionUnitsAmount));
        
        uint256 positionBalanceWithoutFees = position.positionUnitsAmount.mul(cviValue).div(MAX_CVI_VALUE);

        if (positionBalanceWithoutFees >= pendingFeesAmount) {
            currentPositionBalance = positionBalanceWithoutFees.sub(pendingFeesAmount);
            isPositive = true;
        } else {
            currentPositionBalance = pendingFeesAmount.sub(positionBalanceWithoutFees);
        }
    }
}
