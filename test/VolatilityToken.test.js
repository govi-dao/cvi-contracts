const { deployProxy, upgradeProxy } = require('@openzeppelin/truffle-upgrades');
const {expectRevert, expectEvent, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');

const {toBN, toUSDT, toCVI} = require('./utils/BNUtils.js');
const { print } = require('./utils/DebugUtils');
const {deployFullPlatform, getContracts} = require('./utils/DeployUtils');
const {createState, depositAndValidate, calculateDepositAmounts, calculatePositionBalance, calculateFundingFees, validateEmptyPosition, validatePosition, validateLPState,
    updateSnapshots, calculateOpenPositionAmounts, MAX_FEE, GAS_PRICE} = require('./utils/PlatformUtils.js');

const RequestFeesCalculator = contract.fromArtifact('RequestFeesCalculator');
const VolatilityToken = contract.fromArtifact('VolatilityToken');

const expect = chai.expect;
const [admin, bob, alice, carol, dave] = accounts;
const accountsUsed = [admin, bob, alice, carol];

const INITIAL_VOL_RATE = toBN(1, 12);
const ETH_INITIAL_VOL_RATE = toBN(1, 18);

const SECONDS_PER_HOUR = 60 * 60;

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

const MINT_REQUEST_TYPE = 1;
const BURN_REQUEST_TYPE = 2;

let nextRequestId = 1;

const DELAYS_TO_TEST = [SECONDS_PER_HOUR, 2 * SECONDS_PER_HOUR, 3 * SECONDS_PER_HOUR];

const beforeEachToken = async isETH => {
    await deployFullPlatform(isETH);

    this.isETH = isETH;
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
    this.state.volTokenSupply = new BN(0);
    this.state.volTokenPositionUnits = new BN(0);

    this.requestFeesCalculator = await RequestFeesCalculator.new({from: admin});

    this.volToken = await VolatilityToken.new({from: admin});
    this.volToken.initialize(this.token.address, 'CVI-USDC', 'CVI-USDC', 1, isETH ? ETH_INITIAL_VOL_RATE : INITIAL_VOL_RATE,
        this.platform.address, this.fakeFeesCollector.address, this.feesCalculator.address, this.requestFeesCalculator.address,
        this.fakeOracle.address, {from: admin});

    await this.platform.setAddressSpecificParameters(this.volToken.address, false, true, false, {from: admin});

    nextRequestId = 1;
};

const calculateMintAmount = async (state, amount, time) => {
    const openFees = await this.feesCalculator.openPositionFeePercent();
    const lpOpenFees = await this.feesCalculator.openPositionLPFeePercent();

    const positionedTokenAmount = amount.sub(amount.mul(openFees).div(MAX_FEE)).sub(amount.mul(lpOpenFees).div(MAX_FEE));

    const fundingFees = state.positions[this.volToken.address] === undefined ? new BN(0) : await calculateFundingFees(state, time, this.volToken.address, state.volTokenPositionUnits);
    const positionBalance = (await calculatePositionBalance(state.volTokenPositionUnits)).sub(fundingFees);

    // positionAmount / positionBalance = mintedToken / totalySupply => mintedTokens = positionAmount * totalSupply / positionBalance
    const volTokens = state.volTokenSupply.eq(new BN(0)) ? positionedTokenAmount.mul(this.isETH ? ETH_INITIAL_VOL_RATE : INITIAL_VOL_RATE) :
        positionedTokenAmount.mul(state.volTokenSupply).div(positionBalance);

    return { positionedTokenAmount, volTokens};
};

const calculateBurnAmount = async (state, amount, time) => {
    const positionUnitsToBurn = amount.mul(state.volTokenPositionUnits).div(state.volTokenSupply);
    const positionBalance = await calculatePositionBalance(positionUnitsToBurn);

    const fundingFees = await calculateFundingFees(state, time, this.volToken.address, positionUnitsToBurn);

    const closeFeesPercent = await this.feesCalculator.closePositionFeePercent();
    const closeFees = positionBalance.sub(fundingFees).mul(closeFeesPercent).div(MAX_FEE);

    const tokensReceived = positionBalance.sub(fundingFees).sub(closeFees);

    return {tokensReceived, positionBalance, closeFees, fundingFees, positionUnitsClosed: positionUnitsToBurn};
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

const validateState = async () => {
    expect(await this.volToken.totalSupply()).to.be.bignumber.equal(this.state.volTokenSupply);
    expect((await this.platform.positions(this.volToken.address))[0]).to.be.bignumber.equal(this.state.volTokenPositionUnits);
};

const liquidateAndValidate = async (requestId, request, liquidator) => {
    let beforeBalance;
    if (!this.isETH) {
        beforeBalance = await this.token.balanceOf(liquidator);
    } else {
        beforeBalance = await balance.current(liquidator, 'wei');
    }

    const beforeContractVolTokenBalance = await this.volToken.balanceOf(this.volToken.address);
    const beforeContractBalance = getContracts().isETH ? await balance.current(this.volToken.address, 'wei') : await getContracts().token.balanceOf(this.volToken.address);
    const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    await validateState();

    const result = await this.volToken.liquidateRequest.call(requestId, {from: liquidator});
    const tx = await this.volToken.liquidateRequest(requestId, {from: liquidator});

    const {latestTimestamp: timestamp} = await updateSnapshots(this.state);

    const maxPenaltyFees = request.tokenAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);
    const timeDelayFees = request.tokenAmount.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    let leftAmount = maxPenaltyFees.add(timeDelayFees);

    const isBurn = request.requestType.eq(new BN(BURN_REQUEST_TYPE));

    let extraFeesFromBurn = new BN(0);
    if (isBurn) {
        const {tokensReceived, closeFees, positionUnitsClosed} = await calculateBurnAmount(this.state, leftAmount, timestamp);
        extraFeesFromBurn = extraFeesFromBurn.add(closeFees);

        this.state.volTokenSupply = this.state.volTokenSupply.sub(leftAmount);
        leftAmount = tokensReceived;
        this.state.volTokenPositionUnits = this.state.volTokenPositionUnits.sub(positionUnitsClosed);

        await validateState();
    }

    const finderFeesAmount = leftAmount.mul(FINDERS_FEE).div(MAX_FEE_PERCENTAGE);

    expect(result).to.be.bignumber.equal(finderFeesAmount);

    let afterBalance;
    if (this.isETH) {
        afterBalance = await balance.current(liquidator, 'wei');
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(finderFeesAmount.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        afterBalance = await this.token.balanceOf(liquidator);
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(finderFeesAmount);
    }

    const afterContractBalance = getContracts().isETH ? await balance.current(this.volToken.address, 'wei') : await getContracts().token.balanceOf(this.volToken.address);
    const afterContractVolTokenBalance = await this.volToken.balanceOf(this.volToken.address);
    expect(beforeContractBalance.sub(afterContractBalance)).to.be.bignumber.equal(isBurn ? new BN(0) : leftAmount);
    expect(beforeContractVolTokenBalance.sub(afterContractVolTokenBalance)).to.be.bignumber.equal(isBurn ? maxPenaltyFees.add(timeDelayFees) : new BN(0));

    const afterFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(leftAmount.sub(finderFeesAmount).add(extraFeesFromBurn));

    await expectEvent(tx, 'LiquidateRequest', {requestId: new BN(requestId), requestType: request.requestType, account: request.owner, liquidator, findersFeeAmount: finderFeesAmount});
};

const calculateCollateralizedMintAmount = async (amount, cviValue) => {
    const openFees = (await this.feesCalculator.openPositionFeePercent()).add(await this.feesCalculator.openPositionLPFeePercent());
    const depositFees = await this.feesCalculator.depositFeePercent();

    return cviValue.mul(MAX_FEE_PERCENTAGE.sub(depositFees)).mul(amount).
        div(getContracts().maxCVIValue.mul(MAX_FEE_PERCENTAGE).add(cviValue.mul(openFees)).sub(getContracts().maxCVIValue.mul(openFees)).sub(cviValue.mul(depositFees)));
};

const fulfillMintAndValidate = async (requestId, request, timeDelayFee, account, isCollateralized = false) => {
    const isMerge = this.state.positions[this.volToken.address] !== undefined;

    const tokensAmount = request.tokenAmount;

    let beforeBalance;
    if (!this.isETH) {
        beforeBalance = await this.token.balanceOf(account);
    } else {
        beforeBalance = await balance.current(account, 'wei');
    }

    const beforeVolTokenBalance = await this.volToken.balanceOf(account);
    const beforeContractTokens = getContracts().isETH ? await balance.current(this.volToken.address, 'wei') : await getContracts().token.balanceOf(this.volToken.address);

    const beforeLPTokens = await this.platform.balanceOf(account);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const result = isCollateralized ? await this.volToken.fulfillCollateralizedMintRequest.call(requestId, {from: account}) :
        await this.volToken.fulfillMintRequest.call(requestId, MAX_FEE_PERCENTAGE, {from: account});

    const tx = isCollateralized ? await this.volToken.fulfillCollateralizedMintRequest(requestId, {from: account}) :
        await this.volToken.fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, {from: account});

    const {latestTimestamp: timestamp} = await updateSnapshots(this.state);

    const penaltyPercentage = calculateTimePenaltyFeePercentage(timestamp, request.requestTimestamp, request.targetTimestamp);
    const penaltyFees = tokensAmount.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE);
    const maxPenaltyFees = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);

    print('MINT: ' + tx.receipt.gasUsed.toString());

    const fulfillAmount = tokensAmount.sub(timeDelayFee).sub(penaltyFees);

    const mintAmount = isCollateralized ? await calculateCollateralizedMintAmount(fulfillAmount, cviValue) : fulfillAmount;
    const depositAmount = fulfillAmount.sub(mintAmount);
    const { depositTokenFees, lpTokens } = await calculateDepositAmounts(this.state, depositAmount);

    if (isCollateralized) {
        expect((await this.platform.balanceOf(account)).sub(beforeLPTokens)).to.be.bignumber.equal(lpTokens);
        this.state.totalFeesSent = this.state.totalFeesSent.add(depositTokenFees);

        await expectEvent.inTransaction(tx.tx, getContracts().platform, 'Deposit', {account: this.volToken.address, tokenAmount: depositAmount, lpTokensAmount: lpTokens,
            feeAmount: depositTokenFees});

        this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens);
        this.state.sharedPool = this.state.sharedPool.add(depositAmount.sub(depositTokenFees));
        this.state.totalFeesSent = this.state.totalFeesSent.add(depositTokenFees);

        this.state.lpBalances[account] = this.state.lpBalances[account].add(lpTokens);
    }

    const { positionedTokenAmount, volTokens } = await calculateMintAmount(this.state, mintAmount, timestamp);

    if (isCollateralized) {
        await expectEvent(tx, 'CollateralizedMint', {account, tokenAmount: fulfillAmount, mintedTokens: volTokens, mintedShortTokens: lpTokens});
    } else {
        await expectEvent(tx, 'Mint', {account, tokenAmount: positionedTokenAmount, mintedTokens: volTokens});
    }

    await expectEvent(tx, 'FulfillRequest', {requestId: new BN(requestId), account, fulfillFeesAmount: penaltyFees});

    const { openPositionTokensFees, openPositionPremiumFees, openPositionTokensMinusFees, positionUnits } = await calculateOpenPositionAmounts(this.state, mintAmount);

    let finalPositionUnits = positionUnits;
    let positionUnitsAdded = finalPositionUnits;

    if (isMerge) {
        const oldPositionUnits = this.state.positions[this.volToken.address].positionUnitsAmount;
        const fundingFees = calculateFundingFees(this.state, timestamp, this.volToken.address, this.state.positions[this.volToken.address].positionUnitsAmount);
        const positionBalance = this.state.positions[this.volToken.address].positionUnitsAmount.mul(cviValue).div(getContracts().maxCVIValue).sub(fundingFees).add(openPositionTokensMinusFees);
        finalPositionUnits = positionBalance.mul(getContracts().maxCVIValue).div(cviValue);

        positionUnitsAdded = new BN(0);
        if (oldPositionUnits.lt(finalPositionUnits)) {
            positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits);
        }

        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
        this.state.totalPositionUnits = this.state.totalPositionUnits.sub(this.state.positions[this.volToken.address].positionUnitsAmount);
    }

    await expectEvent.inTransaction(tx.tx, getContracts().platform, 'OpenPosition', {account: this.volToken.address, tokenAmount: mintAmount,
        feeAmount: openPositionTokensFees.add(openPositionPremiumFees), positionUnitsAmount: finalPositionUnits, leverage: new BN(1), cviValue: cviValue});

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, openCVIValue: cviValue,
        leverage: new BN(1), originalCreationTimestamp: isMerge ? this.state.positions[this.volToken.address].originalCreationTimestamp : timestamp };
    const actualPosition = await getContracts().platform.positions(this.volToken.address);

    validatePosition(actualPosition, expectedPosition);

    this.state.totalPositionUnits = this.state.totalPositionUnits.add(finalPositionUnits);
    this.state.positions[this.volToken.address] = expectedPosition;

    this.state.totalFeesSent = this.state.totalFeesSent.add(timeDelayFee).add(penaltyFees).add(openPositionTokensFees);
    this.state.sharedPool = this.state.sharedPool.add(openPositionTokensMinusFees).add(openPositionPremiumFees);

    await validateLPState(this.state);

    let afterBalance;
    if (this.isETH) {
        afterBalance = await balance.current(account, 'wei');
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(tokensAmount.sub(timeDelayFee).sub(maxPenaltyFees).add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        afterBalance = await this.token.balanceOf(account);
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(tokensAmount.sub(timeDelayFee).sub(maxPenaltyFees));
    }

    const afterContractTokens = getContracts().isETH ? await balance.current(this.volToken.address, 'wei') : await getContracts().token.balanceOf(this.volToken.address);
    expect(beforeContractTokens.sub(afterContractTokens)).to.be.bignumber.equal(timeDelayFee.add(maxPenaltyFees));

    const afterVolTokenBalance = await this.volToken.balanceOf(account);
    expect(afterVolTokenBalance.sub(beforeVolTokenBalance)).to.be.bignumber.equal(volTokens);

    this.state.volTokenSupply = this.state.volTokenSupply.add(volTokens);
    this.state.volTokenPositionUnits = this.state.volTokenPositionUnits.add(positionUnitsAdded);

    await validateState();

};

const fulfillBurnAndValidate = async (requestId, request, timeDelayFee, account) => {
    const tokensAmount = request.tokenAmount;

    let beforeBalance;
    let beforeVolTokenBalance;

    if (!this.isETH) {
        beforeBalance = await this.token.balanceOf(account);
    } else {
        beforeBalance = await balance.current(account, 'wei');
    }

    beforeVolTokenBalance = await this.volToken.balanceOf(account);

    const beforeContractBalance = getContracts().isETH ? await balance.current(this.volToken.address, 'wei') : await getContracts().token.balanceOf(this.volToken.address);

    const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue;
    const tx = await this.volToken.fulfillBurnRequest(requestId, {from: account});

    const {latestTimestamp: timestamp} = await updateSnapshots(this.state);

    print('BURN: ' + tx.receipt.gasUsed.toString());

    const {tokensReceived: tokensReceivedBeforeFees, positionUnitsClosed, closeFees, fundingFees, positionBalance} = await calculateBurnAmount(this.state, tokensAmount, timestamp);

    const timeDelayFees = tokensReceivedBeforeFees.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    const penaltyPercentage = calculateTimePenaltyFeePercentage(timestamp, request.requestTimestamp, request.targetTimestamp);
    const penaltyFees = tokensReceivedBeforeFees.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE);
    const tokensReceived = tokensReceivedBeforeFees.sub(penaltyFees).sub(timeDelayFees);

    const totalFees = closeFees.add(fundingFees);
    expectEvent.inTransaction(tx.tx, getContracts().platform, 'ClosePosition', {account: this.volToken.address, tokenAmount: positionBalance, feeAmount: totalFees,
        positionUnitsAmount: this.state.positions[this.volToken.address].positionUnitsAmount.sub(positionUnitsClosed), cviValue, leverage: new BN(1)});

    expectEvent(tx, 'Burn', {account, tokenAmount: tokensReceived, burnedTokens: tokensAmount});

    const afterContractBalance = getContracts().isETH ? await balance.current(this.volToken.address, 'wei') : await getContracts().token.balanceOf(this.volToken.address);

    const currPosition = this.state.positions[this.volToken.address];
    currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(positionUnitsClosed);

    if (currPosition.positionUnitsAmount.toNumber() === 0) {
        const actualPosition = await getContracts().platform.positions(this.volToken.address);
        validateEmptyPosition(actualPosition);
        delete this.state.positions[this.volToken.address];
    } else {
        const actualPosition = await getContracts().platform.positions(this.volToken.address);
        validatePosition(actualPosition, currPosition);
    }

    this.state.totalPositionUnits = this.state.totalPositionUnits.sub(positionUnitsClosed);
    if (this.state.totalFundingFees.sub(fundingFees).lt(new BN(0))) {
        this.state.totalFundingFees = new BN(0);
    } else {
        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
    }

    this.state.totalFeesSent = this.state.totalFeesSent.add(closeFees).add(penaltyFees).add(timeDelayFees);
    this.state.sharedPool = this.state.sharedPool.sub(positionBalance).add(fundingFees);

    await validateLPState(this.state);

    let afterBalance;
    let afterVolTokenBalance;

    if (this.isETH) {
        afterBalance = await balance.current(account, 'wei');
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(tokensReceived.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        afterBalance = await this.token.balanceOf(account);
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(tokensReceived);
    }

    // No platform tokens (or ETH) should be saved on the contract by this action
    expect(beforeContractBalance).to.be.bignumber.equal(afterContractBalance);

    // Vol tokens sent when submitting request should be burned
    afterVolTokenBalance = await this.volToken.balanceOf(account);

    const volTokenMaxPenaltyFees = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);
    const volTokenTimeDelayFees = tokensAmount.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE);
    expect(beforeVolTokenBalance.sub(afterVolTokenBalance)).to.be.bignumber.equal(tokensAmount.sub(volTokenMaxPenaltyFees).sub(volTokenTimeDelayFees));

    this.state.volTokenSupply = this.state.volTokenSupply.sub(tokensAmount);
    this.state.volTokenPositionUnits = this.state.volTokenPositionUnits.sub(positionUnitsClosed);

    await validateState();

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

const submitAndValidate = async (requestType, tokensAmount, delayTime, owner) => {
    if (requestType === BURN_REQUEST_TYPE) {
        await this.volToken.approve(this.volToken.address, tokensAmount, {from: owner});
    } else {
        await this.token.transfer(owner, tokensAmount, {from: admin});
        await this.token.approve(this.volToken.address, tokensAmount, {from: owner});
    }

    const beforeSubmitTokenBalance = await this.token.balanceOf(owner);
    const beforeSubmitVolTokenBalance = await this.volToken.balanceOf(owner);
    const beforeContractTokenBalance = await this.token.balanceOf(this.volToken.address);
    const beforeContractVolTokenBalance = await this.volToken.balanceOf(this.volToken.address);
    const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    let tx;
    if (requestType === MINT_REQUEST_TYPE) {
        tx = await this.volToken.submitMintRequest(tokensAmount, delayTime, {from: owner});
    } else if (requestType === BURN_REQUEST_TYPE) {
        tx = await this.volToken.submitBurnRequest(tokensAmount, delayTime, {from: owner});
    } else {
        assert.fail('request type does not exist');
    }

    const now = await time.latest();
    const targetTimestamp = now.add(new BN(delayTime));

    const afterSubmitTokenBalance = await this.token.balanceOf(owner);
    const afterSubmitVolTokenBalance = await this.volToken.balanceOf(owner);
    const afterContractTokenBalance = await this.token.balanceOf(this.volToken.address);
    const afterContractVolTokenBalance = await this.volToken.balanceOf(this.volToken.address);
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
    }

    expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(new BN(0)); // Note: fees are collected only on fulfill / liquidate

    const actualEvent = tx.logs[0].args;
    const expectedEvent = {requestId: new BN(nextRequestId), requestType: new BN(requestType), account: owner, tokenAmount: tokensAmount, submitFeesAmount: timeDelayFee, targetTimestamp};
    validateSubmitEvent(actualEvent, expectedEvent);

    const request = await this.volToken.requests(nextRequestId);
    validateRequest(request, {requestType: new BN(requestType), tokenAmount: tokensAmount, maxRequestFeesPercent: MAX_PENALTY_FEE, timeDelayRequestFeesPercent: timeDelayFeePercentage, owner, requestTimestamp: now, targetTimestamp});

    const requestId = nextRequestId;
    nextRequestId++;
    return {requestId, timeDelayFee, request};
};

const submitMintFulfillAndValidate = async (amount, delay, account, timeUntilFulfill = MIN_WAIT_TIME, isCollateralized = false) => {
    const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, amount, delay, account);
    await time.increase(timeUntilFulfill);
    await fulfillMintAndValidate(requestId, request, timeDelayFee, account, isCollateralized);
};

const submitBurnFulfillAndValidate = async (amount, delay, account, timeUntilFulfill = MIN_WAIT_TIME) => {
    const {requestId, timeDelayFee, request} = await submitAndValidate(BURN_REQUEST_TYPE, amount, delay, account);
    await time.increase(timeUntilFulfill);
    await fulfillBurnAndValidate(requestId, request, timeDelayFee, account);
};

const submitAndLiquidate = async (type, amount, delay, account, liquidator, timeUtnilLiquidate = MAX_PENALTY_TIME) => {
    const {requestId, request} = await submitAndValidate(type, amount, delay, account);
    await time.increase(new BN(delay).add(new BN(timeUtnilLiquidate)).add(new BN(1)));
    await liquidateAndValidate(requestId, request, liquidator);
};

const testSubmitRequest = async requestType => {
    const amounts = [500, 1000, 2500, 20000];
    const delays = [SECONDS_PER_HOUR, SECONDS_PER_HOUR * 3 / 2, 2 * SECONDS_PER_HOUR, SECONDS_PER_HOUR * 5 / 2, 3 * SECONDS_PER_HOUR];

    for (let amount of amounts) {
        for (let delay of delays) {
            await submitAndValidate(requestType, new BN(amount), delay, bob);
        }
    }
};

const testRequestLiquidation = async (type, amount) => {
    for (let delay of DELAYS_TO_TEST) {
        await submitAndLiquidate(type, amount, delay, bob, alice);
    }
};

const setTokenTests = isETH => {
    it('reverts when submitting requests for zero tokens', async () => {
        await expectRevert(this.volToken.submitMintRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
        await expectRevert(this.volToken.submitBurnRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
    });

    it('reverts when sumbtting reuqests with delay too small', async () => {
        await expectRevert(this.volToken.submitMintRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
        await expectRevert(this.volToken.submitBurnRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
    });

    it('reverts when sumbtting reuqests with delay too big', async () => {
        await expectRevert(this.volToken.submitMintRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
        await expectRevert(this.volToken.submitBurnRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
    });

    it('reverts when fulfilling mint reuqests of different owner', async () => {
        const {requestId} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob);
        await expectRevert(this.volToken.fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, {from: alice}), 'Not owner');
        await expectRevert(this.volToken.fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, {from: admin}), 'Not owner');
    });

    it('reverts when fulfilling collateralized mint reuqests of different owner', async () => {
        const {requestId} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob);
        await expectRevert(this.volToken.fulfillCollateralizedMintRequest(requestId, {from: alice}), 'Not owner');
        await expectRevert(this.volToken.fulfillCollateralizedMintRequest(requestId, {from: admin}), 'Not owner');
    });

    it('reverts when fulfilling burn request of different owner', async () => {
        await depositAndValidate(this.state, 5000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        const {requestId} = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob);
        await expectRevert(this.volToken.fulfillBurnRequest(requestId, {from: alice}), 'Not owner');
        await expectRevert(this.volToken.fulfillBurnRequest(requestId, {from: admin}), 'Not owner');
    });

    it('reverts when fulfilling reuqests with an invalid id', async () => {
        await expectRevert(this.volToken.fulfillMintRequest(0, MAX_FEE_PERCENTAGE, {from: bob}), 'Not owner');
        await expectRevert(this.volToken.fulfillCollateralizedMintRequest(6, {from: bob}), 'Not owner');
        await expectRevert(this.volToken.fulfillBurnRequest(7, {from: bob}), 'Not owner');
    });

    it('reverts when fulfilling mint reuqests of other types', async () => {
        await depositAndValidate(this.state, 5000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        const {requestId: burnRequestId} = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        await expectRevert(this.volToken.fulfillMintRequest(burnRequestId, MAX_FEE_PERCENTAGE, {from: bob}), 'Wrong request type');
    });

    it('reverts when fulfilling collateralized mint reuqests of other types', async () => {
        await depositAndValidate(this.state, 5000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        const {requestId: burnRequestId} = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        await expectRevert(this.volToken.fulfillCollateralizedMintRequest(burnRequestId, {from: bob}), 'Wrong request type');
    });

    it('reverts when fulfilling burn reuqests of other types', async () => {
        await depositAndValidate(this.state, 5000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        const {requestId: mintRequestId} = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        await expectRevert(this.volToken.fulfillBurnRequest(mintRequestId, {from: bob}), 'Wrong request type');
    });

    it('reverts when fulfilling request ahead of time', async () => {
        await depositAndValidate(this.state, 20000, alice);
        await expectRevert(submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, MIN_WAIT_TIME.sub(new BN(2))), 'Min wait time not over');
        //YOFO: Sff vollsyrtsl mint test

        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, MIN_WAIT_TIME);
        await expectRevert(submitBurnFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, MIN_WAIT_TIME.sub(new BN(2))), 'Min wait time not over');
    });

    it('submits a mint request properly', async () => {
        await testSubmitRequest(MINT_REQUEST_TYPE);
    });

    it('submits a burn request properly', async () => {
        await depositAndValidate(this.state, 5000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        await testSubmitRequest(BURN_REQUEST_TYPE);
    });

    it('mints tokens properly for first user', async () => {
        await depositAndValidate(this.state, 5000, bob);

        const amount = new BN(1000);
        const {requestId, timeDelayFee, request} = await submitAndValidate(MINT_REQUEST_TYPE, amount, 2 * SECONDS_PER_HOUR, bob);
        await time.increase(MIN_WAIT_TIME);

        await fulfillMintAndValidate(requestId, request, timeDelayFee, bob);
    });

    it('mints tokens properly for multi users when time and cvi changes', async () => {
        await depositAndValidate(this.state, 20000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);
        await time.increase(60 * 60);
        await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol);
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await time.increase(60 * 70);
        await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave);
        await time.increase(60 * 80);
        await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob);
    });

    it('mints tokens properly collateralized', async () => {
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, SECONDS_PER_HOUR, true);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, SECONDS_PER_HOUR, true);
        await this.fakePriceProvider.setPrice(toCVI(12000));
        await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, SECONDS_PER_HOUR, true);
        await this.fakePriceProvider.setPrice(toCVI(20000));
        await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, SECONDS_PER_HOUR, true);
    });

    it.skip('mints and burns tokens properly for multi users', async () => {

    });

    it('burns tokens properly for single user', async () => {
        await depositAndValidate(this.state, 10000, alice);
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob);

        const volTokens = await this.volToken.balanceOf(bob);
        await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob);
    });

    it.skip('burns tokens properly for multi users', async () => {

    });

    it('reverts when trying to liquidate before max request fulfill time passed', async () => {
        for (let delay of DELAYS_TO_TEST) {
            await expectRevert(submitAndLiquidate(MINT_REQUEST_TYPE, new BN(1000), delay, bob, alice, MAX_PENALTY_FEE.sub(new BN(2))), 'Not liquidable');
        }
    });

    it('allows mint request liquidation properly', async () => {
        await testRequestLiquidation(MINT_REQUEST_TYPE, new BN(1000));
    });

    it('allows burn request liquidation properly', async () => {
        await depositAndValidate(this.state, 30000, alice);
        await submitMintFulfillAndValidate(new BN(5000), 2 * SECONDS_PER_HOUR, bob);

        await testRequestLiquidation(BURN_REQUEST_TYPE, toBN(1000, 12));
    });

    it('liquidates burn request properly when close fees of left amount are positive', async () => {
        await depositAndValidate(this.state, toUSDT(30000), alice);
        await submitMintFulfillAndValidate(toUSDT(5000), 2 * SECONDS_PER_HOUR, bob);

        await submitAndLiquidate(BURN_REQUEST_TYPE, toUSDT(1000).mul(INITIAL_VOL_RATE), 2 * SECONDS_PER_HOUR, bob, alice);
    });

    it('rebases to price correctly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await depositAndValidate(this.state, toBN(50000, 6), bob);

        await this.volToken.setRebaser(admin, {from: admin});
        await this.volToken.setRebaseLag(2, {from: admin});

        await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, SECONDS_PER_HOUR);

        const balance2 = (await getContracts().platform.calculatePositionBalance(this.volToken.address))[0];
        print('balance2', balance2.toString());

        await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, alice, SECONDS_PER_HOUR);

        const balance3 = (await getContracts().platform.calculatePositionBalance(this.volToken.address))[0];
        print('balance3', balance3.toString());

        print('balance-after-mint-bob', (await this.volToken.balanceOf(bob)).toString());
        print('balance-after-mint-alice', (await this.volToken.balanceOf(alice)).toString());

        await this.fakePriceProvider.setPrice(toCVI(10000));

        await submitBurnFulfillAndValidate((await this.volToken.balanceOf(bob)), 2 * SECONDS_PER_HOUR, bob);

        print('totalSupply-before', (await this.volToken.totalSupply()).toString());
        print('scalingFactor-before', (await this.volToken.scalingFactor()).toString());

        const tx = await this.volToken.rebaseCVI({from: admin});

        const balance4 = (await getContracts().platform.calculatePositionBalance(this.volToken.address))[0];
        print('balance4', balance4.toString());

        print('totalSupply-after', (await this.volToken.totalSupply()).toString());
        print('scalingFactor-after', (await this.volToken.scalingFactor()).toString());

        await time.increase(60 * 60 * 24 * 4);

        const balance5 = (await getContracts().platform.calculatePositionBalance(this.volToken.address))[0];
        print('balance5', balance5.toString());

        await this.fakePriceProvider.setPrice(toCVI(10000));

        const balance6 = (await getContracts().platform.calculatePositionBalance(this.volToken.address))[0];
        print('balance6', balance6.toString());

        const tx2 = await this.volToken.rebaseCVI({from: admin});
        const debugEvent = tx.logs[0].args;
        const debugEvent2 = tx2.logs[0].args;

        const balance7 = (await getContracts().platform.calculatePositionBalance(this.volToken.address))[0];
        print('balance7', balance7.toString());

        print('totalSupply-after', (await this.volToken.totalSupply()).toString());
        print('scalingFactor-after', (await this.volToken.scalingFactor()).toString());

        // print('alice-balance', (await this.volToken.balanceOf(alice)).toString());
        print('bob-balance', (await this.volToken.balanceOf(bob)).toString());
    });
};

describe.skip('VolatilityTokenETH', () => {
    beforeEach(async () => {
        await beforeEachToken(true);
    });

    setTokenTests(true);
});

describe.only('VolatilityToken', () => {
    beforeEach(async () => {
        await beforeEachToken(false);
    });

    setTokenTests(false);
});

