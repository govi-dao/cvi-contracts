const {expectRevert, expectEvent, time, BN, balance} = require('@openzeppelin/test-helpers');

const chai = require('chai');

const {MARGINS_TO_TEST} = require('./utils/TestUtils');
const {toBN, toUSDT, toCVI} = require('./utils/BNUtils');
const {print} = require('./utils/DebugUtils');
const {deployFullPlatform, getContracts, getAccounts} = require('./utils/DeployUtils');
const {createState, depositAndValidate, calculateDepositAmounts, calculatePositionBalance, calculateFundingFees, 
    calculateFundingFeesWithSnapshot, calculateLiquidationDays, validateEmptyPosition, validatePosition, validateLPState, 
    updateSnapshots, calculateOpenPositionAmounts, 
    MAX_FEE, GAS_PRICE, ONLY_COLLATERAL_PREMIUM, NO_FEES} = require('./utils/PlatformUtils.js');

const RequestFeesCalculator = artifacts.require('RequestFeesCalculator');
const VolatilityToken = artifacts.require('VolatilityToken');
const VolatilityTokenTest = artifacts.require('VolatilityTokenTest');

const expect = chai.expect;

const INITIAL_VOL_RATE = toBN(1, 12);
const ETH_INITIAL_VOL_RATE = toBN(1, 18);

const TOKEN_PRICE_DECIMALS = toBN(1, 6);

const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const MIN_TIME_DELAY = SECONDS_PER_HOUR;
const MAX_TIME_DELAY = 3 * SECONDS_PER_HOUR;

const MAX_TIME_DELAY_FEE = new BN(100);
const MIN_TIME_DELAY_FEE = new BN(0);

const MIN_WAIT_TIME = new BN(15 * 60);

const MAX_FEE_PERCENTAGE = new BN(10000);

const MIN_PENALTY_FEE = new BN(300);
const MAX_PENALTY_FEE = new BN(500);
const MID_PENALTY_FEE = new BN(300);

const FINDERS_FEE = new BN(5000);

const MID_PENALTY_TIME = new BN(1 * SECONDS_PER_HOUR);
const MAX_PENALTY_TIME = new BN(12 * SECONDS_PER_HOUR);

const MAX_TOTAL_REQUESTS_AMOUNT = toBN(1, 11);

const MINT_REQUEST_TYPE = 1;
const BURN_REQUEST_TYPE = 2;

const DELAYS_TO_TEST = [SECONDS_PER_HOUR, 2 * SECONDS_PER_HOUR, 3 * SECONDS_PER_HOUR];

let admin, bob, alice, carol, dave;
let accountsUsed;

const setAccounts = async () => {
    [admin, bob, alice, carol, dave] = await getAccounts();
    accountsUsed = [admin, bob, alice, carol, dave];
};

const deployVolToken = async (margin, isTest = false) => {
    this.state[margin.toString()] = {};

    this.state[margin.toString()].volTokenSupply = new BN(0);
    this.state[margin.toString()].volTokenPositionUnits = new BN(0);
    this.state[margin.toString()].totalRequestsAmount = new BN(0);

    this.requestFeesCalculator[margin.toString()] = await RequestFeesCalculator.new({from: admin});

    this.volToken[margin.toString()] = isTest ? await VolatilityTokenTest.new({from: admin}) : await VolatilityToken.new({from: admin});
    this.volToken[margin.toString()].initialize(this.token.address, 'CVI-USDC', 'CVI-USDC', margin, INITIAL_VOL_RATE,
        this.platform.address, this.fakeFeesCollector.address, this.feesCalculator.address, this.requestFeesCalculator[margin.toString()].address,
        this.fakeOracle.address, {from: admin});

    await this.platform.setAddressSpecificParameters(this.volToken[margin.toString()].address, false, true, false, {from: admin});

    this.platforms[margin.toString()] = this.platform;

    this.state[margin.toString()].nextRequestId = 1;
};

const deployPlatform = async () => {
    await setAccounts();
    await deployFullPlatform(false);

    this.cviToken = getContracts().cviToken;
    this.tokenAddress = getContracts().tokenAddress;
    this.token = getContracts().token;
    this.fakePriceProvider = getContracts().fakePriceProvider;
    this.fakeOracle = getContracts().fakeOracle;
    this.feesCalculator = getContracts().feesCalculator;
    this.fakeFeesCollector = getContracts().fakeFeesCollector;
    this.rewards = getContracts().rewards;
    this.liquidation = getContracts().liquidation;
    this.platform = getContracts().platform;

    this.state = createState(accountsUsed);
};

const beforeEachToken = async (margin, isTest = false) => {
    await deployPlatform();

    this.requestFeesCalculator = {};
    this.volToken = {};
    this.platforms = {};

    await deployVolToken(margin, isTest);
};

const beforeEachTokenAllMargins = async () => {
    await deployPlatform();

    this.requestFeesCalculator = {};
    this.volToken = {};
    this.platforms = {};

    for (let margin of MARGINS_TO_TEST) {
        await deployVolToken(margin);
    }
};

const calculateMintAmount = async (state, amount, premiumFees, margin, snapshot) => {
    const openFees = await this.feesCalculator.openPositionFeePercent();

    const openFeesAmount = amount.mul(margin).mul(openFees).div(MAX_FEE);
    const positionedTokenAmount = amount.sub(openFeesAmount).sub(premiumFees);

    const fundingFees = state.positions[this.volToken[margin.toString()].address] === undefined ? new BN(0) : await calculateFundingFeesWithSnapshot(state, snapshot, this.volToken[margin.toString()].address, state[margin.toString()].volTokenPositionUnits);

    const currPosition = state.positions[this.volToken[margin.toString()].address];

    let marginDebt = new BN(0);
    if (currPosition !== undefined) {
        marginDebt = margin.sub(new BN(1)).mul(state[margin.toString()].volTokenPositionUnits).mul(currPosition.openCVIValue).div(getContracts().maxCVIValue).div(margin);
    }

    const positionBalance = (await calculatePositionBalance(state[margin.toString()].volTokenPositionUnits)).sub(marginDebt).sub(fundingFees);

    // positionAmount / positionBalance = mintedToken / totalySupply => mintedTokens = positionAmount * totalSupply / positionBalance
    const volTokens = state[margin.toString()].volTokenSupply.eq(new BN(0)) ? positionedTokenAmount.mul(INITIAL_VOL_RATE) :
        positionedTokenAmount.mul(state[margin.toString()].volTokenSupply).div(positionBalance);

    return { positionedTokenAmount, volTokens};
};

const calculateBurnAmount = async (state, amount, time, margin, snapshot) => {
    const currPosition = this.state.positions[this.volToken[margin.toString()].address];

    expect(currPosition.leverage.toString()).to.equal(margin.toString());

    const positionUnitsToBurn = amount.mul(state[margin.toString()].volTokenPositionUnits).div(state[margin.toString()].volTokenSupply);
    const positionBalance = await calculatePositionBalance(positionUnitsToBurn);

    const marginDebt = currPosition.leverage.sub(new BN(1)).mul(positionUnitsToBurn).mul(currPosition.openCVIValue).div(getContracts().maxCVIValue).div(currPosition.leverage);

    const fundingFees = snapshot === undefined ? await calculateFundingFees(state, time, this.volToken[margin.toString()].address, positionUnitsToBurn) :
        calculateFundingFeesWithSnapshot(state, snapshot, this.volToken[margin.toString()].address, positionUnitsToBurn);

    const closeFeesPercent = await this.feesCalculator.closePositionFeePercent();
    const closeFees = positionBalance.sub(fundingFees).sub(marginDebt).mul(closeFeesPercent).div(MAX_FEE);

    const tokensReceived = positionBalance.sub(marginDebt).sub(fundingFees).sub(closeFees);

    return {tokensReceived, positionBalance, closeFees, fundingFees, positionUnitsClosed: positionUnitsToBurn, marginDebt};
};

const calculateTimeDelayFeePercentage = (timeDelay, minDelayTime = MIN_TIME_DELAY, maxDelayTime = MAX_TIME_DELAY, minDelayFee = MIN_TIME_DELAY_FEE, maxDelayFee = MAX_TIME_DELAY_FEE) => {
    return maxDelayFee.sub((new BN(timeDelay)).sub(new BN(minDelayTime)).mul(maxDelayFee.sub(minDelayFee)).div(new BN(maxDelayTime).sub(new BN(minDelayTime))));
};

const calculateTimePenaltyFeePercentage = (now, requestTime, targetTime) => {
    if (now.lt(targetTime)) {
        return targetTime.sub(now).mul(MIN_PENALTY_FEE).div(targetTime.sub(requestTime).sub(MIN_WAIT_TIME));
    } else if (now.lt(targetTime.add(MID_PENALTY_TIME))) {
        return now.sub(targetTime).mul(MID_PENALTY_FEE).div(MID_PENALTY_TIME);
    } else if (now.lt(targetTime.add(MAX_PENALTY_TIME))) {
        return MID_PENALTY_FEE.add(now.sub(targetTime).sub(MID_PENALTY_TIME).mul(MAX_PENALTY_FEE.sub(MID_PENALTY_FEE)).div(MAX_PENALTY_TIME.sub(MID_PENALTY_TIME)));
    }

    return MAX_PENALTY_FEE;
};

const validateState = async margin => {
    expect(await this.volToken[margin.toString()].totalSupply()).to.be.bignumber.equal(this.state[margin.toString()].volTokenSupply);
    expect((await this.platform.positions(this.volToken[margin.toString()].address))[0]).to.be.bignumber.equal(this.state[margin.toString()].volTokenPositionUnits);
    expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(this.state[margin.toString()].totalRequestsAmount);
};

const liquidateAndValidate = async (requestId, request, liquidator, margin, shouldValidateState = true) => {
    let beforeBalance = await this.token.balanceOf(liquidator);

    const beforeContractVolTokenBalance = await this.volToken[margin.toString()].balanceOf(this.volToken[margin.toString()].address);
    const beforeContractBalance = getContracts().isETH ? await balance.current(this.volToken[margin.toString()].address, 'wei') : await getContracts().token.balanceOf(this.volToken[margin.toString()].address);
    const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    if (shouldValidateState) {
        await validateState(margin);
    }

    const result = await this.volToken[margin.toString()].liquidateRequest.call(requestId, {from: liquidator});
    const {latestTimestamp: timestampCall, snapshot: snapshotCall} = await updateSnapshots(this.state, false);
    const tx = await this.volToken[margin.toString()].liquidateRequest(requestId, {from: liquidator});

    const {latestTimestamp: timestamp} = await updateSnapshots(this.state);

    const maxPenaltyFees = request.tokenAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);
    const timeDelayFees = request.tokenAmount.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    let leftAmount = maxPenaltyFees.add(timeDelayFees);

    const isBurn = request.requestType.eq(new BN(BURN_REQUEST_TYPE));

    let extraFeesFromBurn = new BN(0);
    let leftAmountCall = leftAmount;
    if (isBurn) {
        const {tokensReceived, closeFees, positionUnitsClosed} = await calculateBurnAmount(this.state, leftAmount, timestamp, margin);
        const {tokensReceived: tokensReceivedCall} = await calculateBurnAmount(this.state, leftAmount, timestampCall, margin, snapshotCall);

        extraFeesFromBurn = extraFeesFromBurn.add(closeFees);
        leftAmountCall = tokensReceivedCall;

        this.state[margin.toString()].volTokenSupply = this.state[margin.toString()].volTokenSupply.sub(leftAmount);
        leftAmount = tokensReceived;
        this.state[margin.toString()].volTokenPositionUnits = this.state[margin.toString()].volTokenPositionUnits.sub(positionUnitsClosed);

        await validateState(margin);
    } else {
        this.state[margin.toString()].totalRequestsAmount = this.state[margin.toString()].totalRequestsAmount.sub(request.tokenAmount);
    }

    const finderFeesAmount = leftAmount.mul(FINDERS_FEE).div(MAX_FEE_PERCENTAGE);
    const finderFeesCallAmount = leftAmountCall.mul(FINDERS_FEE).div(MAX_FEE_PERCENTAGE);

    expect(result).to.be.bignumber.equal(finderFeesCallAmount);

    let afterBalance = await this.token.balanceOf(liquidator);
    expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(finderFeesAmount);

    const afterContractBalance = getContracts().isETH ? await balance.current(this.volToken[margin.toString()].address, 'wei') : await getContracts().token.balanceOf(this.volToken[margin.toString()].address);
    const afterContractVolTokenBalance = await this.volToken[margin.toString()].balanceOf(this.volToken[margin.toString()].address);
    expect(beforeContractBalance.sub(afterContractBalance)).to.be.bignumber.equal(isBurn ? new BN(0) : leftAmount);
    expect(beforeContractVolTokenBalance.sub(afterContractVolTokenBalance)).to.be.bignumber.equal(isBurn ? maxPenaltyFees.add(timeDelayFees) : new BN(0));

    const afterFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(leftAmount.sub(finderFeesAmount).add(extraFeesFromBurn));

    await expectEvent(tx, 'LiquidateRequest', {requestId: new BN(requestId), requestType: request.requestType, account: request.owner, liquidator, findersFeeAmount: finderFeesAmount});

    await validateState(margin);
};

const calculateCollateralizedMintAmount = async (amount, cviValue, margin, snapshot) => {
    const openFees = (await this.feesCalculator.openPositionFeePercent()).add(await this.feesCalculator.openPositionLPFeePercent());
    const depositFees = await this.feesCalculator.depositFeePercent();

    const position = this.state.positions[this.volToken[margin.toString()].address];

    let gain = new BN(0);

    if (position !== undefined) {
        const fundingFees = calculateFundingFeesWithSnapshot(this.state, snapshot, this.volToken[margin.toString()].address, position.positionUnitsAmount);
        const positionBalance = position.positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees);
        const originalPositionBalance = position.positionUnitsAmount.mul(position.openCVIValue).div(getContracts().maxCVIValue);

        if (positionBalance.gt(originalPositionBalance)) {
            gain = positionBalance.sub(originalPositionBalance);
        }
    }

    const mintAmount = (new BN(-1)).mul((cviValue.mul(margin).mul(gain).mul(MAX_FEE_PERCENTAGE)).sub(margin.mul(gain).mul(getContracts().maxCVIValue).mul(MAX_FEE_PERCENTAGE)).sub(cviValue.mul(depositFees).mul(amount)).add(cviValue.mul(MAX_FEE_PERCENTAGE).mul(amount))).
        div(cviValue.mul(depositFees).sub(cviValue.mul(MAX_FEE_PERCENTAGE)).add(cviValue.mul(margin).mul(MAX_FEE_PERCENTAGE)).sub(margin.mul(getContracts().maxCVIValue).mul(MAX_FEE_PERCENTAGE)).sub(cviValue.mul(margin).mul(margin).mul(openFees)).add(margin.mul(margin).mul(getContracts().maxCVIValue).mul(openFees))).
        sub(new BN(1));

    // Sanity check the formula
    const depositAmount = amount.sub(mintAmount);

    const depositWithoutFees = depositAmount.mul(MAX_FEE_PERCENTAGE.sub(depositFees)).div(MAX_FEE_PERCENTAGE);
    const maxPositionUnits = (gain.add(mintAmount).sub(mintAmount.mul(margin).mul(openFees).div(MAX_FEE_PERCENTAGE))).mul(margin).mul(getContracts().maxCVIValue.sub(cviValue)).div(cviValue);

    expect(depositWithoutFees).to.be.bignumber.at.least(maxPositionUnits);
    expect(depositWithoutFees).to.be.bignumber.at.most(maxPositionUnits.add(new BN(100)));

    return mintAmount;
};

const fulfillMintAndValidate = async (requestId, request, timeDelayFee, account, margin, isCollateralized = false, shouldAbort = false) => {
    const isMerge = this.state.positions[this.volToken[margin.toString()].address] !== undefined;

    const tokensAmount = request.tokenAmount;

    let beforeBalance = await this.token.balanceOf(account);

    const beforeVolTokenBalance = await this.volToken[margin.toString()].balanceOf(account);
    const beforeContractTokens = getContracts().isETH ? await balance.current(this.volToken[margin.toString()].address, 'wei') : await getContracts().token.balanceOf(this.volToken[margin.toString()].address);

    const beforeLPTokens = await this.platform.balanceOf(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;

    let lpTokensCall;
    let mintedTokensCall;
    if (isCollateralized) {
        const result = await this.volToken[margin.toString()].fulfillCollateralizedMintRequest.call(requestId, {from: account});
        mintedTokensCall = result.tokensMinted;
        lpTokensCall = result.shortTokensMinted;
    } else {
        mintedTokensCall = await this.volToken[margin.toString()].fulfillMintRequest.call(requestId, MAX_FEE_PERCENTAGE, {from: account});
    }

    const {latestTimestamp: timestampCall, snapshot: snapshotCall, totalFundingFees: totalFundingFeesCall} = await updateSnapshots(this.state, false);

    const tx = isCollateralized ? await this.volToken[margin.toString()].fulfillCollateralizedMintRequest(requestId, {from: account}) :
        await this.volToken[margin.toString()].fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, {from: account});

    const {latestTimestamp: timestamp, snapshot, latestCVIRound, totalFundingFees, turbulence} = await updateSnapshots(this.state, false);

    const penaltyPercentage = calculateTimePenaltyFeePercentage(timestamp, request.requestTimestamp, request.targetTimestamp);
    const penaltyFees = tokensAmount.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE);
    const maxPenaltyFees = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);

    const penaltyPercentageCall = calculateTimePenaltyFeePercentage(timestampCall, request.requestTimestamp, request.targetTimestamp);
    const penaltyFeesCall = tokensAmount.mul(penaltyPercentageCall).div(MAX_FEE_PERCENTAGE);

    print('MINT: ' + tx.receipt.gasUsed.toString());

    const fulfillAmount = tokensAmount.sub(timeDelayFee).sub(penaltyFees);

    const mintAmount = isCollateralized ? await calculateCollateralizedMintAmount(fulfillAmount, cviValue, new BN(margin), snapshot) : fulfillAmount;
    const depositAmount = fulfillAmount.sub(mintAmount);

    const fulfillAmountCall = tokensAmount.sub(timeDelayFee).sub(penaltyFeesCall);

    const mintAmountCallExpected = isCollateralized ? await calculateCollateralizedMintAmount(fulfillAmountCall, cviValue, new BN(margin), snapshotCall) : fulfillAmountCall;
    const depositAmountCallExpected = fulfillAmountCall.sub(mintAmountCallExpected);

    let lpTokens;
    const amounts = await calculateDepositAmounts(this.state, depositAmount);
    lpTokens = amounts.lpTokens;

    let isAborted = false;

    if (isCollateralized) {
        if (mintAmount.lt(new BN(0)) || depositAmount.lt(new BN(0))) {
            // Fulfillment should be aborted, max penalty sent back and no tokens
            isAborted = true;
            expect(shouldAbort).to.be.true;
        } else {
            expect(shouldAbort).to.be.false;
        }

        let amountsCall;
        if (!isAborted) {
            this.state.turbulence = turbulence;
            this.state.latestRound = latestCVIRound;

            this.state.totalFundingFees = totalFundingFeesCall;
            this.state.latestSnapshotTimestamp = timestampCall.toNumber();

            const oldSnapshot = this.state.snapshots[timestampCall.toNumber()];
            this.state.snapshots[timestampCall.toNumber()] = snapshotCall;

            amountsCall = await calculateDepositAmounts(this.state, depositAmountCallExpected);

            this.state.snapshots[timestampCall.toNumber()] = oldSnapshot;

            this.state.totalFundingFees = totalFundingFees;
            this.state.latestSnapshotTimestamp = timestamp.toNumber();
            this.state.snapshots[timestamp.toNumber()] = snapshot;
        }

        const amounts = await calculateDepositAmounts(this.state, depositAmount);
        const depositTokenFees = amounts.depositTokenFees;
        lpTokens = amounts.lpTokens;

        expect((await this.platform.balanceOf(account)).sub(beforeLPTokens)).to.be.bignumber.equal(isAborted ? new BN(0) : lpTokens);

        expect(lpTokensCall).to.be.bignumber.equal(!isAborted ? amountsCall.lpTokens : toBN(0));

        if (!isAborted) {
            this.state.totalFeesSent = this.state.totalFeesSent.add(depositTokenFees);

            await expectEvent.inTransaction(tx.tx, getContracts().platform, 'Deposit', {account: this.volToken[margin.toString()].address, tokenAmount: depositAmount, lpTokensAmount: lpTokens,
                feeAmount: depositTokenFees});

            this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens);
            this.state.sharedPool = this.state.sharedPool.add(depositAmount.sub(depositTokenFees));
            this.state.totalFeesSent = this.state.totalFeesSent.add(depositTokenFees);

            this.state.lpBalances[account] = this.state.lpBalances[account].add(lpTokens);
        }
    } else {
        this.state.totalFundingFees = totalFundingFees;
        this.state.turbulence = turbulence;
        this.state.latestRound = latestCVIRound;
        this.state.latestSnapshotTimestamp = timestamp.toNumber();
        this.state.snapshots[timestamp.toNumber()] = snapshot;
    }

    const { openPositionTokensFees, openPositionPremiumFees, openPositionTokensMinusFees, openPositionLeveragedTokens, positionUnits } = await calculateOpenPositionAmounts(this.state, timestamp, mintAmount, isCollateralized ? NO_FEES : ONLY_COLLATERAL_PREMIUM, margin);
    const { positionedTokenAmount, volTokens } = await calculateMintAmount(this.state, mintAmount, openPositionPremiumFees, new BN(margin), snapshot);

    const { openPositionPremiumFees: openPositionPremiumFeesCall} = await calculateOpenPositionAmounts(this.state, timestampCall, mintAmountCallExpected, isCollateralized ? NO_FEES : ONLY_COLLATERAL_PREMIUM, margin);
    const { volTokens: volTokensCall } = await calculateMintAmount(this.state, mintAmountCallExpected, openPositionPremiumFeesCall, new BN(margin), snapshotCall);
    expect(mintedTokensCall).to.be.bignumber.equal(!isAborted ? volTokensCall : toBN(0));

    if (isCollateralized) {
        if (!isAborted) {
            await expectEvent(tx, 'CollateralizedMint', {account, tokenAmount: fulfillAmount, mintedTokens: volTokens, mintedShortTokens: lpTokens});
        }
    } else {
        await expectEvent(tx, 'Mint', {account, tokenAmount: positionedTokenAmount, mintedTokens: volTokens});
    }

    await expectEvent(tx, 'FulfillRequest', {requestId: new BN(requestId), account, fulfillFeesAmount: penaltyFees});

    let finalPositionUnits = positionUnits;
    let positionUnitsAdded = finalPositionUnits;

    if (!isAborted) {
        if (isMerge) {
            const oldPositionUnits = this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount;
            const fundingFees = calculateFundingFees(this.state, timestamp, this.volToken[margin.toString()].address, this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount);
            const marginDebt = this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount.mul(this.state.positions[this.volToken[margin.toString()].address].openCVIValue).mul(this.state.positions[this.volToken[margin.toString()].address].leverage.sub(new BN(1))) .div(getContracts().maxCVIValue).div(this.state.positions[this.volToken[margin.toString()].address].leverage);
            const positionBalance = this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees).sub(marginDebt);
            finalPositionUnits = positionBalance.add(openPositionTokensMinusFees).mul(new BN(margin)).mul(getContracts().maxCVIValue).div(cviValue);

            positionUnitsAdded = new BN(0);
            if (oldPositionUnits.lt(finalPositionUnits)) {
                positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits);
            }

            this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
            this.state.totalPositionUnits = this.state.totalPositionUnits.sub(this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount);
            this.state.sharedPool = this.state.sharedPool.sub(positionBalance).sub(marginDebt).add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(margin))).add(openPositionPremiumFees);
            this.state.totalMarginDebt = this.state.totalMarginDebt.sub(marginDebt).add(positionBalance.add(openPositionTokensMinusFees).mul((new BN(margin)).sub(new BN(1))));
        } else {
            this.state.sharedPool = this.state.sharedPool.add(openPositionLeveragedTokens).add(openPositionPremiumFees);
            this.state.totalMarginDebt = this.state.totalMarginDebt.add(openPositionLeveragedTokens.sub(openPositionTokensMinusFees));
        }

        await expectEvent.inTransaction(tx.tx, getContracts().platform, 'OpenPosition', {account: this.volToken[margin.toString()].address, tokenAmount: mintAmount,
            feeAmount: openPositionTokensFees.add(openPositionPremiumFees), positionUnitsAmount: finalPositionUnits, leverage: new BN(margin), cviValue: cviValue});

        const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, openCVIValue: cviValue,
        leverage: new BN(margin), originalCreationTimestamp: isMerge ? this.state.positions[this.volToken[margin.toString()].address].originalCreationTimestamp : timestamp };
        const actualPosition = await getContracts().platform.positions(this.volToken[margin.toString()].address);

        validatePosition(actualPosition, expectedPosition);

        this.state.totalPositionUnits = this.state.totalPositionUnits.add(finalPositionUnits);

        this.state.positions[this.volToken[margin.toString()].address] = expectedPosition;

        this.state.totalFeesSent = this.state.totalFeesSent.add(timeDelayFee).add(penaltyFees).add(openPositionTokensFees);
    }

    this.state[margin.toString()].totalRequestsAmount = this.state[margin.toString()].totalRequestsAmount.sub(tokensAmount);

    await validateLPState(this.state);

    let afterBalance = await this.token.balanceOf(account);

    if (isAborted) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(maxPenaltyFees);
    } else {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(tokensAmount.sub(timeDelayFee).sub(maxPenaltyFees));
    }

    const afterContractTokens = getContracts().isETH ? await balance.current(this.volToken[margin.toString()].address, 'wei') : await getContracts().token.balanceOf(this.volToken[margin.toString()].address);
    expect(beforeContractTokens.sub(afterContractTokens)).to.be.bignumber.equal(isAborted ? maxPenaltyFees : timeDelayFee.add(maxPenaltyFees));

    const afterVolTokenBalance = await this.volToken[margin.toString()].balanceOf(account);
    expect(afterVolTokenBalance.sub(beforeVolTokenBalance)).to.be.bignumber.equal(isAborted ? new BN(0) : volTokens);

    if (!isAborted) {
        this.state[margin.toString()].volTokenSupply = this.state[margin.toString()].volTokenSupply.add(volTokens);
        this.state[margin.toString()].volTokenPositionUnits = this.state[margin.toString()].volTokenPositionUnits.add(positionUnitsAdded);
    }

    await validateState(margin);
};

const fulfillBurnAndValidate = async (requestId, request, timeDelayFee, account, margin) => {
    const tokensAmount = request.tokenAmount;

    let beforeBalance = await this.token.balanceOf(account);
    let beforeVolTokenBalance = await this.volToken[margin.toString()].balanceOf(account);

    const beforeContractBalance = getContracts().isETH ? await balance.current(this.volToken[margin.toString()].address, 'wei') : await getContracts().token.balanceOf(this.volToken[margin.toString()].address);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const tokensReceivedCall = await this.volToken[margin.toString()].fulfillBurnRequest.call(requestId, {from: account});
    const {latestTimestamp: timestampCall, snapshot: snapshotCall} = await updateSnapshots(this.state, false);

    const tx = await this.volToken[margin.toString()].fulfillBurnRequest(requestId, {from: account});

    const {latestTimestamp: timestamp} = await updateSnapshots(this.state);

    print('BURN: ' + tx.receipt.gasUsed.toString());

    const {tokensReceived: tokensReceivedCallExpected} = await calculateBurnAmount(this.state, tokensAmount, timestampCall, margin, snapshotCall);

    const {tokensReceived: tokensReceivedBeforeFees, positionUnitsClosed, closeFees, fundingFees, positionBalance, marginDebt} = await calculateBurnAmount(this.state, tokensAmount, timestamp, margin);

    const timeDelayFees = tokensReceivedBeforeFees.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    const penaltyPercentage = calculateTimePenaltyFeePercentage(timestamp, request.requestTimestamp, request.targetTimestamp);
    const penaltyFees = tokensReceivedBeforeFees.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE);
    const tokensReceived = tokensReceivedBeforeFees.sub(penaltyFees).sub(timeDelayFees);

    const timeDelayFeesCall = tokensReceivedCallExpected.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    const penaltyPercentageCall = calculateTimePenaltyFeePercentage(timestampCall, request.requestTimestamp, request.targetTimestamp);
    const penaltyFeesCall = tokensReceivedCallExpected.mul(penaltyPercentageCall).div(MAX_FEE_PERCENTAGE);
    expect(tokensReceivedCall).to.be.bignumber.equal(tokensReceivedCallExpected.sub(penaltyFeesCall).sub(timeDelayFeesCall));

    const totalFees = closeFees.add(fundingFees);

    await expectEvent.inTransaction(tx.tx, getContracts().platform, 'ClosePosition', {account: this.volToken[margin.toString()].address, tokenAmount: positionBalance.sub(marginDebt), feeAmount: totalFees,
        positionUnitsAmount: this.state.positions[this.volToken[margin.toString()].address].positionUnitsAmount.sub(positionUnitsClosed), leverage: new BN(margin), cviValue});

    expectEvent(tx, 'FulfillRequest', {requestId: new BN(requestId), account, fulfillFeesAmount: penaltyFees});
    expectEvent(tx, 'Burn', {account, tokenAmount: tokensReceived, burnedTokens: tokensAmount});

    const afterContractBalance = getContracts().isETH ? await balance.current(this.volToken[margin.toString()].address, 'wei') : await getContracts().token.balanceOf(this.volToken[margin.toString()].address);

    const currPosition = this.state.positions[this.volToken[margin.toString()].address];
    currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(positionUnitsClosed);

    if (currPosition.positionUnitsAmount.toNumber() === 0) {
        const actualPosition = await getContracts().platform.positions(this.volToken[margin.toString()].address);
        validateEmptyPosition(actualPosition);
        delete this.state.positions[this.volToken[margin.toString()].address];
    } else {
        const actualPosition = await getContracts().platform.positions(this.volToken[margin.toString()].address);
        validatePosition(actualPosition, currPosition);
    }

    this.state.totalPositionUnits = this.state.totalPositionUnits.sub(positionUnitsClosed);

    if (this.state.totalFundingFees.sub(fundingFees).lt(new BN(0))) {
        this.state.totalFundingFees = new BN(0);
    } else {
        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
    }

    if (this.state.totalPositionUnits.eq(new BN(0))) {
        this.state.totalFundingFees = new BN(0);
    }

    this.state.totalFeesSent = this.state.totalFeesSent.add(closeFees).add(penaltyFees).add(timeDelayFees);
    this.state.sharedPool = this.state.sharedPool.sub(positionBalance).add(fundingFees);
    this.state.totalMarginDebt = this.state.totalMarginDebt.sub(marginDebt);

    await validateLPState(this.state);

    let afterBalance = await this.token.balanceOf(account);
    expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(tokensReceived);

    // No platform tokens (or ETH) should be saved on the contract by this action
    expect(beforeContractBalance).to.be.bignumber.equal(afterContractBalance);

    // Vol tokens sent when submitting request should be burned
    let afterVolTokenBalance = await this.volToken[margin.toString()].balanceOf(account);

    const volTokenMaxPenaltyFees = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);
    const volTokenTimeDelayFees = tokensAmount.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    expect(beforeVolTokenBalance.sub(afterVolTokenBalance)).to.be.bignumber.equal(tokensAmount.sub(volTokenMaxPenaltyFees).sub(volTokenTimeDelayFees));

    this.state[margin.toString()].volTokenSupply = this.state[margin.toString()].volTokenSupply.sub(tokensAmount);
    this.state[margin.toString()].volTokenPositionUnits = this.state[margin.toString()].volTokenPositionUnits.sub(positionUnitsClosed);

    await validateState(margin);

    return tokensReceived;
};

const validateSubmitEvent = (actual, expected) => {
    expect(actual.requestId).to.be.bignumber.equal(expected.requestId);
    expect(actual.requestType).to.be.bignumber.equal(expected.requestType);
    expect(actual.account).to.equal(expected.account);
    expect(actual.tokenAmount).to.be.bignumber.equal(expected.tokenAmount);
    expect(actual.submitFeesAmount).to.be.bignumber.equal(expected.submitFeesAmount);
    expect(actual.targetTimestamp).to.be.bignumber.equal(expected.targetTimestamp);
};

const validateRequest = (actual, expected) => {
    expect(actual.requestType).to.be.bignumber.equal(expected.requestType);
    expect(actual.tokenAmount).to.be.bignumber.equal(expected.tokenAmount);
    expect(actual.timeDelayRequestFeesPercent).to.be.bignumber.equal(expected.timeDelayRequestFeesPercent);
    expect(actual.maxRequestFeesPercent).to.be.bignumber.equal(expected.maxRequestFeesPercent);
    expect(actual.owner).to.be.bignumber.equal(expected.owner);
    expect(actual.requestTimestamp).to.be.bignumber.equal(expected.requestTimestamp);
    expect(actual.targetTimestamp).to.be.bignumber.equal(expected.targetTimestamp);
};

const submitAndValidate = async (requestType, tokensAmount, delayTime, owner, margin) => {
    if (requestType === BURN_REQUEST_TYPE) {
        const allowance = await this.volToken[margin.toString()].allowance(owner, this.volToken[margin.toString()].address);
        await this.volToken[margin.toString()].approve(this.volToken[margin.toString()].address, allowance.add(tokensAmount), {from: owner});
    } else {
        await this.token.transfer(owner, tokensAmount, {from: admin});
        const allowance = await this.token.allowance(owner, this.volToken[margin.toString()].address);
        await this.token.approve(this.volToken[margin.toString()].address, allowance.add(tokensAmount), {from: owner});
    }

    const beforeSubmitTokenBalance = await this.token.balanceOf(owner);
    const beforeSubmitVolTokenBalance = await this.volToken[margin.toString()].balanceOf(owner);
    const beforeContractTokenBalance = await this.token.balanceOf(this.volToken[margin.toString()].address);
    const beforeContractVolTokenBalance = await this.volToken[margin.toString()].balanceOf(this.volToken[margin.toString()].address);
    const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    let tx;
    if (requestType === MINT_REQUEST_TYPE) {
        tx = await this.volToken[margin.toString()].submitMintRequest(tokensAmount, delayTime, {from: owner});
    } else if (requestType === BURN_REQUEST_TYPE) {
        tx = await this.volToken[margin.toString()].submitBurnRequest(tokensAmount, delayTime, {from: owner});
    } else {
        assert.fail('request type does not exist');
    }

    const now = await time.latest();
    const targetTimestamp = now.add(new BN(delayTime));

    const afterSubmitTokenBalance = await this.token.balanceOf(owner);
    const afterSubmitVolTokenBalance = await this.volToken[margin.toString()].balanceOf(owner);
    const afterContractTokenBalance = await this.token.balanceOf(this.volToken[margin.toString()].address);
    const afterContractVolTokenBalance = await this.volToken[margin.toString()].balanceOf(this.volToken[margin.toString()].address);
    const afterFeesCollectorBalance = await this.fakeFeesCollector.getProfit();
    const timeDelayFeePercentage = calculateTimeDelayFeePercentage(delayTime);
    const timeDelayFee = tokensAmount.mul(timeDelayFeePercentage).div(MAX_FEE_PERCENTAGE);
    const maxFeeAmount = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);

    if (requestType === BURN_REQUEST_TYPE) {
        expect(beforeSubmitVolTokenBalance.sub(afterSubmitVolTokenBalance)).to.be.bignumber.equal(maxFeeAmount.add(timeDelayFee));
        expect(afterContractVolTokenBalance.sub(beforeContractVolTokenBalance)).to.be.bignumber.equal(maxFeeAmount.add(timeDelayFee));
        expect(beforeSubmitTokenBalance.sub(afterSubmitTokenBalance)).to.be.bignumber.equal(new BN(0));
        expect(afterContractTokenBalance.sub(beforeContractTokenBalance)).to.be.bignumber.equal(new BN(0));
    } else {
        expect(beforeSubmitTokenBalance.sub(afterSubmitTokenBalance)).to.be.bignumber.equal(maxFeeAmount.add(timeDelayFee));
        expect(afterContractTokenBalance.sub(beforeContractTokenBalance)).to.be.bignumber.equal(maxFeeAmount.add(timeDelayFee));
        expect(beforeSubmitVolTokenBalance.sub(afterSubmitVolTokenBalance)).to.be.bignumber.equal(new BN(0));
        expect(afterContractVolTokenBalance.sub(beforeContractVolTokenBalance)).to.be.bignumber.equal(new BN(0));

        this.state[margin.toString()].totalRequestsAmount = this.state[margin.toString()].totalRequestsAmount.add(tokensAmount);
    }

    expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(new BN(0)); // Note: fees are collected only on fulfill / liquidate

    const actualEvent = tx.logs[0].args;
    const expectedEvent = {requestId: new BN(this.state[margin.toString()].nextRequestId), requestType: new BN(requestType), account: owner, tokenAmount: tokensAmount, submitFeesAmount: timeDelayFee, targetTimestamp};
    validateSubmitEvent(actualEvent, expectedEvent);

    const request = await this.volToken[margin.toString()].requests(this.state[margin.toString()].nextRequestId);
    validateRequest(request, {requestType: new BN(requestType), tokenAmount: tokensAmount, maxRequestFeesPercent: MAX_PENALTY_FEE, timeDelayRequestFeesPercent: timeDelayFeePercentage, owner, requestTimestamp: now, targetTimestamp});

    await validateState(margin);

    const requestId = this.state[margin.toString()].nextRequestId;
    this.state[margin.toString()].nextRequestId++;

    return {requestId, timeDelayFee, request};
};

const submitMintFulfillAndValidate = async (amount, delay, account, margin, timeUntilFulfill = MIN_WAIT_TIME, isCollateralized = false, shouldAbort = false) => {
    const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, amount, delay, account, margin);
    await time.increase(timeUntilFulfill);
    await fulfillMintAndValidate(requestId, request, timeDelayFee, account, margin, isCollateralized, shouldAbort);
};

const submitBurnFulfillAndValidate = async (amount, delay, account, margin, timeUntilFulfill = MIN_WAIT_TIME) => {
    const {requestId, timeDelayFee, request} = await submitAndValidate(BURN_REQUEST_TYPE, amount, delay, account, margin);
    await time.increase(timeUntilFulfill);
    await fulfillBurnAndValidate(requestId, request, timeDelayFee, account, margin);
};

const submitAndLiquidate = async (type, amount, delay, account, liquidator, margin, timeUtnilLiquidate = MAX_PENALTY_TIME) => {
    const {requestId, request} = await submitAndValidate(type, amount, delay, account, margin);
    await time.increase(new BN(delay).add(new BN(timeUtnilLiquidate)).add(new BN(1)));
    await liquidateAndValidate(requestId, request, liquidator, margin);
};

const initFirstRebase = async (minter, mintAmount, margin, deposit = false) => {
    await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(margin)), bob);

    await this.volToken[margin.toString()].setRebaser(admin, {from: admin});
    await this.volToken[margin.toString()].setCappedRebase(false, {from: admin});

    await submitMintFulfillAndValidate(mintAmount, SECONDS_PER_HOUR, minter, margin, SECONDS_PER_HOUR);
    await this.volToken[margin.toString()].rebaseCVI({from: admin});
    await this.volToken[margin.toString()].setCappedRebase(true, {from: admin});
};

const getTokenPrice = async margin => {
    const balance = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address)).currentPositionBalance;
    const totalSupply = await this.volToken[margin.toString()].totalSupply();

    return balance.mul(TOKEN_PRICE_DECIMALS).mul(INITIAL_VOL_RATE).div(totalSupply);
};

const testSubmitRequest = async (requestType, margin) => {
    const amounts = [500, 1000, 2500, 20000];
    const delays = [SECONDS_PER_HOUR, SECONDS_PER_HOUR * 3 / 2, 2 * SECONDS_PER_HOUR, SECONDS_PER_HOUR * 5 / 2, 3 * SECONDS_PER_HOUR];

    for (let amount of amounts) {
        for (let delay of delays) {
            await submitAndValidate(requestType, new BN(amount), delay, bob, margin);
        }
    }
};

const testRequestLiquidation = async (type, amount, margin) => {
    for (let delay of DELAYS_TO_TEST) {
        await submitAndLiquidate(type, amount, delay, bob, alice, margin);
    }
};

const testFulfillDeducesRequestsTotal = async (margin, isCollateralized) => {
    await depositAndValidate(this.state, margin * 5000 * 2, alice);

    await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)), SECONDS_PER_HOUR, bob, margin);
    await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(1000)), SECONDS_PER_HOUR, bob, margin);
    const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin);

    await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');

    await time.increase(SECONDS_PER_HOUR);
    await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, isCollateralized);

    await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1001), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');
    await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin);
};

for (let margin of MARGINS_TO_TEST) {
    describe(`VolatilityToken (margin = ${margin})`, () => {
        beforeEach(async () => {
            await beforeEachToken(margin);
        });

        it('reverts when submitting requests for zero tokens', async () => {
            await expectRevert(this.volToken[margin.toString()].submitMintRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
            await expectRevert(this.volToken[margin.toString()].submitBurnRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
        });

        it('reverts when sumbtting reuqests with delay too small', async () => {
            await expectRevert(this.volToken[margin.toString()].submitMintRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
            await expectRevert(this.volToken[margin.toString()].submitBurnRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
        });

        it('reverts when sumbtting reuqests with delay too big', async () => {
            await expectRevert(this.volToken[margin.toString()].submitMintRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
            await expectRevert(this.volToken[margin.toString()].submitBurnRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
        });

        it('reverts when fulfilling mint reuqests of different owner', async () => {
            const {requestId} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);
            await expectRevert(this.volToken[margin.toString()].fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, {from: alice}), 'Not owner');
            await expectRevert(this.volToken[margin.toString()].fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, {from: admin}), 'Not owner');
        });

        it('reverts when fulfilling collateralized mint reuqests of different owner', async () => {
            const {requestId} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);
            await expectRevert(this.volToken[margin.toString()].fulfillCollateralizedMintRequest(requestId, {from: alice}), 'Not owner');
            await expectRevert(this.volToken[margin.toString()].fulfillCollateralizedMintRequest(requestId, {from: admin}), 'Not owner');
        });

        it('reverts when fulfilling burn request of different owner', async () => {
            await depositAndValidate(this.state, margin * 5000 * 10, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            const {requestId} = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);
            await expectRevert(this.volToken[margin.toString()].fulfillBurnRequest(requestId, {from: alice}), 'Not owner');
            await expectRevert(this.volToken[margin.toString()].fulfillBurnRequest(requestId, {from: admin}), 'Not owner');
        });

        it('reverts when fulfilling reuqests with an invalid id', async () => {
            await expectRevert(this.volToken[margin.toString()].fulfillMintRequest(0, MAX_FEE_PERCENTAGE, {from: bob}), 'Not owner');
            await expectRevert(this.volToken[margin.toString()].fulfillCollateralizedMintRequest(6, {from: bob}), 'Not owner');
            await expectRevert(this.volToken[margin.toString()].fulfillBurnRequest(7, {from: bob}), 'Not owner');
        });

        it('reverts when fulfilling mint reuqests of other types', async () => {
            await depositAndValidate(this.state, margin * 5000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            const {requestId: burnRequestId} = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            await expectRevert(this.volToken[margin.toString()].fulfillMintRequest(burnRequestId, MAX_FEE_PERCENTAGE, {from: bob}), 'Wrong request type');
        });

        it('reverts when fulfilling collateralized mint reuqests of other types', async () => {
            await depositAndValidate(this.state, margin * 5000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            const {requestId: burnRequestId} = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            await expectRevert(this.volToken[margin.toString()].fulfillCollateralizedMintRequest(burnRequestId, {from: bob}), 'Wrong request type');
        });

        it('reverts when fulfilling burn reuqests of other types', async () => {
            await depositAndValidate(this.state, margin * 5000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            const {requestId: mintRequestId} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            await expectRevert(this.volToken[margin.toString()].fulfillBurnRequest(mintRequestId, {from: bob}), 'Wrong request type');
        });

        it('reverts when fulfilling request ahead of time', async () => {
            await depositAndValidate(this.state, margin * 20000 * 2, alice);
            await expectRevert(submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin, MIN_WAIT_TIME.sub(new BN(2))), 'Min wait time not over');
            //YOFO: Sff vollsyrtsl mint test

            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin, MIN_WAIT_TIME);
            await expectRevert(submitBurnFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin, MIN_WAIT_TIME.sub(new BN(2))), 'Min wait time not over');
        });

        it('reverts when submitting a mint request and total requests amount is exceeded', async () => {
            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)), SECONDS_PER_HOUR, bob, margin);
            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)), SECONDS_PER_HOUR, bob, margin);

            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');
        });

        it('submits a mint request properly when total requests amount nearly exceeded', async () => {
            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)), SECONDS_PER_HOUR, bob, margin);
            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(10)), SECONDS_PER_HOUR, bob, margin);
            await submitAndValidate(MINT_REQUEST_TYPE, new BN(10), SECONDS_PER_HOUR, bob, margin);
        });

        it('submits a burn request properly when total requests amount is exceeded', async () => {
            await depositAndValidate(this.state, margin * 5000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT, SECONDS_PER_HOUR, bob, margin);
            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');

            await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin);
        });

        it('does not count burn requests in total requests amount', async () => {
            await depositAndValidate(this.state, MAX_TOTAL_REQUESTS_AMOUNT.mul(new BN(6)).mul(new BN(margin)), alice);
            await submitMintFulfillAndValidate(MAX_TOTAL_REQUESTS_AMOUNT, 2 * SECONDS_PER_HOUR, bob, margin);

            const volTokens = await this.volToken[margin.toString()].balanceOf(bob);
            expect(volTokens).to.be.bignumber.above(MAX_TOTAL_REQUESTS_AMOUNT);
            await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin);

            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT, SECONDS_PER_HOUR, bob, margin);
        });

        it('allows submitting a request after maxed out by liquidating an existing request', async () => {
            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)), SECONDS_PER_HOUR, bob, margin);
            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(1000)), SECONDS_PER_HOUR, bob, margin);
            const {requestId, request} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin);

            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');

            await time.increase(new BN(SECONDS_PER_HOUR).add(new BN(MAX_PENALTY_TIME)).add(new BN(1)));
            await liquidateAndValidate(requestId, request, alice, margin);

            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1001), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');
            await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin);
        });

        it('allows submitting a request after maxed out by fulfilling an existing mint request', async () => {
            await testFulfillDeducesRequestsTotal(margin, false);
        });

        it('allows submitting a request after maxed out by fulfilling an existing collateralized mint request', async () => {
            await testFulfillDeducesRequestsTotal(margin, true);
        });

        it('sets verify total requests amount properly', async () => {
            expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.true;
            await this.volToken[margin.toString()].setVerifyTotalRequestsAmount(false, {from: admin});
            expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.false;

            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.sub(new BN(1)), SECONDS_PER_HOUR, bob, margin);
            const {requestId, request} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin);

            await this.volToken[margin.toString()].setVerifyTotalRequestsAmount(true, {from: admin});
            expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.true;

            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');

            await time.increase(new BN(SECONDS_PER_HOUR).add(new BN(MAX_PENALTY_TIME)).add(new BN(1)));
            await liquidateAndValidate(requestId, request, alice, margin);

            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(2), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');
            await submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin);
        });

        it('sets max total requests amount properly', async () => {
            expect(await this.volToken[margin.toString()].maxTotalRequestsAmount()).to.be.bignumber.equal(MAX_TOTAL_REQUESTS_AMOUNT);

            await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT, SECONDS_PER_HOUR, bob, margin);
            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');

            await this.volToken[margin.toString()].setMaxTotalRequestsAmount(MAX_TOTAL_REQUESTS_AMOUNT.add(new BN(1)), {from: admin});
            await expectRevert(submitAndValidate(MINT_REQUEST_TYPE, toBN(2), SECONDS_PER_HOUR, bob, margin), 'Total requests amount exceeded');
            await submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin);
        });

        it('submits a mint request properly', async () => {
            await testSubmitRequest(MINT_REQUEST_TYPE, margin);
        });

        it('submits a burn request properly', async () => {
            await depositAndValidate(this.state, margin * 5000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            await testSubmitRequest(BURN_REQUEST_TYPE, margin);
        });

        it('mints tokens properly for first user', async () => {
            await depositAndValidate(this.state, margin * 5000 * 2, bob);

            const amount = new BN(1000);
            const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, amount, 2 * SECONDS_PER_HOUR, bob, margin);
            await time.increase(MIN_WAIT_TIME);

            await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin);
        });

        it('mints and burns tokens properly when there is a premium fee', async () => {
            await depositAndValidate(this.state, margin * 20000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(11000), 2 * SECONDS_PER_HOUR, bob, margin);

            const volTokens = await this.volToken[margin.toString()].balanceOf(bob);
            await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin);
        });

        it('mints tokens properly collateralized without charging premium fee', async () => {
            await depositAndValidate(this.state, margin * 20000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(11000), 2 * SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true);
        });

        it('mints tokens properly for multi users when time and cvi changes', async () => {
            await depositAndValidate(this.state, margin * 20000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);
            await time.increase(60 * 60);
            await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol, margin);
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await time.increase(60 * 70);
            await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave, margin);
            await time.increase(60 * 80);
            await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob, margin);
        });

        it('mints tokens properly collateralized (position gain + position loss)', async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true);
            await this.fakePriceProvider.setPrice(toCVI(9900));
            await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true);
            await this.fakePriceProvider.setPrice(toCVI(10500));
            await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true);
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true);
        });

        it('returns tokens when fulfilling collateralized mint without a possibility to cover liquidity', async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true);
            await this.fakePriceProvider.setPrice(toCVI(20000));
            await submitMintFulfillAndValidate(toBN(5000), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true, true);
        });

        it('burns tokens properly for single user', async () => {
            await depositAndValidate(this.state, margin * 10000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            const volTokens = await this.volToken[margin.toString()].balanceOf(bob);
            await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin);
        });

        it('burns tokens properly for multi users when time and cvi changes', async () => {
            await depositAndValidate(this.state, margin * 20000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);
            await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol, margin);
            await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave, margin);
            await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob, margin);

            const volTokensBob = await this.volToken[margin.toString()].balanceOf(bob);
            await submitBurnFulfillAndValidate(volTokensBob.div(toBN(2)), 2 * SECONDS_PER_HOUR, bob, margin);
            await time.increase(60 * 60);
            const volTokensCarol = await this.volToken[margin.toString()].balanceOf(carol);
            await submitBurnFulfillAndValidate(volTokensCarol, SECONDS_PER_HOUR, carol, margin);
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await time.increase(60 * 70);
            const volTokensDave = await this.volToken[margin.toString()].balanceOf(dave);
            await submitBurnFulfillAndValidate(volTokensDave, 2 * SECONDS_PER_HOUR, dave, margin);
            await time.increase(60 * 80);
            await submitBurnFulfillAndValidate(volTokensBob.div(toBN(2)), 3 * SECONDS_PER_HOUR, bob, margin);
            
        });

        it('reverts when trying to liquidate before max request fulfill time passed', async () => {
            for (let delay of DELAYS_TO_TEST) {
                await expectRevert(submitAndLiquidate(MINT_REQUEST_TYPE, new BN(1000), delay, bob, alice, margin, MAX_PENALTY_FEE.sub(new BN(2))), 'Not liquidable');
            }
        });

        it('reverts when trying to mint/burn/rebase when position balance is negative', async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));

            await depositAndValidate(this.state, margin * 10000 * 2, alice);
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, this.volToken[margin.toString()].address, 11000, true);
            await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation));

            const result = await this.platform.calculatePositionBalance(this.volToken[margin.toString()].address);
            expect(result.isPositive).to.be.false;

            await expectRevert(submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin), 'Negative balance');
            const volTokens = await this.volToken[margin.toString()].balanceOf(bob);
            await expectRevert(submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin), 'Negative balance');
            await expectRevert(this.volToken[margin.toString()].rebaseCVI({from: admin}), 'Negative balance');
        });

        it('reverts when liquidating a non-existent request id', async () => {
            await expectRevert(this.volToken[margin.toString()].liquidateRequest(2, {from: bob}), 'Request id not found');
        });

        it('allows mint request liquidation properly', async () => {
            await testRequestLiquidation(MINT_REQUEST_TYPE, new BN(1000), margin);
        });

        it('allows burn request liquidation properly', async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, margin * 30000, alice);
            await submitMintFulfillAndValidate(new BN(5000), 2 * SECONDS_PER_HOUR, bob, margin);

            await testRequestLiquidation(BURN_REQUEST_TYPE, toBN(1000, 12), margin);
        });

        it('liquidates burn request properly when close fees of left amount are positive', async () => {
            await depositAndValidate(this.state, toUSDT(30000).mul(new BN(margin)), alice);
            await submitMintFulfillAndValidate(toUSDT(5000), 2 * SECONDS_PER_HOUR, bob, margin);

            await submitAndLiquidate(BURN_REQUEST_TYPE, toUSDT(1000).mul(INITIAL_VOL_RATE), 2 * SECONDS_PER_HOUR, bob, alice, margin);
        });

        it('reverts when rebasing and deviation is not high enough', async () => {
            await this.fakePriceProvider.setPrice(toCVI(5000));
            await initFirstRebase(bob, toBN(2000, 6), margin);

            await expectRevert(this.volToken[margin.toString()].rebaseCVI({from: admin}), 'Not enough deviation');

            // Funding fees are 10% per day, so after 10th of a day deviation should be enough, which is 2.4 hours
            // However, this is all multiplied by margin
            await time.increase(toBN(SECONDS_PER_HOUR).div(toBN(margin)));
            await expectRevert(this.volToken[margin.toString()].rebaseCVI({from: admin}), 'Not enough deviation');
            await time.increase(toBN(SECONDS_PER_HOUR).div(toBN(margin)));
            await expectRevert(this.volToken[margin.toString()].rebaseCVI({from: admin}), 'Not enough deviation');
            await time.increase(toBN(SECONDS_PER_HOUR).div(toBN(2)).div(toBN(margin)));
            await this.volToken[margin.toString()].rebaseCVI({from: admin});
        });

        it('reverts when rebasing and deviation is too high (first rebase)', async () => {
            await this.fakePriceProvider.setPrice(toCVI(201));
            await depositAndValidate(this.state, toBN(500000, 6).mul(new BN(margin)), bob);

            await this.volToken[margin.toString()].setRebaser(admin, {from: admin});
            await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR);

            // From 1$ to 2+$ is more than 50% (out of 2+)
            await expectRevert(this.volToken[margin.toString()].rebaseCVI({from: admin}), 'Deviation too big');
        });

        if (margin === 1) {
            it('reverts when rebasing and deviation is too high (subsequent rebase)', async () => {
                await this.fakePriceProvider.setPrice(toCVI(5000));
                await initFirstRebase(bob, toBN(2000, 6), margin);

                // After 5 days, deviation is 50% for margin 1 (for margin 2 and on position will be nagative, so can't test for margin > 1)
                const timeUntilDeviation = SECONDS_PER_DAY.mul(toBN(5));
                await time.increase(timeUntilDeviation);

                await expectRevert(this.volToken[margin.toString()].rebaseCVI({from: admin}), 'Deviation too big');
            });

            it('does not revert when rebasing and deviation is almost too high (subsequent rebase)', async () => {
                await this.fakePriceProvider.setPrice(toCVI(5000));
                await initFirstRebase(bob, toBN(2000, 6), margin);

                // After 5 days, deviation is 50% for margin 1 (for margin 2 and on position will be nagative, so can't test for margin > 1)
                const timeUntilDeviation = SECONDS_PER_DAY.mul(toBN(5)).sub(toBN(60));
                await time.increase(timeUntilDeviation);

                await this.volToken[margin.toString()].rebaseCVI({from: admin});
            });
        }

        it('rebases to price correctly on first rebase (capped rebase off)', async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(margin)), bob);

            await this.volToken[margin.toString()].setRebaser(admin, {from: admin});
            await this.volToken[margin.toString()].setCappedRebase(false, {from: admin});

            await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR);

            const priceBeforeRebase = await getTokenPrice(margin);
            expect(priceBeforeRebase).to.be.bignumber.equal(TOKEN_PRICE_DECIMALS.mul(toBN(1))); // Initial price is always 1$
            await this.volToken[margin.toString()].rebaseCVI({from: admin});
            const priceAfterRebase = await getTokenPrice(margin);
            expect(priceAfterRebase).to.be.bignumber.equal(TOKEN_PRICE_DECIMALS.mul(toBN(100))); // CVI is 100
        });

        it('allows fulfilling when totalRequestsAmount becomes negative (zeroes it instead)', async () => {
            await beforeEachToken(margin, true);
            await depositAndValidate(this.state, toBN(100000, 6), bob);

            const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000, 6), SECONDS_PER_HOUR, bob, margin);

            // Zero out totalRequestsAmount
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(1000, 6));
            await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(0), {from: admin});
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0));

            await time.increase(SECONDS_PER_HOUR);

            // Should pass properly
            await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin);
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0));

            const {requestId: requestId2, timeDelayFee: timeDelayFee2, request: request2} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(2000, 6), SECONDS_PER_HOUR, bob, margin);

            // Subtract 1 from totalRequestsAmount
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6));
            await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(2000, 6).sub(toBN(1)), {from: admin});
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6).sub(toBN(1)));

            await time.increase(SECONDS_PER_HOUR);

            // Should pass properly
            await fulfillMintAndValidate(requestId2, request2, timeDelayFee2, bob, margin);
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0));
        });

        it('allows fulfilling when totalRequestsAmount becomes negative (zeroes it instead)', async () => {
            await beforeEachToken(margin, true);
            await depositAndValidate(this.state, toBN(100000, 6), bob);

            const {requestId, request} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000, 6), SECONDS_PER_HOUR, bob, margin);

            // Zero out totalRequestsAmount
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(1000, 6));
            await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(0), {from: admin});
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0));

            await time.increase(toBN(MAX_PENALTY_TIME).add(toBN(SECONDS_PER_HOUR).add(toBN(1))));

            // Should pass properly
            await liquidateAndValidate(requestId, request, bob, margin, false);
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0));

            const {requestId: requestId2, request: request2} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(2000, 6), SECONDS_PER_HOUR, bob, margin);

            // Subtract 1 from totalRequestsAmount
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6));
            await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(2000, 6).sub(toBN(1)), {from: admin});
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6).sub(toBN(1)));

            await time.increase(toBN(MAX_PENALTY_TIME).add(toBN(SECONDS_PER_HOUR).add(toBN(1))));

            // Should pass properly
            await liquidateAndValidate(requestId2, request2, bob, margin, false);
            expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0));
        });
    });
}

describe('Multi-margin VolatilityToken on same platform', () => {
    beforeEach(async () => {
        await beforeEachTokenAllMargins(false);
    });

    it('cannot fulfill requests with same id from one margin on a different margin', async () => {
        await depositAndValidate(this.state, toBN(40000), bob);

        const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), SECONDS_PER_HOUR, bob, 1);
        await expectRevert(fulfillMintAndValidate(requestId, request, timeDelayFee, bob, 2), 'Not owner');

        const {requestId: requestId2, timeDelayFee: timeDelayFee2, request: request2} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), SECONDS_PER_HOUR, bob, 3);
        await expectRevert(fulfillMintAndValidate(requestId2, request2, timeDelayFee2, bob, 4), 'Not owner');

        await time.increase(SECONDS_PER_HOUR);

        await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, 1);
        await fulfillMintAndValidate(requestId2, request2, timeDelayFee2, bob, 3, true);
    });

    it('holds spearate total requests amount per margin', async () => {
        for (let margin of MARGINS_TO_TEST) {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await testFulfillDeducesRequestsTotal(margin, margin % 2 === 0);
        }
    });

    it('cannot liquidate a request with same id on a different margin', async () => {
        const {requestId, request} = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), SECONDS_PER_HOUR, bob, 1);
        await time.increase(toBN(SECONDS_PER_HOUR).add(MAX_PENALTY_TIME).add(new BN(1)));
        await expectRevert(liquidateAndValidate(requestId, request, alice, 2), 'Request id not found');
        await liquidateAndValidate(requestId, request, alice, 1);
    });

    it('allows multi mint and burn on all margins concurrently properly', async () => {
        await depositAndValidate(this.state, toBN(400000), bob);

        const requests = [];

        for (let margin of MARGINS_TO_TEST) {
            const result = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000 + margin), SECONDS_PER_HOUR, accountsUsed[margin % accountsUsed.length], margin);
            requests[margin] = result;
        }

        await time.increase(SECONDS_PER_HOUR);

        for (let margin of MARGINS_TO_TEST) {
            await fulfillMintAndValidate(requests[margin].requestId, requests[margin].request, requests[margin].timeDelayFee, accountsUsed[margin % accountsUsed.length], margin, margin % 2 === 0);
        }

        for (let margin of MARGINS_TO_TEST) {
            const tokensAmount = await this.volToken[margin.toString()].balanceOf(accountsUsed[margin % accountsUsed.length]);
            const result = await submitAndValidate(BURN_REQUEST_TYPE, tokensAmount, SECONDS_PER_HOUR, accountsUsed[margin % accountsUsed.length], margin);
            requests[margin] = result;
        }

        await time.increase(SECONDS_PER_HOUR);

        for (let margin of MARGINS_TO_TEST) {
            await fulfillBurnAndValidate(requests[margin].requestId, requests[margin].request, requests[margin].timeDelayFee, accountsUsed[margin % accountsUsed.length], margin);
        }
    });

    it('allows submitting and fulfilling requests on multiple margins by same address', async () => {
        await depositAndValidate(this.state, toBN(400000), bob);

        const requests = [];

        for (let margin of MARGINS_TO_TEST) {
            const result = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000 + margin), SECONDS_PER_HOUR, bob, margin);
            requests[margin] = result;
        }

        await time.increase(SECONDS_PER_HOUR);

        for (let margin of MARGINS_TO_TEST) {
            await fulfillMintAndValidate(requests[margin].requestId, requests[margin].request, requests[margin].timeDelayFee, bob, margin, margin % 2 === 0);
        }
    });
});
