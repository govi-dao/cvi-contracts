const chai = require('chai');
const expect = chai.expect;

const {accounts} = require('@openzeppelin/test-environment');
const {expectRevert, expectEvent, time, BN, balance} = require('@openzeppelin/test-helpers');
const {getContracts} = require('./DeployUtils.js');
const {toBN} = require('./BNUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence, calculatePremiumFee} = require('./FeesUtils.js');
const { print } = require('./DebugUtils');

const PRECISION_DECIMALS = toBN(1, 10);
const MAX_FEE = new BN(10000);
const HEARTBEAT = new BN(55 * 60);
const GAS_PRICE = toBN(1, 10);

const LIQUIDATION_MIN_REWARD_PERCENTAGE = toBN(5);
const LEVERAGE_TO_THRESHOLD = [new BN(50), new BN(50), new BN(100), new BN(100), new BN(150), new BN(150), new BN(200), new BN(200)];
const LIQUIDATION_MAX_FEE_PERCENTAGE = new BN(1000);
const LEVERAGE_TO_MAX = [new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30)];

const [admin] = accounts;

const getBNFee = (bigNumber, fee) => {
    return bigNumber.mul(fee).div(MAX_FEE);
};

const getFee = (amount, fee) => {
    return getBNFee(toBN(amount), fee);
};

const verifyPositionEvent = (event, eventName, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    expect(event.event).to.equal(eventName);
    expect(event.address).to.equal(getContracts().platform.address);
    expect(event.args.account).to.equal(sender);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(feesAmount);
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
    expect(event.args.cviValue).to.be.bignumber.equal(new BN(cviValue));
};

const verifyOpenPositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    verifyPositionEvent(event, 'OpenPosition', sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount);
};

const verifyClosePositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    verifyPositionEvent(event, 'ClosePosition', sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount);
};

const verifyDepositEvent = async (event, sender, tokenAmount) => {
    const depositFees = await getContracts().feesCalculator.depositFeePercent();

    expect(event.event).to.equal('Deposit');
    expect(event.address).to.equal(getContracts().platform.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(depositFees).div(MAX_FEE));
    expect(event.args.account).to.equal(sender);
};

const verifyWithdrawEvent = async (event, sender, tokenAmount) => {
    const withdrawFees = await getContracts().feesCalculator.withdrawFeePercent();

    expect(event.event).to.equal('Withdraw');
    expect(event.address).to.equal(getContracts().platform.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(withdrawFees).div(MAX_FEE));
    expect(event.args.account).to.equal(sender);
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
        lpBalances
    };
};

const calculateBalance = async state => {
    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    return state.sharedPool.sub(state.totalPositionUnits.mul(cviValue).div(getContracts().maxCVIValue)).add(state.totalFundingFees);
};

const validateLPState = async state => {
    const feesBalance = getContracts().isETH ? await balance.current(getContracts().fakeFeesCollector.address, 'wei') :
        await getContracts().fakeFeesCollector.getProfit();
    expect(feesBalance).to.be.bignumber.equal(state.totalFeesSent);
    expect(await getContracts().platform.totalSupply()).to.be.bignumber.equal(state.lpTokensSupply);

    const contractBalance = getContracts().isETH ? await balance.current(getContracts().platform.address, 'wei') :
        await getContracts().token.balanceOf(getContracts().platform.address);

    //console.log('shared pool', state.sharedPool.toString());
    //console.log('total margin', state.totalMarginDebt.toString());
    expect(contractBalance).to.be.bignumber.equal(state.sharedPool.sub(state.totalMarginDebt));

    const totalLeveragedTokens = await getContracts().platform.totalLeveragedTokensAmount();
    expect(totalLeveragedTokens).to.be.bignumber.equal(state.sharedPool);

    expect(await getContracts().platform.totalPositionUnitsAmount()).to.be.bignumber.equal(state.totalPositionUnits);
    expect(await getContracts().platform.totalFundingFeesAmount()).to.be.bignumber.equal(state.totalFundingFees);

    for (let account of Object.keys(state.lpBalances)) {
        expect(await getContracts().platform.balanceOf(account)).to.be.bignumber.equal(state.lpBalances[account]);
    }

    expect(await getContracts().feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(state.turbulence);

    const totalBalance = await calculateBalance(state);
    expect(await getContracts().platform.totalBalance()).to.be.bignumber.equal(totalBalance);
};

const updateSnapshots = async (state, saveSnapshot = true) => {
    const latestTimestamp = await time.latest();
    const timestamp = latestTimestamp.toNumber();

    if (state.snapshots[timestamp] !== undefined) {
        return {latestTimestamp, snapshot: state.snapshots[timestamp]};
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

            if (saveSnapshot) {
                state.turbulence = calculateNextAverageTurbulence(state.turbulence, new BN(currTimestamp - lastTimestamp), HEARTBEAT, latestCVIRound - state.latestRound, new BN(lastCVI), new BN(currCVIValue));
            }
        }

        if (saveSnapshot) {
            state.totalFundingFees = state.totalFundingFees.add(fundingFeesPerUnit.mul(state.totalPositionUnits).div(PRECISION_DECIMALS));
        }

        snapshot = nextSnapshot;
    }

    if (saveSnapshot) {
        state.latestSnapshotTimestamp = timestamp;
        state.latestRound = latestCVIRound;
        state.snapshots[timestamp] = snapshot;
    }

    return {latestTimestamp, snapshot};
};

const calculateFundingFees = (state, currTime, account, positionUnitsAmount) => {
    const position = state.positions[account];
    return (state.snapshots[currTime.toNumber()].sub(state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
};

const calculateFundingFeesWithSnapshot = (state, currSnapshot, account, positionUnitsAmount) => {
    const position = state.positions[account];
    return (currSnapshot.sub(state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
};

const calculateEntirePositionBalance = async (state, account) => {
    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const position = state.positions[account];
    const {snapshot} = await updateSnapshots(state, false);
    const fundingFees = calculateFundingFeesWithSnapshot(state, snapshot, account, position.positionUnitsAmount);
    const marginDebt = state.positions[account].positionUnitsAmount.mul(state.positions[account].openCVIValue).mul(state.positions[account].leverage.sub(new BN(1))) .div(getContracts().maxCVIValue).div(state.positions[account].leverage);
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

const calculateLiquidationDays = async (state, account, cviValue) => {
    const {positionBalance, isPositive} = await calculateEntirePositionBalance(state, account);
    const position = state.positions[account];

    const {liquidable, liquidationBalance} = isLiquidable(positionBalance, isPositive, position);
    if (liquidable) {
        return null;
    } else {
        const leftToLose = positionBalance.sub(liquidationBalance);

        const singlePositionUnitDaiilyFee = calculateSingleUnitFee(cviValue, 3600 * 24);
        console.log(singlePositionUnitDaiilyFee.toString());
        console.log(position.positionUnitsAmount.toString());
        const daiilyFundingFee = position.positionUnitsAmount.mul(singlePositionUnitDaiilyFee).div(toBN(1, 10));

        console.log('daily funding fee', daiilyFundingFee.toString());

        const daysBeforeLiquidation = leftToLose.div(daiilyFundingFee).add(new BN(1));

        console.log('days until liquidation', daysBeforeLiquidation.toString());

        return daysBeforeLiquidation;
    }
};

const getLiquidationReward = async (positionBalance, isPositive, position) => {
    const positionUnitsAmount = position.positionUnitsAmount;
    const openCVIValue = position.openCVIValue;
    const leverage = position.leverage;

    const balance = positionUnitsAmount.mul(new BN(openCVIValue)).div(getContracts().maxCVIValue).div(position.leverage);

    if (!isPositive || toBN(positionBalance) < balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) {
        return toBN(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE));
    }

    if (isPositive && toBN(positionBalance).gte(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE))
        && toBN(positionBalance).lte( toBN(balance).mul(LEVERAGE_TO_MAX[leverage.toNumber() - 1]).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) ) {
        return toBN(positionBalance);
    }

    return balance.mul(LEVERAGE_TO_MAX[leverage.toNumber() - 1]).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
};

const calculateLPTokens = async (state, tokens) => {
    const balance = await calculateBalance(state);

    if (balance.eq(new BN(0)) || state.lpTokensSupply.eq(new BN(0))) {
        return tokens.mul(getContracts().initialRate);
    }

    return tokens.mul(state.lpTokensSupply).div(balance);
};

const calculateDepositAmounts = async (state, amount) => {
    const depositFees = await getContracts().feesCalculator.depositFeePercent();

    const depositTokens = new BN(amount);
    const depositTokenFees = getFee(amount, depositFees);
    const depositTokenMinusFees = depositTokens.sub(depositTokenFees);
    const lpTokens = await calculateLPTokens(state, depositTokenMinusFees);
    return { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens };
};

const calculateWithdrawAmounts = async (state, amount) => {
    const withdrawFees = await getContracts().feesCalculator.withdrawFeePercent();

    const withdrawTokens = new BN(amount);
    const withdrawTokenFees = getFee(amount, withdrawFees);
    const withdrawTokenMinusFees = withdrawTokens.sub(withdrawTokenFees);

    const burnedLPTokens = withdrawTokens.mul(state.lpTokensSupply).sub(new BN(1)).div(await calculateBalance(state)).add(new BN(1));

    return { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens };
};

const calculateTokensByBurntLPTokensAmount = async (state, burnAmount) => {
    return burnAmount.mul(await calculateBalance(state)).div(state.lpTokensSupply);
};

const calculateOpenPositionAmounts = async (state, amount, noPremiumFee, leverage = 1) => {
    const openPositionFeePercent = await getContracts().feesCalculator.openPositionFeePercent();
    const openPositionLPFeePercent = await getContracts().feesCalculator.openPositionLPFeePercent();
    const turbulencePercent = state.turbulence;

    const openPositionTokens = new BN(amount);
    const openPositionTokensFees = getFee(openPositionTokens.mul(new BN(leverage)), openPositionFeePercent);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const expectedPositionUnits = openPositionTokens.sub(openPositionTokensFees).mul(new BN(leverage)).mul(getContracts().maxCVIValue).div(cviValue);
    const expectedCollateral = state.totalPositionUnits.add(expectedPositionUnits).mul(PRECISION_DECIMALS).div(state.sharedPool.add((openPositionTokens.sub(openPositionTokensFees).mul(new BN(leverage)))));
    const lastCollateral = state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool);

    let premiumPercent = calculatePremiumFee(expectedPositionUnits, expectedCollateral, lastCollateral, turbulencePercent).feePercentage;
    if (!premiumPercent.gt(new BN(0))) {
        premiumPercent = openPositionLPFeePercent;
    }

    //console.log('exp position units', expectedPositionUnits.toString());
    //console.log('exp col.', expectedCollateral.toString());
    //console.log('premium', premiumPercent.toString());

    const openPositionPremiumFees = noPremiumFee ? getFee(openPositionTokens.mul(new BN(leverage)), openPositionLPFeePercent) : getFee(openPositionTokens.mul(new BN(leverage)), premiumPercent);
    const openPositionTokensMinusFees = openPositionTokens.sub(openPositionTokensFees).sub(openPositionPremiumFees);
    const openPositionLeveragedTokens = openPositionTokensMinusFees.mul(new BN(leverage));

    const positionUnits = openPositionLeveragedTokens.mul(getContracts().maxCVIValue).div(cviValue);

    return { openPositionTokens, openPositionTokensFees, openPositionPremiumFees, openPositionTokensMinusFees, openPositionLeveragedTokens, positionUnits };
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

const closePosition = (positionUnits, cviValue, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePosition(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePosition(positionUnits, cviValue, {from: account});
    }
};

const callClosePosition = (positionUnits, cviValue, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePosition.call(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePosition.call(positionUnits, cviValue, {from: account});
    }
};

const depositAndValidate = async (state, depositTokensNumber, account) => {
    const { depositTokens, depositTokenFees, depositTokenMinusFees } = await calculateDepositAmounts(state, depositTokensNumber);

    let beforeBalance;
    if (!getContracts().isETH) {
        await getContracts().token.transfer(account, depositTokens, {from: admin});
        await getContracts().token.approve(getContracts().platform.address, depositTokens, {from: account});
        beforeBalance = await getContracts().token.balanceOf(account);
    } else {
        beforeBalance = await balance.current(account, 'wei');
    }

    const tx = await deposit(depositTokens, new BN(0), account);

    print('DEPOSIT: ' + tx.receipt.gasUsed.toString());

    const {latestTimestamp: depositTimestamp} = await updateSnapshots(state);
    const { lpTokens } = await calculateDepositAmounts(state, depositTokensNumber);
    await verifyDepositEvent(tx.logs[0], account, depositTokens);

    let afterBalance;
    if (getContracts().isETH) {
        afterBalance = await balance.current(account, 'wei');
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        afterBalance = await getContracts().token.balanceOf(account);
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens);
    }

    state.lpTokensSupply = state.lpTokensSupply.add(lpTokens);
    state.sharedPool = state.sharedPool.add(depositTokenMinusFees);
    state.totalFeesSent = state.totalFeesSent.add(depositTokenFees);

    state.lpBalances[account] = state.lpBalances[account].add(lpTokens);

    await validateLPState(state);

    return depositTimestamp;
};

const withdrawAndValidate = async (state, withdrawTokensNumber, account, lpTokens) => {
    let { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens } = await calculateWithdrawAmounts(state, withdrawTokensNumber);

    if (lpTokens !== undefined) {
        burnedLPTokens = lpTokens;
        withdrawTokens = await calculateTokensByBurntLPTokensAmount(state, burnedLPTokens);
        const results = await calculateWithdrawAmounts(state, withdrawTokens);

        withdrawTokenFees = results.withdrawTokenFees;
        withdrawTokenMinusFees = results.withdrawTokenMinusFees;
    }

    const beforeBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    const result = await callWithdraw(withdrawTokens, burnedLPTokens, account);

    const tx = lpTokens === undefined ? await withdraw(withdrawTokens, burnedLPTokens, account) :
        await withdrawLPTokens(burnedLPTokens, account);
    const {latestTimestamp: timestamp} = await updateSnapshots(state);

    if (lpTokens === undefined) {
        const results = await calculateWithdrawAmounts(state, withdrawTokens);

        burnedLPTokens = results.burnedLPTokens;
        withdrawTokenMinusFees = results.withdrawTokenMinusFees;
        withdrawTokenFees = results.withdrawTokenFees;
    }

    expect(result[0]).to.be.bignumber.equal(burnedLPTokens);
    expect(result[1]).to.be.bignumber.equal(withdrawTokenMinusFees);

    await verifyWithdrawEvent(tx.logs[0], account, withdrawTokens);

    print('WITHDRAW: ' + tx.receipt.gasUsed.toString());

    const afterBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

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

    return timestamp;
};

const validatePosition = (actualPosition, expectedPosition) => {
    expect(actualPosition.positionUnitsAmount).to.be.bignumber.equal(expectedPosition.positionUnitsAmount);
    expect(actualPosition.leverage).to.be.bignumber.equal(expectedPosition.leverage);
    expect(actualPosition.openCVIValue).to.be.bignumber.equal(expectedPosition.openCVIValue);
    expect(actualPosition.creationTimestamp).to.be.bignumber.equal(expectedPosition.creationTimestamp);
    expect(actualPosition.originalCreationTimestamp).to.be.bignumber.equal(expectedPosition.originalCreationTimestamp);
};

const openPositionAndValidate = async (state, amount, account, validateRewards = true, noPremiumFee = false, leverage = 1) => {
    const beforeUnclaimedPositionUnits = await getContracts().rewards.unclaimedPositionUnits(account);

    const isMerge = state.positions[account] !== undefined;
    const openPositionTokens = new BN(amount);

    if (!getContracts().isETH) {
        await getContracts().token.transfer(account, openPositionTokens, {from: admin});
        await getContracts().token.approve(getContracts().platform.address, openPositionTokens, {from: account});
    }

    const beforeBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    let currentPositionBalance = new BN(0);
    if (isMerge) {
        currentPositionBalance = (await getContracts().platform.calculatePositionBalance(account))[0];
        console.log('position units', (await getContracts().platform.positions(account)).positionUnitsAmount.toString());
    }

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const result = noPremiumFee ? await callOpenPositionWithoutPremiumFee(openPositionTokens, cviValue, account, leverage) : await callOpenPosition(openPositionTokens, cviValue, account, 1000, leverage);
    const tx = noPremiumFee ? await openPositionWithoutPremiumFee(openPositionTokens, cviValue, account, leverage) : await openPosition(openPositionTokens, cviValue, account, 1000, leverage);

    //console.log('premium', tx.logs[0].args.premium.toString());
    //console.log('premiumPerc', tx.logs[0].args.premiumPercentage.toString());
    //console.log('collateral', tx.logs[0].args.collateral.toString());

    print('OPEN: ' + tx.receipt.gasUsed.toString());

    const {latestTimestamp: timestamp} = await updateSnapshots(state);
    const { openPositionTokensFees, openPositionPremiumFees, openPositionTokensMinusFees, openPositionLeveragedTokens, positionUnits } = await calculateOpenPositionAmounts(state, amount, noPremiumFee, leverage);

    let finalPositionUnits = positionUnits;
    let positionUnitsAdded = finalPositionUnits;
    if (isMerge) {
        const oldPositionUnits = state.positions[account].positionUnitsAmount;
        const fundingFees = calculateFundingFees(state, timestamp, account, state.positions[account].positionUnitsAmount);
        const marginDebt = state.positions[account].positionUnitsAmount.mul(state.positions[account].openCVIValue).mul(state.positions[account].leverage.sub(new BN(1))) .div(getContracts().maxCVIValue).div(state.positions[account].leverage);
        const positionBalance = state.positions[account].positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees).sub(marginDebt);
        finalPositionUnits = positionBalance.add(openPositionTokensMinusFees).mul(new BN(leverage)).mul(getContracts().maxCVIValue).div(cviValue);

        //console.log('exp position units', state.positions[account].positionUnitsAmount.toString());
        //console.log('exp margin debt', marginDebt.toString());
        expect(currentPositionBalance).to.be.bignumber.equal(positionBalance);

        positionUnitsAdded = new BN(0);
        if (oldPositionUnits.lt(finalPositionUnits)) {
            positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits);
        }

        state.totalFundingFees = state.totalFundingFees.sub(fundingFees);
        state.totalPositionUnits = state.totalPositionUnits.sub(oldPositionUnits);
        state.sharedPool = state.sharedPool.sub(positionBalance).sub(marginDebt).add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(leverage))).add(openPositionPremiumFees);
        state.totalMarginDebt = state.totalMarginDebt.sub(marginDebt).add(positionBalance.add(openPositionTokensMinusFees).mul((new BN(leverage)).sub(new BN(1))));
    }

    verifyOpenPositionEvent(tx.logs[0], account, openPositionTokens, finalPositionUnits, cviValue, openPositionTokensFees.add(openPositionPremiumFees));

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, openCVIValue: cviValue, leverage: new BN(leverage), originalCreationTimestamp: isMerge ? state.positions[account].originalCreationTimestamp : timestamp };
    const actualPosition = await getContracts().platform.positions(account);
    validatePosition(actualPosition, expectedPosition);

    const afterUnclaimedPositionUnits = await getContracts().rewards.unclaimedPositionUnits(account);

    if (validateRewards) {
        expect(afterUnclaimedPositionUnits.sub(beforeUnclaimedPositionUnits)).to.be.bignumber.equal(positionUnitsAdded.div(new BN(leverage)));
    }

    expect(result[0]).to.be.bignumber.equal(finalPositionUnits);
    expect(result[1]).to.be.bignumber.equal(openPositionLeveragedTokens);

    state.totalPositionUnits = state.totalPositionUnits.add(finalPositionUnits);
    state.positions[account] = expectedPosition;

    state.totalFeesSent = state.totalFeesSent.add(openPositionTokensFees);

    if (!isMerge) {
        state.sharedPool = state.sharedPool.add(openPositionLeveragedTokens).add(openPositionPremiumFees);
        state.totalMarginDebt = state.totalMarginDebt.add(openPositionLeveragedTokens.sub(openPositionTokensMinusFees));
    }

    await validateLPState(state);

    const afterBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    if (getContracts().isETH) {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens);
    }

    return {positionUnits: finalPositionUnits, timestamp};
};

const validateEmptyPosition = position => {
    expect(position.positionUnitsAmount).to.be.bignumber.equal(new BN(0));
    expect(position.creationTimestamp).to.be.bignumber.equal(new BN(0));
};

const closePositionAndValidate = async (state, positionUnits, account) => {
    const positionBalance = await calculatePositionBalance(positionUnits);

    const currPosition = state.positions[account];
    const marginDebt = currPosition.leverage.sub(new BN(1)).mul(currPosition.positionUnitsAmount.mul(currPosition.openCVIValue).div(getContracts().maxCVIValue).div(currPosition.leverage));
    //console.log('margin debt', marginDebt.toString());

    const beforeBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;

    const result = await callClosePosition(positionUnits, cviValue, account);

    const tx = await closePosition(positionUnits, cviValue, account);
    const {latestTimestamp: timestamp} = await updateSnapshots(state);

    print('CLOSE: ' + tx.receipt.gasUsed.toString());

    const fundingFees = calculateFundingFees(state, timestamp, account, positionUnits);
    const positionBalanceAfterFundingFees = positionBalance.sub(fundingFees);
    const closeFees = await getContracts().feesCalculator.closePositionFeePercent();
    const closePositionTokensFees = getFee(positionBalanceAfterFundingFees.sub(marginDebt), closeFees);
    const totalFees = closePositionTokensFees.add(fundingFees);
    verifyClosePositionEvent(tx.logs[0], account, positionBalance.sub(marginDebt), state.positions[account].positionUnitsAmount.sub(positionUnits), cviValue, totalFees);

    const afterBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(positionUnits);

    if (currPosition.positionUnitsAmount.toNumber() === 0) {
        const actualPosition = await getContracts().platform.positions(account);
        validateEmptyPosition(actualPosition);
        delete state.positions[account];
    } else {
        const actualPosition = await getContracts().platform.positions(account);
        validatePosition(actualPosition, currPosition);
    }

    state.totalPositionUnits = state.totalPositionUnits.sub(positionUnits);
    if (state.totalFundingFees.sub(fundingFees).lt(new BN(0))) {
        state.totalFundingFees = new BN(0);
    } else {
        state.totalFundingFees = state.totalFundingFees.sub(fundingFees);
    }

    state.totalFeesSent = state.totalFeesSent.add(closePositionTokensFees);
    state.sharedPool = state.sharedPool.sub(positionBalance).add(fundingFees);
    state.totalMarginDebt = state.totalMarginDebt.sub(marginDebt);

    await validateLPState(state);

    if (getContracts().isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees).sub(marginDebt).sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(result.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees).sub(marginDebt));
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(result);
    }

    return timestamp;
};

const liquidateAndValidate = async (state, account, liquidator, shouldLiquidate) => {
    let expectedFinderFeeAmount = new BN(0);

    const {positionBalance, isPositive, fundingFees, marginDebt} = await calculateEntirePositionBalance(state, account);
    const position = state.positions[account];

    console.log('position balance', positionBalance.toString());
    const {liquidable} = await isLiquidable(positionBalance, isPositive, position);

    console.log('liquidable', liquidable);

    expect(liquidable === shouldLiquidate || shouldLiquidate === undefined).to.be.true;

    if (liquidable) {
        await updateSnapshots(state);

        console.log('real balance', (await getContracts().platform.calculatePositionBalance(account, {from: admin}))[0].toString());

        const beforeBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);
        const liquidatorBeforeBalance = getContracts().isETH ? await balance.current(liquidator, 'wei') : await getContracts().token.balanceOf(liquidator);

        const tx = await getContracts().platform.liquidatePositions([account], {from: liquidator});
        await expectEvent(tx, 'LiquidatePosition', {positionAddress: account, currentPositionBalance: positionBalance, isBalancePositive: isPositive, positionUnitsAmount: state.positions[account].positionUnitsAmount});

        const expectedPosition = { positionUnitsAmount: toBN(0), leverage: toBN(0), openCVIValue: toBN(0), creationTimestamp: toBN(0), originalCreationTimestamp: toBN(0) };
        const actualPosition = await getContracts().platform.positions(account);
        validatePosition(actualPosition, expectedPosition);

        await expectRevert(getContracts().platform.calculatePositionBalance(account, {from: admin}), 'No position for given address');

        console.log('balance', positionBalance.toString());
        console.log('is positive', isPositive);
        console.log('position', position);
        expectedFinderFeeAmount = await getLiquidationReward(positionBalance, isPositive, position);
        console.log('expected finders fee' ,expectedFinderFeeAmount.toString());

        state.totalPositionUnits = state.totalPositionUnits.sub(position.positionUnitsAmount);
        state.totalFundingFees = state.totalFundingFees.sub(fundingFees);
        state.positions[account] = expectedPosition;

        const currPosition = state.positions[account];
        currPosition.positionUnitsAmount = new BN(0);

        console.log('finders fee', expectedFinderFeeAmount.toString());
        console.log('is positive', isPositive);
  
        expect(expectedFinderFeeAmount).to.be.bignumber.equal(expectedFinderFeeAmount);

        state.sharedPool = state.sharedPool.sub(expectedFinderFeeAmount);
        state.totalMarginDebt = state.totalMarginDebt.sub(marginDebt);

        const afterBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);
        expect(afterBalance).to.be.bignumber.equal(beforeBalance);

        const liquidatorAfterBalance = getContracts().isETH ? await balance.current(liquidator, 'wei') : await getContracts().token.balanceOf(liquidator);
        console.log(liquidatorAfterBalance.toString());
        console.log(liquidatorBeforeBalance.toString());

        if (getContracts().isETH) {
            expect(liquidatorAfterBalance.sub(liquidatorBeforeBalance)).to.be.bignumber.equal(expectedFinderFeeAmount.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
        } else {
            expect(liquidatorAfterBalance.sub(liquidatorBeforeBalance)).to.be.bignumber.equal(expectedFinderFeeAmount);
        }
    } else {
        await expectRevert(getContracts().platform.liquidatePositions([account], {from: liquidator}), 'No liquidatable position');
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
exports.calculatePositionBalance = calculatePositionBalance;
exports.calculateFundingFees = calculateFundingFees;
exports.calculateOpenPositionAmounts = calculateOpenPositionAmounts;
exports.calculateLiquidationCVI = calculateLiquidationCVI;
exports.calculateLiquidationDays = calculateLiquidationDays;

exports.updateSnapshots = updateSnapshots;

exports.verifyOpenPositionEvent = verifyOpenPositionEvent;
exports.validatePosition = validatePosition;
exports.validateLPState = validateLPState;
exports.validateEmptyPosition = validateEmptyPosition;

exports.createState = createState;
exports.depositAndValidate = depositAndValidate;
exports.withdrawAndValidate = withdrawAndValidate;
exports.openPositionAndValidate = openPositionAndValidate;
exports.closePositionAndValidate = closePositionAndValidate;
exports.liquidateAndValidate = liquidateAndValidate;

exports.MAX_FEE = MAX_FEE;
exports.GAS_PRICE = GAS_PRICE;
