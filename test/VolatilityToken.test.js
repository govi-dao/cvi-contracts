const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');

const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const { print } = require('./utils/DebugUtils');
const {deployFullPlatform, getContracts} = require('./utils/DeployUtils');
const {createState, depositAndValidate, withdrawAndValidate, MAX_FEE, GAS_PRICE} = require('./utils/PlatformUtils.js');

const RequestFeesCalculator = contract.fromArtifact('RequestFeesCalculator');
const FakeUniswapOracle = contract.fromArtifact('FakeUniswapOracle');
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

const MAX_FEE_PERCENTAGE = new BN(10000);

const MAX_PENALTY_FEE = new BN(500);

const MINT_REQUEST_TYPE = 1;
const BURN_REQUEST_TYPE = 2;
const COLLATERALIZED_MINT_REQUEST_TYPE = 3;

let nextRequestId = 1;

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

    this.requestFeesCalculator = await RequestFeesCalculator.new({from: admin});
    this.fakeUniswapOracle = await FakeUniswapOracle.new({from: admin});

    this.volToken = await VolatilityToken.new(this.token.address, 'CVI-USDC', 'CVI-USDC', 1, isETH ? ETH_INITIAL_VOL_RATE : INITIAL_VOL_RATE,
        this.platform.address, this.fakeFeesCollector.address, this.feesCalculator.address, this.requestFeesCalculator.address, this.fakeOracle.address, this.fakeUniswapOracle.address, {from: admin});

    await this.fakeUniswapOracle.setNextPrice(1000000);
    await this.fakeUniswapOracle.update();

    nextRequestId = 1;
};

// emit Mint(msg.sender, positionedTokenAmount, tokensMinted);
const verifyMintEvent = (event, account, positionedTokenAmount, mintedTokens) => {
    expect(event.event).to.equal('Mint');
    expect(event.address).to.equal(this.volToken.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(positionedTokenAmount);
    expect(event.args.mintedTokens).to.be.bignumber.equal(mintedTokens);
    expect(event.args.account).to.equal(account);
};

const calculateMintAmount = async (state, amount) => {
    const openFees = await this.feesCalculator.openPositionFeePercent();

    const positionedTokenAmount = amount.sub(amount.mul(openFees).div(MAX_FEE_PERCENTAGE));
    const volTokens = amount.mul(this.isETH ? ETH_INITIAL_VOL_RATE : INITIAL_VOL_RATE);

    return { positionedTokenAmount, volTokens};
};

const calculateTimeDelayFeePercentage = (timeDelay, minDelayTime = MIN_TIME_DELAY, maxDelayTime = MAX_TIME_DELAY, minDelayFee = MIN_TIME_DELAY_FEE, maxDelayFee = MAX_TIME_DELAY_FEE) => {
    return maxDelayFee.sub((new BN(timeDelay)).sub(new BN(minDelayTime)).mul(maxDelayFee.sub(minDelayFee)).div(new BN(maxDelayTime).sub(new BN(minDelayTime))));
};

const mintAndValidate = async (amount, account) => {
    const tokensAmount = new BN(amount);

    let beforeBalance;
    if (!this.isETH) {
        await this.token.transfer(account, amount, {from: admin});
        await this.token.approve(this.volToken.address, tokensAmount, {from: account});
        beforeBalance = await this.token.balanceOf(account);
    } else {
        beforeBalance = await balance.current(account, 'wei');
    }

    const tx = await this.volToken.mintTokens(tokensAmount, {from: account});

    print('MINT: ' + tx.receipt.gasUsed.toString());

    const { volTokens, positionedTokenAmount } = await calculateMintAmount(this.state, tokensAmount);
    await verifyMintEvent(tx.logs[4], account, positionedTokenAmount, volTokens);

    let afterBalance;
    if (this.isETH) {
        afterBalance = await balance.current(account, 'wei');
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(tokensAmount.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        afterBalance = await this.token.balanceOf(account);
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(tokensAmount);
    }
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
    expect(actual.maxRequestFeesPercent).to.be.bignumber.equal(expected.maxRequestFeesPercent);
    expect(actual.owner).to.be.bignumber.equal(expected.owner);
    expect(actual.requestTimestamp).to.be.bignumber.equal(expected.requestTimestamp);
    expect(actual.targetTimestamp).to.be.bignumber.equal(expected.targetTimestamp);
};

const sumbitAndValidate = async (requestType, tokensAmount, delayTime, owner) => {
    await this.token.transfer(owner, tokensAmount, {from: admin});
    await this.token.approve(this.volToken.address, tokensAmount, {from: owner});

    const beforeSubmitBalance = await this.token.balanceOf(owner);
    const beforeContractBalance = await this.token.balanceOf(this.volToken.address);
    const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit();

    let tx;
    if (requestType === MINT_REQUEST_TYPE) {
        tx = await this.volToken.submitMintRequest(tokensAmount, delayTime, {from: owner});
    } else if (requestType === BURN_REQUEST_TYPE) {
        tx = await this.volToken.submitBurnRequest(tokensAmount, delayTime, {from: owner});
    } else if (requestType === COLLATERALIZED_MINT_REQUEST_TYPE) {
        tx = await this.volToken.submitCollateralizedMintRequest(tokensAmount, delayTime, {from: owner});
    } else {
        assert.fail('request type does not exist');
    }

    const now = await time.latest();
    const targetTimestamp = now.add(new BN(delayTime));

    const afterSubmitBalance = await this.token.balanceOf(owner);
    const afterContractBalance = await this.token.balanceOf(this.volToken.address);
    const afterFeesCollectorBalance = await this.fakeFeesCollector.getProfit();
    const timeDelayFeePercentage = calculateTimeDelayFeePercentage(delayTime);
    const timeDelayFee = tokensAmount.mul(timeDelayFeePercentage).div(MAX_FEE_PERCENTAGE);
    const maxFeeAmount = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE);

    expect(beforeSubmitBalance.sub(afterSubmitBalance)).to.be.bignumber.equal(maxFeeAmount.add(timeDelayFee));
    expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(new BN(0)); // Note: fees are collected only on fulfill / liquidate
    expect(afterContractBalance.sub(beforeContractBalance)).to.be.bignumber.equal(maxFeeAmount.add(timeDelayFee));

    const actualEvent = tx.logs[0].args;
    const expectedEvent = {requestId: new BN(nextRequestId), requestType: new BN(requestType), account: owner, tokenAmount: tokensAmount, submitFeesAmount: timeDelayFee, targetTimestamp};
    validateSubmitEvent(actualEvent, expectedEvent);

    const request = await this.volToken.requests(nextRequestId);
    validateRequest(request, {requestType: new BN(requestType), tokenAmount: tokensAmount, maxRequestFeesPercent: MAX_PENALTY_FEE, owner, requestTimestamp: now, targetTimestamp});

    const requestId = nextRequestId;
    nextRequestId++;
    return requestId;
};

const testSubmitRequest = async requestType => {
    const amounts = [500, 1000, 2500, 20000];
    const delays = [SECONDS_PER_HOUR, SECONDS_PER_HOUR * 3 / 2, 2 * SECONDS_PER_HOUR, SECONDS_PER_HOUR * 5 / 2, 3 * SECONDS_PER_HOUR];

    for (let amount of amounts) {
        for (let delay of delays) {
            await sumbitAndValidate(requestType, new BN(amount), delay, bob);
        }
    }
};

const setTokenTests = isETH => {
    it('reverts when submitting requests for zero tokens', async () => {
        await expectRevert(this.volToken.submitMintRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
        await expectRevert(this.volToken.submitBurnRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
        await expectRevert(this.volToken.submitCollateralizedMintRequest(0, SECONDS_PER_HOUR), 'Token amount must be positive');
    });

    it('reverts when sumbtting reuqests for too many tokens', async () => {
        await expectRevert(this.volToken.submitMintRequest(toBN(2, 60), SECONDS_PER_HOUR), 'Token amount too big');
        await expectRevert(this.volToken.submitBurnRequest(toBN(2, 60), SECONDS_PER_HOUR), 'Token amount too big');
        await expectRevert(this.volToken.submitCollateralizedMintRequest(toBN(2, 60), SECONDS_PER_HOUR), 'Token amount too big');
    });

    it('reverts when sumbtting reuqests with delay too small', async () => {
        await expectRevert(this.volToken.submitMintRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
        await expectRevert(this.volToken.submitBurnRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
        await expectRevert(this.volToken.submitCollateralizedMintRequest(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
    });

    it('reverts when sumbtting reuqests with delay too big', async () => {
        await expectRevert(this.volToken.submitMintRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
        await expectRevert(this.volToken.submitBurnRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
        await expectRevert(this.volToken.submitCollateralizedMintRequest(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
    });

    it('submits a mint request properly', async () => {
        await testSubmitRequest(MINT_REQUEST_TYPE);
    });

    it('submits a burn request properly', async () => {
        await testSubmitRequest(BURN_REQUEST_TYPE);
    });

    it('submits a collateralized request properly', async () => {
        await testSubmitRequest(COLLATERALIZED_MINT_REQUEST_TYPE);
    });

    it('mints tokens properly for first user', async () => {
        await depositAndValidate(this.state, 5000, bob);
        await mintAndValidate(1, bob);

        /*await this.token.approve(this.volToken.address, 1, {from: bob});
        await this.volToken.mintTokens(1, {from: bob});

        expect(await this.volToken.balanceOf(bob)).to.be.bignumber.equal(isETH ? ETH_INITIAL_VOL_RATE : INITIAL_VOL_RATE);*/
    });

    it('mints tokens properly for multi users', async () => {

    });

    it('burns tokens properly for single user', async () => {

    });

    it('burns tokens properly for multi users', async () => {

    });

    it.only('rebases to price correctly', async () => {
        await depositAndValidate(this.state, 5000, bob);

        await this.volToken.setRebaser(admin, {from: admin});

        const requestId = await sumbitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob);

        await time.increase(SECONDS_PER_HOUR);

        console.log((await this.volToken.balanceOf(bob)).toString());
        await this.volToken.fulfillMintRequest(requestId, {from: bob});
        console.log((await this.volToken.balanceOf(bob)).toString());

        await this.fakePriceProvider.setPrice(toCVI(10000));
        await this.fakeUniswapOracle.setNextPrice(12000);
        await this.fakeUniswapOracle.update();

        console.log((await this.volToken.totalSupply()).toString());
        console.log((await this.volToken.scalingFactor()).toString());
        await this.volToken.rebaseCVI({from: admin});
        console.log((await this.volToken.totalSupply()).toString());
        console.log((await this.volToken.scalingFactor()).toString());

        console.log((await this.volToken.balanceOf(bob)).toString());
    });
};

describe.skip('VolatilityTokenETH', () => {
    beforeEach(async () => {
        await beforeEachToken(true);
    });

    setTokenTests(true);
});

describe('VolatilityToken', () => {
    beforeEach(async () => {
        await beforeEachToken(false);
    });

    setTokenTests(false);
});

