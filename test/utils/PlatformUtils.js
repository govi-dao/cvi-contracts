const chai = require('chai');
const expect = chai.expect;

const {expectRevert, expectEvent, time, BN, balance} = require('@openzeppelin/test-helpers');
const { getContracts, getAccounts } = require('./DeployUtils.js');
const {toBN} = require('./BNUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence, calculatePremiumFee, calculateClosePositionFeePercent, TIME_WINDOW, MID_VOLUME_FEE, MAX_CLOSE_VOLUME_FEE} = require('./FeesUtils.js');
const { print } = require('./DebugUtils');

const PRECISION_DECIMALS = toBN(1, 10);
const MAX_FEE = new BN(10000);
const HEARTBEAT = new BN(55 * 60);
const GAS_PRICE = toBN(1, 10);

const MIN_PREMIUM_COLLATERLA_FEE = 6500;

const MAX_FEE_DELTA_COLLATERAL = new BN(400);

const LIQUIDATION_MIN_REWARD_PERCENTAGE = toBN(5);
const LEVERAGE_TO_THRESHOLD = [new BN(50), new BN(50), new BN(100), new BN(100), new BN(150), new BN(150), new BN(200), new BN(200)];
const LIQUIDATION_MAX_FEE_PERCENTAGE = new BN(1000);
const LEVERAGE_TO_MAX = [new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30)];

const ALL_FEES = 0;
const ONLY_COLLATERAL_PREMIUM = 1;
const NO_FEES = 2;

let admin;

const setAccounts = async () => {
    [admin] = await getAccounts();
};

const getBNFee = (bigNumber, fee) => {
    return bigNumber.mul(fee).div(MAX_FEE);
};

const getFee = (amount, fee) => {
    return getBNFee(toBN(amount), fee);
};

const getAccountBalance = async account => {
    return getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);
};

const getFeesBalance = async feesCollector => {
    return (getContracts().isETH ? await balance.current(feesCollector.address, 'wei') :
        await feesCollector.getProfit());
};

const createState = accountsUsed => {
    const lpBalances = {};

    for (let account of accountsUsed) {
        lpBalances[account] = new BN(0);
    }

    return {
        lpTokensSupply: new BN(0),
        sharedPool: new BN(0),
        totalMarginDebt: new BN(0),
        totalFeesSent: new BN(0),
        totalPositionUnits: new BN(0),
        totalFundingFees: new BN(0),
        positions: {},
        snapshots: {},
        latestRound: undefined,
        latestSnapshotTimestamp: undefined,
        turbulence: new BN(0),
        adjustedTimestamp: new BN(0),
        closeAdjustedTimestamp: new BN(0),
        lpBalances
    };
};

const subtractTotalPositionUnits = (state, positionUnits, fundingFees) => {
    state.totalPositionUnits = state.totalPositionUnits.sub(positionUnits);
    if (state.totalPositionUnits.eq(new BN(0))) {
        state.totalFundingFees = new BN(0);
    } else {
        state.totalFundingFees = state.totalFundingFees.sub(fundingFees);    
    }
}

const calculateBalance = async (state, totalFundingFees) => {
    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    return state.sharedPool.sub(state.totalPositionUnits.mul(cviValue).div(getContracts().maxCVIValue)).add(totalFundingFees === undefined ? state.totalFundingFees : totalFundingFees);
};

const validateLPState = async state => {
    const feesBalance = await getFeesBalance(getContracts().fakeFeesCollector);
    expect(feesBalance).to.be.bignumber.equal(state.totalFeesSent);
    expect(await getContracts().platform.totalSupply()).to.be.bignumber.equal(state.lpTokensSupply);

    const contractBalance = await getAccountBalance(getContracts().platform.address);

    expect(contractBalance).to.be.bignumber.equal(state.sharedPool.sub(state.totalMarginDebt));

    const totalLeveragedTokens = await getContracts().platform.totalLeveragedTokensAmount();
    expect(totalLeveragedTokens).to.be.bignumber.equal(state.sharedPool);

    expect(await getContracts().platform.totalPositionUnitsAmount()).to.be.bignumber.equal(state.totalPositionUnits);
    expect(await getContracts().platform.totalFundingFeesAmount()).to.be.bignumber.equal(state.totalFundingFees);

    for (let account of Object.keys(state.lpBalances)) {
        expect(await getContracts().platform.balanceOf(account)).to.be.bignumber.equal(state.lpBalances[account]);
    }

    expect(await getContracts().feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(state.turbulence);

    expect(await getContracts().feesCalculator.adjustedVolumeTimestamp()).to.be.bignumber.equal(state.adjustedTimestamp);
    expect(await getContracts().feesCalculator.closeAdjustedVolumeTimestamp()).to.be.bignumber.equal(state.closeAdjustedTimestamp);

    const totalBalance = await calculateBalance(state);
    expect(await getContracts().platform.totalBalance(false)).to.be.bignumber.equal(totalBalance);
};

const updateSnapshots = async (state, saveSnapshot = true) => {
    const latestTimestamp = await time.latest();
    const timestamp = latestTimestamp.toNumber();

    let turbulence = state.turbulence;
    let totalFundingFees = state.totalFundingFees;

    if (state.snapshots[timestamp] !== undefined) {
        return {latestTimestamp, snapshot: state.snapshots[timestamp], latestCVIRound: state.latestRound, totalFundingFees, turbulence};
    }

    const latestCVIRound = (await getContracts().fakeOracle.getCVILatestRoundData()).cviRoundId.toNumber();
    let snapshot;

    if (state.latestSnapshotTimestamp === undefined) {
        snapshot = PRECISION_DECIMALS;
    } else {
        let nextSnapshot = state.snapshots[state.latestSnapshotTimestamp];
        const lastTime = state.latestSnapshotTimestamp;
        const lastCVIRound = await getContracts().fakeOracle.getCVIRoundData(state.latestRound);
        const lastCVI = lastCVIRound.cviValue.toNumber();
        const lastTimestamp = lastCVIRound.cviTimestamp.toNumber();
        let fundingFeesPerUnit;

        if (latestCVIRound === state.latestRound) {
            fundingFeesPerUnit = calculateSingleUnitFee(lastCVI, timestamp - lastTime);
            nextSnapshot = nextSnapshot.add(fundingFeesPerUnit);
        } else {
            const currCVI = await getContracts().fakeOracle.getCVIRoundData(latestCVIRound);
            const currTimestamp = currCVI.cviTimestamp.toNumber();
            const currCVIValue = currCVI.cviValue.toNumber();

            fundingFeesPerUnit = calculateSingleUnitFee(lastCVI, currTimestamp - lastTime).add(
                calculateSingleUnitFee(currCVIValue, timestamp - currTimestamp));
            nextSnapshot = nextSnapshot.add(fundingFeesPerUnit);

            turbulence = calculateNextAverageTurbulence(state.turbulence, new BN(currTimestamp - lastTimestamp), HEARTBEAT, latestCVIRound - state.latestRound, new BN(lastCVI), new BN(currCVIValue));
            if (saveSnapshot) {
                state.turbulence = turbulence;
            }
        }

        totalFundingFees = totalFundingFees.add(fundingFeesPerUnit.mul(state.totalPositionUnits).div(PRECISION_DECIMALS));
        if (saveSnapshot) {
            state.totalFundingFees = totalFundingFees;
        }

        snapshot = nextSnapshot;
    }

    if (saveSnapshot) {
        state.latestSnapshotTimestamp = timestamp;
        state.latestRound = latestCVIRound;
        state.snapshots[timestamp] = snapshot;
    }

    return {latestTimestamp, snapshot, latestCVIRound, totalFundingFees, turbulence};
};

const calculateFundingFees = (state, currTime, account, positionUnitsAmount) => {
    const position = state.positions[account];
    return (state.snapshots[currTime.toNumber()].sub(state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
};

const calculateFundingFeesWithSnapshot = (state, currSnapshot, account, positionUnitsAmount) => {
    const position = state.positions[account];
    return (currSnapshot.sub(state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
};

const calculateFundingFeesWithTwoSnapshots = (prevSnapshot, currSnapshot, positionUnitsAmount) => {
    return (currSnapshot.sub(prevSnapshot).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
}

const calculateMarginDebt = (state, account) => {
    return state.positions[account].positionUnitsAmount.mul(state.positions[account].openCVIValue).mul(state.positions[account].leverage.sub(new BN(1))) .div(getContracts().maxCVIValue).div(state.positions[account].leverage);
};

const calculateEntirePositionBalance = async (state, account, snapshot) => {
    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const position = state.positions[account];

    let updatedSnapshot = snapshot;
    if (updatedSnapshot === undefined) {
        updatedSnapshot = (await updateSnapshots(state, false)).snapshot;
    }

    const fundingFees = calculateFundingFeesWithSnapshot(state, updatedSnapshot, account, position.positionUnitsAmount);
    const marginDebt = calculateMarginDebt(state, account);

    const positionBalancePositive = state.positions[account].positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue);
    const positionBalanceNegative = fundingFees.add(marginDebt);

    if (positionBalanceNegative.gt(positionBalancePositive)) {
        return {positionBalance: positionBalanceNegative.sub(positionBalancePositive), isPositive: false, fundingFees, marginDebt};
    }

    return {positionBalance: positionBalancePositive.sub(positionBalanceNegative), isPositive: true, fundingFees, marginDebt};
};

const isLiquidable = (positionBalance, isPositive, position) => {
    const leverage = position.leverage;
    const openCVIValue = position.openCVIValue;

    const liquidationBalance = position.positionUnitsAmount.mul(LEVERAGE_TO_THRESHOLD[leverage.toNumber() - 1]).
            mul(openCVIValue).div(getContracts().maxCVIValue).div(leverage).div(LIQUIDATION_MAX_FEE_PERCENTAGE);

    return {liquidable: (!isPositive || positionBalance.lt(liquidationBalance)), liquidationBalance};
};

const calculateLiquidationCVI = async (state, account) => {
    const {positionBalance, isPositive} = await calculateEntirePositionBalance(state, account);

    const position = state.positions[account];

    const {liquidable, liquidationBalance} = isLiquidable(positionBalance, isPositive, position);
    if (liquidable) {
        return null;
    } else {
        const leftToLose = positionBalance.sub(liquidationBalance);

        // LeftToLose <= (openCVI - currCVI) * PU / maxCVI => currCVI <= openCVI - LeftToLose * maxCVI / PU
        let loseCVI = position.openCVIValue.sub(leftToLose.mul(getContracts().maxCVIValue).div(position.positionUnitsAmount));

        while(leftToLose.gte(position.openCVIValue.sub(loseCVI).mul(position.positionUnitsAmount).div(getContracts().maxCVIValue))) {
            loseCVI = loseCVI.sub(new BN(10));
        }
        return loseCVI;
    }
};

const calculateLiquidationDays = async (state, account, cviValue, negativeOnly = false) => {
    const {positionBalance, isPositive} = await calculateEntirePositionBalance(state, account);
    const position = state.positions[account];

    const {liquidable, liquidationBalance} = isLiquidable(positionBalance, isPositive, position);
    if (liquidable) {
        return null;
    } else {
        const leftToLose = negativeOnly ? positionBalance : positionBalance.sub(liquidationBalance);

        const singlePositionUnitDaiilyFee = calculateSingleUnitFee(cviValue, 3600 * 24);
        const daiilyFundingFee = position.positionUnitsAmount.mul(singlePositionUnitDaiilyFee).div(toBN(1, 10));

        const daysBeforeLiquidation = leftToLose.div(daiilyFundingFee).add(new BN(1));

        return daysBeforeLiquidation;
    }
};

const getLiquidationReward = (positionBalance, isPositive, position) => {
    const positionUnitsAmount = position.positionUnitsAmount;
    const openCVIValue = position.openCVIValue;
    const leverage = position.leverage;

    const balance = positionUnitsAmount.mul(new BN(openCVIValue)).div(getContracts().maxCVIValue).sub(
        positionUnitsAmount.mul(new BN(openCVIValue)).div(getContracts().maxCVIValue).mul(leverage.sub(new BN(1))).div(position.leverage));

    if (!isPositive || toBN(positionBalance).lt(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE))) {
        return toBN(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE));
    }

    if (isPositive && toBN(positionBalance).gte(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE))
        && toBN(positionBalance).lte( toBN(balance).mul(LEVERAGE_TO_MAX[leverage.toNumber() - 1]).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) ) {
        return toBN(positionBalance);
    }

    return balance.mul(LEVERAGE_TO_MAX[leverage.toNumber() - 1]).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
};

const calculateLPTokens = async (state, tokens, totalFundingFees) => {
    const balance = await calculateBalance(state, totalFundingFees);

    if (balance.eq(new BN(0)) || state.lpTokensSupply.eq(new BN(0))) {
        return tokens.mul(getContracts().initialRate);
    }

    return tokens.mul(state.lpTokensSupply).div(balance);
};

const calculateDepositAmounts = async (state, amount, totalFundingFees) => {
    const depositFees = await getContracts().feesCalculator.depositFeePercent();

    const depositTokens = new BN(amount);
    const depositTokenFees = getFee(amount, depositFees);
    const depositTokenMinusFees = depositTokens.sub(depositTokenFees);
    const lpTokens = await calculateLPTokens(state, depositTokenMinusFees, totalFundingFees);
    return { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens };
};

const calculateWithdrawAmounts = async (state, amount, totalFundingFees) => {
    const withdrawFees = await getContracts().feesCalculator.withdrawFeePercent();

    const withdrawTokens = new BN(amount);
    const withdrawTokenFees = getFee(amount, withdrawFees);
    const withdrawTokenMinusFees = withdrawTokens.sub(withdrawTokenFees);

    const burnedLPTokens = withdrawTokens.mul(state.lpTokensSupply).sub(new BN(1)).div(await calculateBalance(state, totalFundingFees)).add(new BN(1));

    return { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens };
};

const calculateTokensByBurntLPTokensAmount = async (state, burnAmount, totalFundingFees) => {
    return burnAmount.mul(await calculateBalance(state, totalFundingFees)).div(state.lpTokensSupply);
};

const calculateNextAdjustedTimestamp = (adjustedTimestamp, timestamp, deltaCollateral) => {
    let nextAdjustedTimestamp = adjustedTimestamp;
    if (nextAdjustedTimestamp.lt(timestamp.sub(TIME_WINDOW))) {
        nextAdjustedTimestamp = timestamp.sub(TIME_WINDOW);
    }

    nextAdjustedTimestamp = nextAdjustedTimestamp.add(deltaCollateral.mul(TIME_WINDOW).div(MAX_FEE_DELTA_COLLATERAL.mul(PRECISION_DECIMALS).div(MAX_FEE)));

    if (nextAdjustedTimestamp.gt(timestamp)) {
        nextAdjustedTimestamp = timestamp;
    }

    return nextAdjustedTimestamp;
}

const calculateOpenPositionAmounts = async (state, timestamp, amount, noPremiumFee, leverage = 1, midVolumeFee = MID_VOLUME_FEE, saveState = true) => {
    const openPositionFeePercent = await getContracts().feesCalculator.openPositionFeePercent();
    const openPositionLPFeePercent = await getContracts().feesCalculator.openPositionLPFeePercent();
    const turbulencePercent = state.turbulence;

    const openPositionTokens = new BN(amount);
    const openPositionTokensFees = getFee(openPositionTokens.mul(new BN(leverage)), openPositionFeePercent);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const expectedPositionUnits = openPositionTokens.sub(openPositionTokensFees).mul(new BN(leverage)).mul(getContracts().maxCVIValue).div(cviValue);
    const expectedCollateral = state.totalPositionUnits.add(expectedPositionUnits).mul(PRECISION_DECIMALS).div(state.sharedPool.add((openPositionTokens.sub(openPositionTokensFees).mul(new BN(leverage)))));
    const lastCollateral = state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool);

    let adjustedTimestamp = undefined;
    if (noPremiumFee !== NO_FEES && noPremiumFee !== ONLY_COLLATERAL_PREMIUM) {
        adjustedTimestamp = calculateNextAdjustedTimestamp(state.adjustedTimestamp, timestamp, expectedCollateral.sub(lastCollateral));
        if (saveState) {
            state.adjustedTimestamp = adjustedTimestamp;
        }
    }

    const result = calculatePremiumFee(adjustedTimestamp, timestamp, expectedPositionUnits, expectedCollateral, lastCollateral, turbulencePercent, undefined, MIN_PREMIUM_COLLATERLA_FEE, undefined, midVolumeFee);
    const premiumPercent = result.feePercentage;

    const openPositionPremiumFees = noPremiumFee === NO_FEES ? getFee(openPositionTokens.mul(new BN(leverage)), openPositionLPFeePercent) : getFee(openPositionTokens.mul(new BN(leverage)), premiumPercent);
    const openPositionTokensMinusFees = openPositionTokens.sub(openPositionTokensFees).sub(openPositionPremiumFees);
    const openPositionLeveragedTokens = openPositionTokensMinusFees.mul(new BN(leverage));

    const positionUnits = openPositionLeveragedTokens.mul(getContracts().maxCVIValue).div(cviValue);

    return { openPositionTokens, openPositionTokensFees, openPositionPremiumFees, 
        premiumPercentage: noPremiumFee == NO_FEES ? toBN(0) : result.collateralFee, 
        openPositionTokensMinusFees, openPositionLeveragedTokens, positionUnits, volumeFeePercentage: result.volumeFeePercentage };
};

const calculatePositionBalance = async positionUnits => {
    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    return positionUnits.mul(cviValue).div(getContracts().maxCVIValue);
};

const deposit = (tokens, minLPTokens, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.depositETH(minLPTokens, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.deposit(tokens, minLPTokens, {from: account});
    }
};

const callDeposit = (tokens, minLPTokens, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.depositETH.call(minLPTokens, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.deposit.call(tokens, minLPTokens, {from: account});
    }
};

const withdraw = (tokens, maxLPTokensBurn, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.withdraw(tokens, maxLPTokensBurn, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.withdraw(tokens, maxLPTokensBurn, {from: account});
    }
};

const withdrawLPTokens = (lpTokens, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.withdrawLPTokens(lpTokens, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.withdrawLPTokens(lpTokens, {from: account});
    }
};

const callWithdraw = (tokens, maxLPTokensBurn, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.withdraw.call(tokens, maxLPTokensBurn, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.withdraw.call(tokens, maxLPTokensBurn, {from: account});
    }
};

const callWithdrawLPTokens = (lpTokens, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.withdrawLPTokens.call(lpTokens, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.withdrawLPTokens.call(lpTokens, {from: account});
    }
};

const openPosition = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
    if (getContracts().isETH) {
        return getContracts().platform.openPositionETH(cviValue, maxBuyingPremiumPercent, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.openPosition(tokens, cviValue, maxBuyingPremiumPercent, leverage, {from: account});
    }
};

const callOpenPosition = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
    if (getContracts().isETH) {
        return getContracts().platform.openPositionETH.call(cviValue, maxBuyingPremiumPercent, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.openPosition.call(tokens, cviValue, maxBuyingPremiumPercent, leverage, {from: account});
    }
};

const openPositionWithoutVolumeFee = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
    if (getContracts().isETH) {
        return getContracts().platform.openPositionWithoutVolumeFeeETH(cviValue, maxBuyingPremiumPercent, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.openPositionWithoutVolumeFee(tokens, cviValue, maxBuyingPremiumPercent, leverage, {from: account});
    }
};

const callOpenPositionWithoutVolumeFee = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
    if (getContracts().isETH) {
        return getContracts().platform.openPositionWithoutVolumeFeeETH.call(cviValue, maxBuyingPremiumPercent, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.openPositionWithoutVolumeFee.call(tokens, cviValue, maxBuyingPremiumPercent, leverage, {from: account});
    }
};

const openPositionWithoutPremiumFee = (tokens, cviValue, account, leverage = 1) => {
    if (getContracts().isETH) {
        return getContracts().platform.openPositionWithoutPremiumFeeETH(cviValue, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.openPositionWithoutPremiumFee(tokens, cviValue, leverage, {from: account});
    }
};

const callOpenPositionWithoutPremiumFee = (tokens, cviValue, account, leverage = 1) => {
    if (getContracts().isETH) {
        return getContracts().platform.openPositionWithoutPremiumFeeETH.call(cviValue, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.openPositionWithoutPremiumFee.call(tokens, cviValue, leverage, {from: account});
    }
};

const closePosition = (positionUnits, cviValue, account, maxBuyingPremiumPercent = 1000) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePosition(positionUnits, cviValue, maxBuyingPremiumPercent, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePosition(positionUnits, cviValue, maxBuyingPremiumPercent, {from: account});
    }
};

const callClosePosition = (positionUnits, cviValue, account, maxBuyingPremiumPercent = 1000) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePosition.call(positionUnits, cviValue, maxBuyingPremiumPercent, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePosition.call(positionUnits, cviValue, maxBuyingPremiumPercent, {from: account});
    }
};

const closePositionWithoutVolumeFee = (positionUnits, cviValue, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePositionWithoutVolumeFee(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePositionWithoutVolumeFee(positionUnits, cviValue, {from: account});
    }
};

const callClosePositionWithoutVolumeFee = (positionUnits, cviValue, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePositionWithoutVolumeFee.call(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePositionWithoutVolumeFee.call(positionUnits, cviValue, {from: account});
    }
};

const depositAndValidate = async (state, depositTokensNumber, account, totalFundingFees) => {
    const { depositTokens, depositTokenFees, depositTokenMinusFees } = await calculateDepositAmounts(state, depositTokensNumber);

    if (!getContracts().isETH) {
        await getContracts().token.transfer(account, depositTokens, {from: admin});
        await getContracts().token.approve(getContracts().platform.address, depositTokens, {from: account});
    }

    const beforeBalance = await getAccountBalance(account);

    const result = await callDeposit(depositTokens, new BN(0), account);
    const {totalFundingFees: totalFundingFeesCall} = await updateSnapshots(state, false);

    const tx = await deposit(depositTokens, new BN(0), account);
    const {latestTimestamp: depositTimestamp} = await updateSnapshots(state);

    const { lpTokens } = await calculateDepositAmounts(state, depositTokensNumber);
    const { lpTokens: lpTokensCall } = await calculateDepositAmounts(state, depositTokensNumber, totalFundingFeesCall);

    expect(result).to.be.bignumber.equal(lpTokensCall);

    print('DEPOSIT: ' + tx.receipt.gasUsed.toString());

    await expectEvent(tx, 'Deposit', {account, tokenAmount: depositTokens, lpTokensAmount: lpTokens, feeAmount: depositTokenFees});

    const afterBalance = await getAccountBalance(account);

    if (getContracts().isETH) {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens);
    }

    state.lpTokensSupply = state.lpTokensSupply.add(lpTokens);
    state.sharedPool = state.sharedPool.add(depositTokenMinusFees);
    state.totalFeesSent = state.totalFeesSent.add(depositTokenFees);

    state.lpBalances[account] = state.lpBalances[account].add(lpTokens);

    await validateLPState(state);

    return {depositTimestamp, gasUsed: (new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)};
};

const withdrawAndValidate = async (state, withdrawTokensNumber, account, lpTokens) => {
    let { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens } = await calculateWithdrawAmounts(state, withdrawTokensNumber);

    if (lpTokens !== undefined) {
        burnedLPTokens = lpTokens;
    }

    const beforeBalance = await getAccountBalance(account);

    const result = lpTokens === undefined ? await callWithdraw(withdrawTokens, burnedLPTokens, account) :
        await callWithdrawLPTokens(burnedLPTokens, account);
    const {latestTimestamp: timestampCall, totalFundingFees: totalFundingFeesCall} = await updateSnapshots(state, false);

    const tx = lpTokens === undefined ? await withdraw(withdrawTokens, burnedLPTokens, account) :
        await withdrawLPTokens(burnedLPTokens, account);
    const {latestTimestamp: timestamp} = await updateSnapshots(state);

    let burnedLPTokensCall, withdrawTokensMinusFeesCall;

    if (lpTokens === undefined) {
        const results = await calculateWithdrawAmounts(state, withdrawTokens);
        const resultsCall = await calculateWithdrawAmounts(state, withdrawTokens, totalFundingFeesCall);

        burnedLPTokens = results.burnedLPTokens;
        withdrawTokenMinusFees = results.withdrawTokenMinusFees;
        withdrawTokenFees = results.withdrawTokenFees;

        burnedLPTokensCall = resultsCall.burnedLPTokens;
        withdrawTokensMinusFeesCall = resultsCall.withdrawTokenMinusFees;
    } else {
        burnedLPTokens = lpTokens;
        burnedLPTokensCall = lpTokens;

        withdrawTokens = await calculateTokensByBurntLPTokensAmount(state, burnedLPTokens);
        const withdrawTokensCall = await calculateTokensByBurntLPTokensAmount(state, burnedLPTokens, totalFundingFeesCall);

        const results = await calculateWithdrawAmounts(state, withdrawTokens);
        const resultsCall = await calculateWithdrawAmounts(state, withdrawTokensCall, totalFundingFeesCall);

        withdrawTokenFees = results.withdrawTokenFees;
        withdrawTokenMinusFees = results.withdrawTokenMinusFees;

        withdrawTokensMinusFeesCall = resultsCall.withdrawTokenMinusFees;
    }

    expect(result[0]).to.be.bignumber.equal(burnedLPTokensCall);
    expect(result[1]).to.be.bignumber.equal(withdrawTokensMinusFeesCall);

    await expectEvent(tx, 'Withdraw', {account, tokenAmount: withdrawTokens, lpTokensAmount: burnedLPTokens, feeAmount: withdrawTokenFees});

    print('WITHDRAW: ' + tx.receipt.gasUsed.toString());

    const afterBalance = await getAccountBalance(account);

    state.totalFeesSent = state.totalFeesSent.add(withdrawTokenFees);
    state.lpTokensSupply = state.lpTokensSupply.sub(burnedLPTokens);
    state.sharedPool = state.sharedPool.sub(withdrawTokens);

    state.lpBalances[account] = state.lpBalances[account].sub(burnedLPTokens);

    await validateLPState(state);

    if (getContracts().isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(withdrawTokenMinusFees.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(withdrawTokenMinusFees);
    }

    return {timestamp, gasUsed: (new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)};
};

const validatePosition = (actualPosition, expectedPosition) => {
    expect(actualPosition.positionUnitsAmount).to.be.bignumber.equal(expectedPosition.positionUnitsAmount);
    expect(actualPosition.leverage).to.be.bignumber.equal(expectedPosition.leverage);
    expect(actualPosition.openCVIValue).to.be.bignumber.equal(expectedPosition.openCVIValue);
    expect(actualPosition.creationTimestamp).to.be.bignumber.equal(expectedPosition.creationTimestamp);
    expect(actualPosition.originalCreationTimestamp).to.be.bignumber.equal(expectedPosition.originalCreationTimestamp);
};

const openPositionAndValidate = async (state, amount, account, validateRewards = true, noPremiumFee = ALL_FEES, leverage = 1, midVolumeFee = MID_VOLUME_FEE, shouldLiquidate = false) => {
    const isMerge = state.positions[account] !== undefined;
    const openPositionTokens = new BN(amount);

    if (!getContracts().isETH) {
        await getContracts().token.transfer(account, openPositionTokens, {from: admin});
        await getContracts().token.approve(getContracts().platform.address, openPositionTokens, {from: account});
    }

    const beforeBalance = await getAccountBalance(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;

    const result = noPremiumFee === ONLY_COLLATERAL_PREMIUM ? await callOpenPositionWithoutVolumeFee(openPositionTokens, cviValue, account, 1000, leverage) :
        (noPremiumFee === NO_FEES ? await callOpenPositionWithoutPremiumFee(openPositionTokens, cviValue, account, leverage) : await callOpenPosition(openPositionTokens, cviValue, account, 1000, leverage));
    const {latestTimestamp: timestampCall, snapshot: snapshotCall} = await updateSnapshots(state, false);
    const tx = noPremiumFee === ONLY_COLLATERAL_PREMIUM ? await openPositionWithoutVolumeFee(openPositionTokens, cviValue, account, 1000, leverage) : 
        (noPremiumFee === NO_FEES ? await openPositionWithoutPremiumFee(openPositionTokens, cviValue, account, leverage) : await openPosition(openPositionTokens, cviValue, account, 1000, leverage));
    const {latestTimestamp: timestamp} = await updateSnapshots(state);

    print('OPEN: ' + tx.receipt.gasUsed.toString());

    const { positionUnits: positionUnitsCall } = 
        await calculateOpenPositionAmounts(state, timestampCall, amount, noPremiumFee, leverage, midVolumeFee, false);

    const { openPositionTokensFees, openPositionPremiumFees, premiumPercentage, openPositionTokensMinusFees, openPositionLeveragedTokens, positionUnits, volumeFeePercentage } = 
        await calculateOpenPositionAmounts(state, timestamp, amount, noPremiumFee, leverage, midVolumeFee);

    let finalPositionUnits = positionUnits;
    let finalPositionUnitsCall = positionUnitsCall;
    let positionUnitsAdded = finalPositionUnits;
    if (isMerge) {
        const oldPositionUnits = state.positions[account].positionUnitsAmount;
        const fundingFees = calculateFundingFees(state, timestamp, account, state.positions[account].positionUnitsAmount);
        const fundingFeesCall = calculateFundingFeesWithSnapshot(state, snapshotCall, account, state.positions[account].positionUnitsAmount);
        const marginDebt = state.positions[account].positionUnitsAmount.mul(state.positions[account].openCVIValue).mul(state.positions[account].leverage.sub(new BN(1))) .div(getContracts().maxCVIValue).div(state.positions[account].leverage);

        const positionBalance = state.positions[account].positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees).sub(marginDebt);
        const positionBalanceCall = state.positions[account].positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFeesCall).sub(marginDebt);

        if (!shouldLiquidate) {
            finalPositionUnits = positionBalance.add(openPositionTokensMinusFees).mul(new BN(leverage)).mul(getContracts().maxCVIValue).div(cviValue);
            finalPositionUnitsCall = positionBalanceCall.add(openPositionTokensMinusFees).mul(new BN(leverage)).mul(getContracts().maxCVIValue).div(cviValue);

            positionUnitsAdded = new BN(0);
            if (oldPositionUnits.lt(finalPositionUnits)) {
                positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits);
            }
        } else {
            await expectEvent(tx, 'LiquidatePosition', {positionAddress: account, currentPositionBalance: positionBalance.mul(toBN(-1)), isBalancePositive: false, positionUnitsAmount: state.positions[account].positionUnitsAmount});
        }

        subtractTotalPositionUnits(state, oldPositionUnits, fundingFees);

        if (shouldLiquidate) {
            state.sharedPool.sub(marginDebt);
            state.totalMarginDebt.sub(marginDebt);
        } else {
            state.sharedPool = state.sharedPool.sub(positionBalance).sub(marginDebt).add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(leverage))).add(openPositionPremiumFees);
            state.totalMarginDebt = state.totalMarginDebt.sub(marginDebt).add(positionBalance.add(openPositionTokensMinusFees).mul((new BN(leverage)).sub(new BN(1))));
        }
    }

    await expectEvent(tx, 'OpenPosition', {account, tokenAmount: openPositionTokens, leverage: toBN(leverage), feeAmount: openPositionTokensFees.add(openPositionPremiumFees), positionUnitsAmount: finalPositionUnits, cviValue});

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, openCVIValue: cviValue, leverage: new BN(leverage), originalCreationTimestamp: isMerge ? state.positions[account].originalCreationTimestamp : timestamp };
    const actualPosition = await getContracts().platform.positions(account);
    validatePosition(actualPosition, expectedPosition);

    expect(result[0]).to.be.bignumber.equal(finalPositionUnitsCall);
    expect(result[1]).to.be.bignumber.equal(openPositionLeveragedTokens);

    state.totalPositionUnits = state.totalPositionUnits.add(finalPositionUnits);
    state.positions[account] = expectedPosition;

    state.totalFeesSent = state.totalFeesSent.add(openPositionTokensFees);

    if (!isMerge || shouldLiquidate) {
        state.sharedPool = state.sharedPool.add(openPositionLeveragedTokens).add(openPositionPremiumFees);
        state.totalMarginDebt = state.totalMarginDebt.add(openPositionLeveragedTokens.sub(openPositionTokensMinusFees));
    }

    await validateLPState(state);

    const afterBalance = await getAccountBalance(account);

    if (getContracts().isETH) {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens);
    }

    return {positionUnits: finalPositionUnits, timestamp, positionUnitsAdded, gasUsed: (new BN(tx.receipt.gasUsed)).mul(GAS_PRICE), volumeFeePercentage, premiumPercentage};
};

const validateEmptyPosition = position => {
    expect(position.positionUnitsAmount).to.be.bignumber.equal(new BN(0));
    expect(position.creationTimestamp).to.be.bignumber.equal(new BN(0));
};

const closePositionAndValidate = async (state, positionUnits, account, shouldLiquidate = false, isNoLockPositionAddress = false, noVolumeFee = false, midVolumeFee = MID_VOLUME_FEE, maxVolumeFee = MAX_CLOSE_VOLUME_FEE) => {
    const currPosition = state.positions[account];
    const actualPositionUnits = shouldLiquidate ? currPosition.positionUnitsAmount : positionUnits;
    const positionBalance = await calculatePositionBalance(actualPositionUnits);

    const marginDebt = currPosition.leverage.sub(new BN(1)).mul(actualPositionUnits).mul(currPosition.openCVIValue).div(getContracts().maxCVIValue).div(currPosition.leverage);

    const beforeBalance = await getAccountBalance(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;

    const result = noVolumeFee ? await callClosePositionWithoutVolumeFee(positionUnits, cviValue, account) : await callClosePosition(positionUnits, cviValue, account);

    const {latestTimestamp: timestampCall, snapshot: snapshotCall} = await updateSnapshots(state, false);

    const tx = noVolumeFee ? await closePositionWithoutVolumeFee(positionUnits, cviValue, account) : await closePosition(positionUnits, cviValue, account);
    const {latestTimestamp: timestamp} = await updateSnapshots(state);

    print('CLOSE: ' + tx.receipt.gasUsed.toString());

    const fundingFees = calculateFundingFees(state, timestamp, account, actualPositionUnits);
    const fundingFeesCall = calculateFundingFeesWithSnapshot(state, snapshotCall, account, actualPositionUnits);

    const positionBalanceAfterFundingFees = positionBalance.sub(fundingFees);
    const positionBalanceAfterFundingFeesCall = positionBalance.sub(fundingFeesCall);

    const closeFeesPercent = await getContracts().feesCalculator.closePositionFeePercent();
    const closeFees = calculateClosePositionFeePercent(timestamp, currPosition.creationTimestamp, isNoLockPositionAddress, closeFeesPercent);
    const closeFeesCall = await getContracts().feesCalculator.calculateClosePositionFeePercent(currPosition.creationTimestamp, isNoLockPositionAddress);
    expect(closeFeesCall).to.be.bignumber.equal(closeFees);

    const closePositionTokensFees = getFee(positionBalanceAfterFundingFees.sub(marginDebt), closeFees);
    const closePositionTokensFeesCall = getFee(positionBalanceAfterFundingFeesCall.sub(marginDebt), closeFees);

    const afterBalance = await getAccountBalance(account);

    const originalPositionUnits = currPosition.positionUnitsAmount;
    currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(actualPositionUnits);

    const finalPositionUnits = currPosition.positionUnitsAmount;
    if (currPosition.positionUnitsAmount.eq(new BN(0))) {
        const actualPosition = await getContracts().platform.positions(account);
        validateEmptyPosition(actualPosition);
        delete state.positions[account];
    } else {
        const actualPosition = await getContracts().platform.positions(account);
        validatePosition(actualPosition, currPosition);
    }

    const lastCollateral = state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool);
    subtractTotalPositionUnits(state, actualPositionUnits, fundingFees);
    const expectedCollateral = state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool.sub(positionBalance).add(fundingFees));

    let closeAdjustedTimestamp = undefined;
    if (!noVolumeFee && !shouldLiquidate) {
        closeAdjustedTimestampCall = calculateNextAdjustedTimestamp(state.closeAdjustedTimestamp, timestampCall, lastCollateral.sub(expectedCollateral));
        closeAdjustedTimestamp = calculateNextAdjustedTimestamp(state.closeAdjustedTimestamp, timestamp, lastCollateral.sub(expectedCollateral));
        state.closeAdjustedTimestamp = closeAdjustedTimestamp;
    }

    const premiumFeeResult = calculatePremiumFee(closeAdjustedTimestamp, timestamp, positionBalanceAfterFundingFees.sub(marginDebt), expectedCollateral, lastCollateral, toBN(0), toBN(0), undefined, undefined, midVolumeFee, maxVolumeFee, false);
    const premiumPercent = premiumFeeResult.feePercentage;
    const premiumFee = premiumFeeResult.fee;

    const premiumFeeResultCall = calculatePremiumFee(closeAdjustedTimestamp, timestampCall, positionBalanceAfterFundingFeesCall.sub(marginDebt), expectedCollateral, lastCollateral, toBN(0), toBN(0), undefined, undefined, midVolumeFee, maxVolumeFee, false);
    const premiumFeeCall = premiumFeeResultCall.fee;

    const totalFees = closePositionTokensFees.add(fundingFees).add(premiumFee);
    const totalFeesCall = closePositionTokensFeesCall.add(fundingFeesCall).add(premiumFeeCall);

    if (shouldLiquidate) {
        await expectEvent(tx, 'LiquidatePosition', {positionAddress: account, currentPositionBalance: positionBalanceAfterFundingFees.sub(marginDebt).mul(toBN(-1)), isBalancePositive: false, positionUnitsAmount: originalPositionUnits});
    } else {
        await expectEvent(tx, 'ClosePosition', {account, tokenAmount: positionBalance.sub(marginDebt), feeAmount: totalFees, positionUnitsAmount: finalPositionUnits, cviValue});
    }

    if (!shouldLiquidate) {
        state.totalFeesSent = state.totalFeesSent.add(closePositionTokensFees);
        state.sharedPool = state.sharedPool.sub(positionBalance).add(fundingFees).add(premiumFee);
    } else {
        state.sharedPool = state.sharedPool.sub(marginDebt);
    }

    state.totalMarginDebt = state.totalMarginDebt.sub(marginDebt);

    await validateLPState(state);

    if (getContracts().isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal((shouldLiquidate ? toBN(0) : positionBalance.sub(totalFees).sub(marginDebt)).sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(shouldLiquidate ? toBN(0) : positionBalance.sub(totalFees).sub(marginDebt));
    }

    expect(result).to.be.bignumber.equal(shouldLiquidate ? toBN(0) : positionBalance.sub(totalFeesCall).sub(marginDebt));

    return {timestamp, gasUsed: toBN(tx.receipt.gasUsed).mul(GAS_PRICE), volumeFeePercentage: premiumFeeResult.volumeFeePercentage, volumeFee: premiumFee};
};

const liquidateAndValidate = async (state, accounts, liquidator, shouldLiquidate) => {
    let expectedFinderFeeAmount = new BN(0);
    let expectedFinderFeeAmountCall = new BN(0);

    const expectLiquidation = Array.isArray(shouldLiquidate) || shouldLiquidate === true || shouldLiquidate === undefined;

    if (expectLiquidation) {
        const beforeBalances = {};

        for (let account of accounts) {
            beforeBalances[account] = await getAccountBalance(account);
        }

        const liquidatorBeforeBalance = await getAccountBalance(liquidator);

        const result = await getContracts().platform.liquidatePositions.call(accounts, {from: liquidator, gasPrice: GAS_PRICE});
        const { snapshot: snapshotCall } = await updateSnapshots(state, false);

        const tx = await getContracts().platform.liquidatePositions(accounts, {from: liquidator, gasPrice: GAS_PRICE});
        const { snapshot } = await updateSnapshots(state);

        const positionBalances = {};
        const positionBalancesCall = {};

        let accountIndex = 0;
        for (let account of accounts) {
            const {positionBalance, isPositive, fundingFees, marginDebt} = await calculateEntirePositionBalance(state, account, snapshot);
            positionBalances[account] = {positionBalance, isPositive, fundingFees, marginDebt};

            const {positionBalance: positionBalanceCall, isPositive: isPositiveCall, fundingFees: fundingFeesCall, marginDebt: marginDebtCall} = 
                await calculateEntirePositionBalance(state, account, snapshotCall);
            positionBalancesCall[account] = {positionBalance: positionBalanceCall, isPositive: isPositiveCall, fundingFees: fundingFeesCall, marginDebt: marginDebtCall};

            const position = state.positions[account];

            const {liquidable} = await isLiquidable(positionBalance, isPositive, position);

            const expectLiquidationValue = Array.isArray(shouldLiquidate) ? shouldLiquidate[accountIndex] : expectLiquidation;
            expect(liquidable === expectLiquidationValue).to.be.true;

            accountIndex++;
        }

        accountIndex = 0;
        for (let account of accounts) {
            if (Array.isArray(shouldLiquidate) && !shouldLiquidate[accountIndex]) {
                continue;
            }
            accountIndex++;

            await expectEvent(tx, 'LiquidatePosition', {positionAddress: account, currentPositionBalance: positionBalances[account].positionBalance, isBalancePositive: positionBalances[account].isPositive, positionUnitsAmount: state.positions[account].positionUnitsAmount});

            const expectedPosition = { positionUnitsAmount: toBN(0), leverage: toBN(0), openCVIValue: toBN(0), creationTimestamp: toBN(0), originalCreationTimestamp: toBN(0) };
            const actualPosition = await getContracts().platform.positions(account);
            validatePosition(actualPosition, expectedPosition);

            await expectRevert.unspecified(getContracts().platform.calculatePositionBalance(account, {from: admin}));

            const currExpectedFinderFeeAmount = getLiquidationReward(positionBalances[account].positionBalance, positionBalances[account].isPositive, state.positions[account]);
            const currExpectedFinderFeeAmountCall = getLiquidationReward(positionBalancesCall[account].positionBalance, positionBalancesCall[account].isPositive, state.positions[account]);

            subtractTotalPositionUnits(state, state.positions[account].positionUnitsAmount, positionBalances[account].fundingFees);

            state.positions[account] = expectedPosition;

            const currPosition = state.positions[account];
            currPosition.positionUnitsAmount = new BN(0);

            state.sharedPool = state.sharedPool.sub(currExpectedFinderFeeAmount).sub(positionBalances[account].marginDebt);
            state.totalMarginDebt = state.totalMarginDebt.sub(positionBalances[account].marginDebt);

            const afterBalance = await getAccountBalance(account);
            expect(afterBalance).to.be.bignumber.equal(beforeBalances[account]);

            expectedFinderFeeAmount = expectedFinderFeeAmount.add(currExpectedFinderFeeAmount);
            expectedFinderFeeAmountCall = expectedFinderFeeAmountCall.add(currExpectedFinderFeeAmountCall);
        }

        expect(result).to.be.bignumber.equal(expectedFinderFeeAmountCall);

        const liquidatorAfterBalance = await getAccountBalance(liquidator);

        if (getContracts().isETH) {
            expect(liquidatorAfterBalance.sub(liquidatorBeforeBalance)).to.be.bignumber.equal(expectedFinderFeeAmount.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
        } else {
            expect(liquidatorAfterBalance.sub(liquidatorBeforeBalance)).to.be.bignumber.equal(expectedFinderFeeAmount);
        }
    } else {
        await expectRevert(getContracts().platform.liquidatePositions(accounts, {from: liquidator}), 'No liquidable position');
    }

    await validateLPState(state);
    return expectedFinderFeeAmount;
};

exports.deposit = deposit;
exports.withdraw = withdraw;
exports.withdrawLPTokens = withdrawLPTokens;
exports.openPosition = openPosition;
exports.closePosition = closePosition;

exports.calculateDepositAmounts = calculateDepositAmounts;
exports.calculateWithdrawAmounts = calculateWithdrawAmounts;
exports.calculateTokensByBurntLPTokensAmount = calculateTokensByBurntLPTokensAmount;
exports.calculatePositionBalance = calculatePositionBalance;
exports.calculateFundingFees = calculateFundingFees;
exports.calculateFundingFeesWithSnapshot = calculateFundingFeesWithSnapshot;
exports.calculateFundingFeesWithTwoSnapshots = calculateFundingFeesWithTwoSnapshots;
exports.calculateMarginDebt = calculateMarginDebt;
exports.calculateBalance = calculateBalance;
exports.calculateOpenPositionAmounts = calculateOpenPositionAmounts;
exports.calculateLiquidationCVI = calculateLiquidationCVI;
exports.calculateLiquidationDays = calculateLiquidationDays;

exports.updateSnapshots = updateSnapshots;

exports.validatePosition = validatePosition;
exports.validateLPState = validateLPState;
exports.validateEmptyPosition = validateEmptyPosition;

exports.createState = createState;
exports.depositAndValidate = depositAndValidate;
exports.withdrawAndValidate = withdrawAndValidate;
exports.openPositionAndValidate = openPositionAndValidate;
exports.closePositionAndValidate = closePositionAndValidate;
exports.liquidateAndValidate = liquidateAndValidate;

exports.getAccountBalance = getAccountBalance;
exports.getFeesBalance = getFeesBalance;

exports.MAX_FEE = MAX_FEE;
exports.GAS_PRICE = GAS_PRICE;
exports.MAX_FEE_DELTA_COLLATERAL = MAX_FEE_DELTA_COLLATERAL;
exports.LEVERAGE_TO_THRESHOLD = LEVERAGE_TO_THRESHOLD;
exports.LEVERAGE_TO_MAX = LEVERAGE_TO_MAX;
exports.LIQUIDATION_MIN_REWARD_PERCENTAGE = LIQUIDATION_MIN_REWARD_PERCENTAGE;
exports.LIQUIDATION_MAX_FEE_PERCENTAGE = LIQUIDATION_MAX_FEE_PERCENTAGE;

exports.NO_FEES = NO_FEES;
exports.ONLY_COLLATERAL_PREMIUM = ONLY_COLLATERAL_PREMIUM;
