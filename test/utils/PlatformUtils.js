const chai = require('chai');
const expect = chai.expect;

const {accounts} = require('@openzeppelin/test-environment');
const {time, BN, balance} = require('@openzeppelin/test-helpers');
const {getContracts} = require('./DeployUtils.js');
const {toBN} = require('./BNUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence} = require('./FeesUtils.js');
const { print } = require('./DebugUtils');

const PRECISION_DECIMALS = toBN(1, 10);
const MAX_FEE = new BN(10000);
const HEARTBEAT = new BN(55 * 60);
const MAX_CVI_VALUE = new BN(20000); //TODO: Outer contsant
const GAS_PRICE = toBN(1, 10);

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
    return state.sharedPool.sub(state.totalPositionUnits.mul(cviValue).div(MAX_CVI_VALUE)).add(state.totalFundingFees);
};

const validateLPState = async state => {
    const feesBalance = getContracts().isETH ? await balance.current(getContracts().fakeFeesCollector.address, 'wei') :
        await getContracts().fakeFeesCollector.getProfit();
    expect(feesBalance).to.be.bignumber.equal(state.totalFeesSent);
    expect(await getContracts().platform.totalSupply()).to.be.bignumber.equal(state.lpTokensSupply);

    const contractBalance = getContracts().isETH ? await balance.current(getContracts().platform.address, 'wei') :
        await getContracts().token.balanceOf(getContracts().platform.address);

    expect(contractBalance).to.be.bignumber.equal(state.sharedPool);

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

const updateSnapshots = async state => {
    const latestTimestamp = await time.latest();
    const timestamp = latestTimestamp.toNumber();
    const latestCVIRound = (await getContracts().fakeOracle.getCVILatestRoundData()).cviRoundId.toNumber();

    if (state.latestSnapshotTimestamp === undefined) {
        state.snapshots[timestamp] = PRECISION_DECIMALS;
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

            state.turbulence = calculateNextAverageTurbulence(state.turbulence, new BN(currTimestamp - lastTimestamp), HEARTBEAT, latestCVIRound - state.latestRound);
        }

        state.totalFundingFees = state.totalFundingFees.add(fundingFeesPerUnit.mul(state.totalPositionUnits).div(PRECISION_DECIMALS));
        state.snapshots[timestamp] = nextSnapshot;
    }

    state.latestSnapshotTimestamp = timestamp;
    state.latestRound = latestCVIRound;

    return latestTimestamp;
};

const calculateFundingFees = (state, currTime, account, positionUnitsAmount) => {
    const position = state.positions[account];
    return (state.snapshots[currTime.toNumber()].sub(state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
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

const calculateOpenPositionAmounts = async amount => {
    const openPositionFees = await getContracts().feesCalculator.openPositionFeePercent();
    const turbulencePercent = await getContracts().feesCalculator.turbulenceIndicatorPercent(); //TODO: Take from state
    const premiumPercent = new BN(0); //TODO: Calculate premium

    const openPositionTokens = new BN(amount);
    const openPositionTokensFees = getFee(amount, openPositionFees.add(turbulencePercent).add(premiumPercent));
    const openPositionTokensMinusFees = openPositionTokens.sub(openPositionTokensFees);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;

    const positionUnits = openPositionTokensMinusFees.mul(MAX_CVI_VALUE).div(cviValue);

    return { openPositionTokens, openPositionTokensFees, openPositionTokensMinusFees, positionUnits };
};

const calculatePositionBalance = async positionUnits => {
    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    return positionUnits.mul(cviValue).div(MAX_CVI_VALUE);
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

const closePosition = (positionUnits, cviValue, account) => {
    if (getContracts().isETH) {
        return getContracts().platform.closePosition(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return getContracts().platform.closePosition(positionUnits, cviValue, {from: account});
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

    const depositTimestamp = await updateSnapshots(state);
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
    const timestamp = await updateSnapshots(state);

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

const openPositionAndValidate = async (state, amount, account) => {
    const isMerge = state.positions[account] !== undefined;
    const { openPositionTokens, openPositionTokensFees, openPositionTokensMinusFees, positionUnits } = await calculateOpenPositionAmounts(amount);

    if (!getContracts().isETH) {
        await getContracts().token.transfer(account, openPositionTokens, {from: admin});
        await getContracts().token.approve(getContracts().platform.address, openPositionTokens, {from: account});
    }

    const beforeBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const result = await callOpenPosition(openPositionTokens, cviValue, account);
    const tx = await openPosition(openPositionTokens, cviValue, account);

    print('OPEN: ' + tx.receipt.gasUsed.toString());

    const timestamp = await updateSnapshots(state);

    let finalPositionUnits = positionUnits;
    if (isMerge) {
        const fundingFees = calculateFundingFees(state, timestamp, account, state.positions[account].positionUnitsAmount);
        const positionBalance = state.positions[account].positionUnitsAmount.mul(cviValue).div(MAX_CVI_VALUE).sub(fundingFees).add(openPositionTokensMinusFees);
        finalPositionUnits = positionBalance.mul(MAX_CVI_VALUE).div(cviValue);

        state.totalFundingFees = state.totalFundingFees.sub(fundingFees);
        state.totalPositionUnits = state.totalPositionUnits.sub(state.positions[account].positionUnitsAmount);
    }

    verifyOpenPositionEvent(tx.logs[0], account, openPositionTokens, finalPositionUnits, cviValue, openPositionTokensFees);

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, openCVIValue: cviValue, leverage: new BN(1), originalCreationTimestamp: isMerge ? state.positions[account].originalCreationTimestamp : timestamp };
    const actualPosition = await getContracts().platform.positions(account);
    validatePosition(actualPosition, expectedPosition);

    expect(result[0]).to.be.bignumber.equal(finalPositionUnits);
    expect(result[1]).to.be.bignumber.equal(openPositionTokensMinusFees);

    state.totalPositionUnits = state.totalPositionUnits.add(finalPositionUnits);
    state.positions[account] = expectedPosition;

    state.totalFeesSent = state.totalFeesSent.add(openPositionTokensFees);
    state.sharedPool = state.sharedPool.add(openPositionTokensMinusFees);

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

    const beforeBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const tx = await closePosition(positionUnits, cviValue, account);
    const timestamp = await updateSnapshots(state);

    print('CLOSE: ' + tx.receipt.gasUsed.toString());

    const fundingFees = calculateFundingFees(state, timestamp, account, positionUnits);
    const positionBalanceAfterFundingFees = positionBalance.sub(fundingFees);
    const openFees = await getContracts().feesCalculator.openPositionFeePercent();
    const closePositionTokensFees = getFee(positionBalanceAfterFundingFees, openFees);
    const totalFees = closePositionTokensFees.add(fundingFees);
    verifyClosePositionEvent(tx.logs[0], account, positionBalance, state.positions[account].positionUnitsAmount.sub(positionUnits), cviValue, totalFees);

    const afterBalance = getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account);

    const currPosition = state.positions[account];
    currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(positionUnits);

    if (currPosition.positionUnitsAmount.toNumber() === 0) {
        const actualPosition = await getContracts().platform.positions(account);
        validateEmptyPosition(actualPosition);
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

    await validateLPState(state);

    if (getContracts().isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees).sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees));
    }

    return timestamp;
};

exports.deposit = deposit;
exports.withdraw = withdraw;
exports.withdrawLPTokens = withdrawLPTokens;
exports.openPosition = openPosition;
exports.closePosition = closePosition;

exports.calculateDepositAmounts = calculateDepositAmounts;
exports.calculateWithdrawAmounts = calculateWithdrawAmounts;

exports.createState = createState;
exports.depositAndValidate = depositAndValidate;
exports.withdrawAndValidate = withdrawAndValidate;
exports.openPositionAndValidate = openPositionAndValidate;
exports.closePositionAndValidate = closePositionAndValidate;

exports.MAX_FEE = MAX_FEE;
exports.GAS_PRICE = GAS_PRICE;
