const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const { print } = require('./utils/DebugUtils');
const chai = require('chai');
const {toTokenAmount, toUSDT, toBN, toCVI} = require('./utils/BNUtils.js');

const Platform = contract.fromArtifact('Platform');
const FeesModel = contract.fromArtifact('FeesModel');
const CVIOracle = contract.fromArtifact('CVIOracle');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const Liquidation = contract.fromArtifact('Liquidation');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const FakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const FakePlatform = contract.fromArtifact('FakePlatform');
const PositionRewards = contract.fromArtifact('PositionRewards');
const PositionRewardsHelper = contract.fromArtifact('PositionRewardsHelper');

const expect = chai.expect;
const [admin, bob, alice, carol, dave] = accounts;

const INITIAL_RATE = toBN(1, 12);
const CVI_VALUE = 11000;
const DAILY_REWARD = toBN(2300, 18);
const MAX_SINGLE_REWARD = toBN(800, 18);
const PRECISION_DECIMALS = toBN(1, 10);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SECONDS_PER_DAY = 24 * 60 * 60;

const MAX_REWARD_TIME = new BN(SECONDS_PER_DAY * 3);
const MAX_LINEAR_POSITION_UNITS = toBN(30000, 6); //TODO: Put in beforeEach
const MAX_LINEAR_GOVI = toBN(100, 18); //TODO: Put in beforeEach
const MAX_TIME_PERCENTAGE_GAIN = toBN(25, 8);

//TODO: Test setCalculationParameters divides by reward factor!

const calculateReward = (positionUnits, timePassed, maxLinearPositionUnits, maxLinearGoi, maxSingleReward, maxRewardTime, maxTimePercentageGain) => {
    const x0 = maxLinearPositionUnits === undefined ? MAX_LINEAR_POSITION_UNITS : maxLinearPositionUnits;
    const y0 = maxLinearGoi === undefined ? MAX_LINEAR_GOVI : maxLinearGoi;
    const singleReward = maxSingleReward === undefined ? MAX_SINGLE_REWARD : maxSingleReward;
    const rewardTime = maxRewardTime === undefined ? MAX_REWARD_TIME : maxRewardTime;
    const percentageGain = maxTimePercentageGain === undefined ? MAX_TIME_PERCENTAGE_GAIN : maxTimePercentageGain;

    const factoredPU = positionUnits.mul(PRECISION_DECIMALS.add(timePassed.mul(percentageGain).div(rewardTime))).div(PRECISION_DECIMALS);

    if (factoredPU.lte(x0)) {
        return factoredPU.mul(y0).div(x0);
    }

    const two = new BN(2);

    const beta = singleReward.mul(x0).div(y0);
    const alpha = two.mul(singleReward.pow(two)).mul(beta).mul(x0).div(y0);
    const gamma = two.mul(singleReward).mul(beta).mul(x0).div(y0).sub(beta.pow(two));
    const reward = singleReward.sub(alpha.div(factoredPU.add(beta).pow(two).add(gamma)));

    return reward;
};

const claimAndValidate = async (account, positionUnits, positionTimestamp, maxLinearPositionUnits, maxLinearGovi, maxSingleReward, maxRewardTime, maxTimePercentageGain) => {
    const beforeCVIAmount = await this.cviToken.balanceOf(account);
    const beforeClaimedRewards = await this.rewards.todayClaimedRewards();
    const lastDay = await this.rewards.lastClaimedDay();

    await this.rewards.claimReward({from: account});

    const claimTime = await time.latest();
    const today = claimTime.div(new BN(SECONDS_PER_DAY));

    let timePassed = claimTime.sub(positionTimestamp);
    if (timePassed.toNumber() > MAX_REWARD_TIME.toNumber()) {
        timePassed = MAX_REWARD_TIME;
    }

    const reward = calculateReward(positionUnits, timePassed, maxLinearPositionUnits, maxLinearGovi, maxSingleReward, maxRewardTime, maxTimePercentageGain);
    const afterCVIAmount = await this.cviToken.balanceOf(account);
    const afterClaimedRewards = await this.rewards.todayClaimedRewards();

    expect(afterCVIAmount.sub(beforeCVIAmount)).to.be.bignumber.equal(reward);
    expect(await this.rewards.lastClaimedDay()).to.be.bignumber.equal(today);

    if (lastDay.toNumber() < today.toNumber()) {
        expect(afterClaimedRewards).to.be.bignumber.equal(reward);
    } else {
        expect(afterClaimedRewards.sub(beforeClaimedRewards)).to.be.bignumber.equal(reward);
    }


    return reward;
};

const transferRewardTokens = async amount => {
    await this.cviToken.transfer(this.rewards.address, amount, {from: admin});
};

const setPlatform = () => this.rewards.setPlatform(this.platform.address, {from: admin});

const depositToPlatform = async amount => {
    await this.token.approve(this.platform.address, amount, {from: admin});
    await this.platform.deposit(amount, new BN(0), {from: admin});
};

const openPosition = async (amount, account) => {
    await this.token.transfer(account, amount, {from: admin});
    await this.token.approve(this.platform.address, amount, {from: account});
    const positionUnits = await this.platform.openPosition.call(amount, CVI_VALUE, {from: account});
    await this.platform.openPosition(amount, CVI_VALUE, {from: account});

    const positionTimestamp = await time.latest();

    return {positionTimestamp, positionUnits};
};

const rewardAndValidate = async (account, tokensAmount, maxLinearPositionUnits, maxLinearGovi, maxSingleReward, maxRewardTime, maxTimePercentageGain) => {
    const beforeRewardAmount = await this.rewards.unclaimedPositionUnits(account);
    const {positionUnits, positionTimestamp} = await openPosition(tokensAmount, account);
    const afterRewardAmount = await this.rewards.unclaimedPositionUnits(account);

    expect(afterRewardAmount.sub(beforeRewardAmount)).to.be.bignumber.equal(positionUnits);

    await time.increase(SECONDS_PER_DAY);
    const reward = await claimAndValidate(account, positionUnits, positionTimestamp, maxLinearPositionUnits, maxLinearGovi, maxSingleReward, maxRewardTime, maxTimePercentageGain);

    return reward;
};

describe('PositionRewards', () => {
    beforeEach(async () => {
        this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(1000000), 18, {from: admin});
        this.token = await FakeERC20.new('Wrapped Ether', 'WETH', toTokenAmount(100000), 18, {from: admin});
        this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
        this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
        this.feesCalculator = await FeesCalculator.new({from: admin});
        this.feeModel = await FeesModel.new(this.feesCalculator.address, this.fakeOracle.address, {from: admin});
        this.fakeFeesCollector = await FakeFeesCollector.new(this.token.address, {from: admin});
        this.rewards = await PositionRewards.new(this.cviToken.address, {from: admin});
        this.liquidation = await Liquidation.new({from: admin});
        this.positionRewardsHelper = await PositionRewardsHelper.new(this.rewards.address, {from: admin});

        this.platform = await Platform.new(
            this.token.address, 'WETH-LP', 'WETH-LP', INITIAL_RATE, this.feeModel.address,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});

        await this.platform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});
        await this.platform.setRewards(this.rewards.address, {from: admin});

        await this.feesCalculator.setOpenPositionFee(new BN(0), {from: admin});

        await this.fakePriceProvider.setPrice(toCVI(CVI_VALUE));

        await this.rewards.setRewarder(this.platform.address, {from: admin});
    });

    it('reverts when rewarding zero position units', async() => {
        await expectRevert(this.rewards.reward(bob, new BN(0), {from: this.platform.address}), 'Position units must be positive');
    });

    it('rewards position units properly when opening positions', async() => {
        await depositToPlatform(toTokenAmount(30000));

        expect(await this.rewards.unclaimedPositionUnits(bob)).to.be.bignumber.equal(new BN(0));
        expect(await this.rewards.unclaimedPositionUnits(alice)).to.be.bignumber.equal(new BN(0));

        const {positionUnits: bobPositionUnits} = await openPosition(toTokenAmount(1000), bob);
        const {positionUnits: alicePositionUnits1} = await openPosition(toTokenAmount(2000), alice);
        const {positionUnits: alicePositionUnits2} = await openPosition(toTokenAmount(3000), alice);

        expect(await this.rewards.unclaimedPositionUnits(bob)).to.be.bignumber.equal(bobPositionUnits);
        expect(await this.rewards.unclaimedPositionUnits(alice)).to.be.bignumber.equal(alicePositionUnits1.add(alicePositionUnits2));
    });

    it('reverts when not rewarding by allowed caller', async() => {
        await this.rewards.setRewarder(admin, {from: admin});

        await expectRevert(this.rewards.reward(admin, toTokenAmount(1000), {from: bob}), 'Not allowed');
        await expectRevert(this.rewards.reward(admin, toTokenAmount(1000), {from: alice}), 'Not allowed');
        await expectRevert(this.rewards.reward(admin, toTokenAmount(1000), {from: carol}), 'Not allowed');

        await this.rewards.reward(bob, toTokenAmount(1000), {from: admin});
        await this.rewards.reward(alice, toTokenAmount(1000), {from: admin});
        await this.rewards.reward(admin, toTokenAmount(1000), {from: admin});
    });

    it('reverts when caliming reward and platform is not set', async () => {
        await expectRevert(this.rewards.claimReward({from: bob}), 'Platform not set');
    });

    it('reverts when claiming with no opened positions', async () => {
        await setPlatform();

        await expectRevert(this.rewards.claimReward({from: bob}), 'No opened position');
    });

    it('reverts when claiming after position was fully closed', async () => {
        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionUnits} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY);
        await this.platform.closePosition(positionUnits, new BN(CVI_VALUE), {from: bob});

        await expectRevert(this.rewards.claimReward({from: bob}), 'No opened position');
    });

    it('claims correct amount after openning, closing and openning another position on the same day', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await this.platform.setBuyersLockupPeriod(0, {from: admin});

        await setPlatform();
        await depositToPlatform(toTokenAmount(20000));
        const {positionUnits} = await openPosition(toTokenAmount(1000), bob);
        await this.platform.closePosition(positionUnits, new BN(CVI_VALUE), {from: bob});
        const {positionUnits: positionUnits2, positionTimestamp} = await openPosition(toTokenAmount(2000), bob);

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, positionUnits2, positionTimestamp);
    });

    it('claims correct amount after position was merged after claiming while opened', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await this.platform.setBuyersLockupPeriod(0, {from: admin});

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));
        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY);
        await claimAndValidate(bob, positionUnits, positionTimestamp);

        const {positionUnits: positionUnits2, positionTimestamp: positionTimestamp2} = await openPosition(toTokenAmount(2000), bob);
        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, positionUnits2, positionTimestamp2);

        const {positionUnits: positionUnits3, positionTimestamp: positionTimestamp3} = await openPosition(toTokenAmount(3000), bob);
        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, positionUnits3, positionTimestamp3);
    });

    it('claims correct amount after position was partially closed', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY);
        await this.platform.closePosition(positionUnits.div(new BN(2)), CVI_VALUE, {from: bob});

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, positionUnits.div(new BN(2)), positionTimestamp);
    });

    it('reverts when claiming too early', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too early');

        const openDay = positionTimestamp.div(new BN(SECONDS_PER_DAY));
        const secondsLeftInDay = SECONDS_PER_DAY * (openDay.toNumber() + 1) - (await time.latest()).toNumber();
        await time.increase(new BN(secondsLeftInDay - 2));

        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too early');
    });

    it('reverts when max claim time exceeded', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increaseTo(positionTimestamp.add(new BN(SECONDS_PER_DAY * 30 - 1)));
        await this.rewards.claimReward({from: bob});

        const {positionTimestamp: position2Timestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increaseTo(position2Timestamp.add(new BN(SECONDS_PER_DAY * 30 + 1)));
        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too late');
    });

    it('calculates max claim time of reward amount by latest merge time', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));
        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increaseTo(positionTimestamp.add(new BN(30 * SECONDS_PER_DAY + 1)));
        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too late');

        const {positionUnits: positionUnits2, positionTimestamp: positionTimestamp2} = await openPosition(toTokenAmount(2000), bob);

        await time.increaseTo(positionTimestamp2.add(new BN(SECONDS_PER_DAY * 30 - 2)));
        await claimAndValidate(bob, positionUnits.add(positionUnits2), positionTimestamp2);
    });

    it('calculates max claim time possible by latest merge time', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));
        const {positionUnits} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(30 * SECONDS_PER_DAY + 1);
        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too late');

        const {positionUnits: positionUnits2, positionTimestamp: positionTimestamp2} = await openPosition(toTokenAmount(2000), bob);

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, positionUnits.add(positionUnits2), positionTimestamp2);

        await time.increaseTo(positionTimestamp2.add(new BN(30 * SECONDS_PER_DAY + 1)));
        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too late');
    });

    it('claims correct amount when claiming', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toUSDT(4000000));

        const amounts = [10, 100, 500, 1000, 5000, 10000, 20000, 25000, 30000, 40000, 50000, 100000, 500000, 1000000];
        const MAX_REWARD_PERC = 10;
        for(const amount of amounts) {
            print(`Opening a position of size:${amount} USDT`);
            const {positionUnits, positionTimestamp} = await openPosition(toUSDT(amount), bob);

            await time.increase(SECONDS_PER_DAY);

            const claimed = await claimAndValidate(bob, positionUnits, positionTimestamp);
            const claimedTokens = claimed.div(new BN('1000000000000000000'));
            const maxExpectedReward = new BN(amount).mul(new BN(MAX_REWARD_PERC)).div(new BN(100));
            // console.log(`positionUnits:${positionUnits.toString()} maxExpected:${maxExpectedReward.toString()} claimed:${claimed.toString()} (${claimedTokens.toString()} GOVI)`);
            expect(claimedTokens).to.be.bignumber.below(new BN(amount).mul(new BN(MAX_REWARD_PERC)).div(new BN(100)));
            await this.platform.closePosition(positionUnits, new BN(CVI_VALUE), {from: bob});
            print(`${amount},${Number(claimedTokens.toString())}`);
        }
    });

    it('claims correct amount based on time passed from position open', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY * 1 + 60 * 60 * 4 + 60 * 15 + 30);

        await claimAndValidate(bob, positionUnits, positionTimestamp);
    });

    it('claims more if more time passes from position open', async () => {
        const times = [SECONDS_PER_DAY, 3 * SECONDS_PER_DAY / 2, 2 * SECONDS_PER_DAY, 5 * SECONDS_PER_DAY / 2];

        await transferRewardTokens(toTokenAmount(1000000));
        await setPlatform();
        await depositToPlatform(toTokenAmount(20000));

        let lastReward = new BN(0);

        for (let currTime of times) {
            const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
            await time.increase(currTime);
            const currReward = await claimAndValidate(bob, positionUnits, positionTimestamp);
            expect(currReward).is.bignumber.gte(lastReward);
            lastReward = currReward;
        }
    });

    it('claims max correct amount if max time passed from position open', async () => {
        await transferRewardTokens(toTokenAmount(1000000));
        await setPlatform();
        await depositToPlatform(toTokenAmount(20000));

        const times = [3 * SECONDS_PER_DAY, 10 * SECONDS_PER_DAY, 29 * SECONDS_PER_DAY];

        for (let currTime of times) {
            const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
            await time.increase(currTime);
            await claimAndValidate(bob, positionUnits, positionTimestamp);
        }
    });

    it('does not allow claiming twice', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, positionUnits, positionTimestamp);
        await expectRevert(this.rewards.claimReward({from: bob}), 'No reward');
    });

    it('does not allow claiming a position not opened by sender', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY);

        await expectRevert(this.rewards.claimReward({from: alice}), 'No opened position');
    });

    it('keeps track of caliming per account', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        const {positionUnits: bobPositionUnits, positionTimestamp: bobPositionTimetamp} = await openPosition(toTokenAmount(1000), bob);
        const {positionUnits: alicePositionUnits1} = await openPosition(toTokenAmount(2000), alice);

        await time.increase(SECONDS_PER_DAY);

        const {positionUnits: alicePositionUnits2, positionTimestamp: alicePositionTimestamp} = await openPosition(toTokenAmount(3000), alice);

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, bobPositionUnits, bobPositionTimetamp);
        await expectRevert(this.rewards.claimReward({from: bob}), 'No reward');

        await claimAndValidate(alice, alicePositionUnits1.add(alicePositionUnits2), alicePositionTimestamp);
        await expectRevert(this.rewards.claimReward({from: alice}), 'No reward');

        const {positionUnits: carolPositionUnits, positionTimestamp: carolPositionTimestamp} = await openPosition(toTokenAmount(3000), carol);
        const {positionUnits: bobPositionUnits2, positionTimestamp: bobPositionTimetamp2} = await openPosition(toTokenAmount(1500), bob);

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(carol, carolPositionUnits, carolPositionTimestamp);
        await expectRevert(this.rewards.claimReward({from: carol}), 'No reward');

        await claimAndValidate(bob, bobPositionUnits2, bobPositionTimetamp2);
        await expectRevert(this.rewards.claimReward({from: bob}), 'No reward');
    });

    it('allows stopping all rewards by setting daily max to zero', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        await rewardAndValidate(bob, toTokenAmount(1000));

        await this.rewards.setMaxDailyReward(0, {from: admin});

        await expectRevert(rewardAndValidate(bob, toTokenAmount(100)), 'Daily reward spent');
        await expectRevert(rewardAndValidate(alice, toTokenAmount(200)), 'Daily reward spent');
    });

    it('allows claiming a newly opened position after last claim', async() => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        const {positionUnits: bobPositionUnits, positionTimestamp: bobPositionTimetamp} = await openPosition(toTokenAmount(1000), bob);
        await time.increase(SECONDS_PER_DAY);
        await claimAndValidate(bob, bobPositionUnits, bobPositionTimetamp);

        const {positionUnits: bobPositionUnits2, positionTimestamp: bobPositionTimetamp2} = await openPosition(toTokenAmount(500), bob);
        await time.increase(SECONDS_PER_DAY);
        await claimAndValidate(bob, bobPositionUnits2, bobPositionTimetamp2);
    });

    it('reverts when not called by allowed caller', async () => {
        const accounts = [alice, carol, bob];

        for (let account of accounts) {
            await expectRevert(this.rewards.setRewarder(bob, {from: account}), 'Ownable: caller is not the owner');
            await expectRevert(this.rewards.setPlatform(this.platform.address, {from: account}), 'Ownable: caller is not the owner');
            await expectRevert(this.rewards.setMaxDailyReward(DAILY_REWARD, {from: account}), 'Ownable: caller is not the owner');
            await expectRevert(this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {from: account}), 'Ownable: caller is not the owner');
            await expectRevert(this.rewards.setMaxClaimPeriod(new BN(SECONDS_PER_DAY * 30), {from: account}), 'Ownable: caller is not the owner');
            await expectRevert(this.rewards.setMaxRewardTime(MAX_REWARD_TIME, {from: account}), 'Ownable: caller is not the owner');
            await expectRevert(this.rewards.setMaxRewardTimePercentageGain(MAX_TIME_PERCENTAGE_GAIN, {from: account}), 'Ownable: caller is not the owner');
        }
    });

    it('sets max time percentage gain properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        const gains = [toBN(40, 8), toBN(10, 8), new BN(0)];

        for (let gain of gains) {
            await this.rewards.setMaxRewardTimePercentageGain(gain, {from: admin});
            expect(await this.rewards.maxRewardTimePercentageGain()).to.be.bignumber.equal(gain);
            await rewardAndValidate(bob, toUSDT(100), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, MAX_SINGLE_REWARD, MAX_REWARD_TIME, gain);
            await rewardAndValidate(bob, toUSDT(30000), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, MAX_SINGLE_REWARD, MAX_REWARD_TIME, gain);
        }
    });

    const verifyRewardCalculationParameters = async (c, x0, y0, lastC, lastX0, lastY0) => {
        expect(await this.rewards.maxSingleReward()).to.be.bignumber.equal(c);
        expect(await this.rewards.rewardMaxLinearPositionUnits()).to.be.bignumber.equal(x0);
        expect(await this.rewards.rewardMaxLinearGOVI()).to.be.bignumber.equal(y0);
        expect(await this.rewards.lastMaxSingleReward()).to.be.bignumber.equal(lastC);
        expect(await this.rewards.lastRewardMaxLinearPositionUnits()).to.be.bignumber.equal(lastX0);
        expect(await this.rewards.lastRewardMaxLinearGOVI()).to.be.bignumber.equal(lastY0);
    };

    it('sets reward calculation parameters with max claim time delay properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {from: admin});

        await verifyRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI,
            MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI);

        expect(await this.rewards.rewardCalculationValidTimestamp()).to.be.bignumber.equal((await time.latest()).add(new BN(SECONDS_PER_DAY * 30)));

        await depositToPlatform(toTokenAmount(10000));

        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)), {from: admin});

        await verifyRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)),
            MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI);

        expect(await this.rewards.rewardCalculationValidTimestamp()).to.be.bignumber.equal((await time.latest()).add(new BN(SECONDS_PER_DAY * 30)));

        let setParametersTimestamp = await time.latest();

        const {positionUnits: bobPositionUnits, positionTimestamp: bobPositionTimestamp} = await openPosition(toTokenAmount(10), bob);

        await time.increase(SECONDS_PER_DAY);

        const {positionUnits: alicePositionUnits, positionTimestamp: alicePositionTimestamp} = await openPosition(toTokenAmount(20), alice);

        await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 - 1)));
        await claimAndValidate(bob, bobPositionUnits, bobPositionTimestamp);

        await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 + 1)));
        await claimAndValidate(alice, alicePositionUnits, alicePositionTimestamp, MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)));

        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD.div(new BN(2)), MAX_LINEAR_POSITION_UNITS.mul(new BN(2)), MAX_LINEAR_GOVI.mul(new BN(2)), {from: admin});

        await verifyRewardCalculationParameters(MAX_SINGLE_REWARD.div(new BN(2)), MAX_LINEAR_POSITION_UNITS.mul(new BN(2)), MAX_LINEAR_GOVI.mul(new BN(2)),
            MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)));

        expect(await this.rewards.rewardCalculationValidTimestamp()).to.be.bignumber.equal((await time.latest()).add(new BN(SECONDS_PER_DAY * 30)));

        setParametersTimestamp = await time.latest();

        await time.increase(SECONDS_PER_DAY);
        const {positionUnits: bobPositionUnits2, positionTimestamp: bobPositionTimestamp2} = await openPosition(toTokenAmount(10), bob);

        await time.increase(SECONDS_PER_DAY);
        const {positionUnits: carolPositionUnits, positionTimestamp: carolPositionTimestamp} = await openPosition(toTokenAmount(30), carol);

        await time.increase(SECONDS_PER_DAY);
        const {positionUnits: davePositionUnits, positionTimestamp: davePositionTimestamp} = await openPosition(toTokenAmount(50), dave);

        await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 - 1)));
        await claimAndValidate(bob, bobPositionUnits2, bobPositionTimestamp2, MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)));

        await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 + 1)));
        await claimAndValidate(carol, carolPositionUnits, carolPositionTimestamp, MAX_LINEAR_POSITION_UNITS.mul(new BN(2)), MAX_LINEAR_GOVI.mul(new BN(2)), MAX_SINGLE_REWARD.div(new BN(2)));

        await claimAndValidate(dave, davePositionUnits, davePositionTimestamp, MAX_LINEAR_POSITION_UNITS.mul(new BN(2)), MAX_LINEAR_GOVI.mul(new BN(2)), MAX_SINGLE_REWARD.div(new BN(2)));
    });

    it('allows changing rewards coeffcients immediately', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));

        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD.mul(new BN(2)), MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)), {from: admin});
        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD.mul(new BN(2)), MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)), {from: admin});

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(10), bob);
        await time.increase(SECONDS_PER_DAY);
        await claimAndValidate(bob, positionUnits, positionTimestamp, MAX_LINEAR_POSITION_UNITS.div(new BN(2)), MAX_LINEAR_GOVI.div(new BN(2)), MAX_SINGLE_REWARD.mul(new BN(2)));
    });

    it('reverts when claiming no reward', async() => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await this.platform.setRewards(ZERO_ADDRESS, {from: admin});

        await depositToPlatform(toTokenAmount(20000));
        await openPosition(toTokenAmount(1000), bob);
        await openPosition(toTokenAmount(1000), alice);
        await openPosition(toTokenAmount(1000), admin);

        await time.increase(SECONDS_PER_DAY);

        await expectRevert(this.rewards.claimReward({from: bob}), 'No reward');
        await expectRevert(this.rewards.claimReward({from: alice}), 'No reward');
        await expectRevert(this.rewards.claimReward({from: admin}), 'No reward');

        await this.platform.setRewards(this.rewards.address, {from: admin});
        await openPosition(toTokenAmount(1000), bob);

        await time.increase(SECONDS_PER_DAY);

        await this.rewards.claimReward({from: bob});
        await expectRevert(this.rewards.claimReward({from: alice}), 'No reward');
        await expectRevert(this.rewards.claimReward({from: admin}), 'No reward');
    });

    it('reverts when claiming and max daily rewards was depleted', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
        await time.increase(SECONDS_PER_DAY);
        const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp);

        await time.increase(SECONDS_PER_DAY);
        await this.rewards.setMaxDailyReward(bobReward, {from: admin});

        await openPosition(toTokenAmount(2000), alice);
        await time.increase(SECONDS_PER_DAY);
        await expectRevert(this.rewards.claimReward({from: alice}), 'Daily reward spent');
    });

    it('reverts when claiming and max daily rewards is reached with current claim', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
        const {positionUnits: alicePositionUnits} = await openPosition(toTokenAmount(2000), alice);
        await time.increase(SECONDS_PER_DAY);
        const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp);
        const aliceReward = calculateReward(alicePositionUnits, new BN(SECONDS_PER_DAY));

        await this.rewards.setMaxDailyReward(bobReward.add(aliceReward.div(new BN(2))), {from: admin});

        await expectRevert(this.rewards.claimReward({from: alice}), 'Daily reward spent');
    });

    it('resets total rewards claimed when day passes', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
        const {positionUnits: alicePositionUnits, positionTimestamp: alicePositionTimestamp} = await openPosition(toTokenAmount(10), alice);
        await time.increase(SECONDS_PER_DAY);
        const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp);
        await this.rewards.setMaxDailyReward(bobReward, {from: admin});

        let today = (await time.latest()).div(new BN(SECONDS_PER_DAY));
        expect(await this.rewards.todayClaimedRewards()).to.be.bignumber.equal(bobReward);
        expect(await this.rewards.lastClaimedDay()).to.be.bignumber.equal(today);

        await expectRevert(this.rewards.claimReward({from: alice}), 'Daily reward spent');

        const secondsLeftInDay = SECONDS_PER_DAY * (today.toNumber() + 1) - (await time.latest()).toNumber();
        await time.increase(secondsLeftInDay);

        const aliceReward = await claimAndValidate(alice, alicePositionUnits, alicePositionTimestamp);
        today = (await time.latest()).div(new BN(SECONDS_PER_DAY));
        expect(await this.rewards.todayClaimedRewards()).to.be.bignumber.equal(aliceReward);
        expect(await this.rewards.lastClaimedDay()).to.be.bignumber.equal(today);

        await expectRevert(this.rewards.claimReward({from: alice}), 'No reward');
    });

    it('reverts when not enough CVI tokens are left for current claim', async () => {
        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionUnits} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(MAX_REWARD_TIME);
        const reward = calculateReward(positionUnits, MAX_REWARD_TIME);

        await transferRewardTokens(reward.sub(new BN(1)));
        await expectRevert(this.rewards.claimReward({from: bob}), 'ERC20: transfer amount exceeds balance');
    });

    it('reverts when no CVI tokens are left for current claim', async () => {
        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increase(MAX_REWARD_TIME);
        const reward = calculateReward(positionUnits, MAX_REWARD_TIME);

        await transferRewardTokens(reward);

        await claimAndValidate(bob, positionUnits, positionTimestamp);

        await openPosition(toTokenAmount(1000), alice);
        await time.increase(SECONDS_PER_DAY);
        await expectRevert(this.rewards.claimReward({from: alice}), 'ERC20: transfer amount exceeds balance');
    });

    it('allows setting rewarder properly', async () => {
        await this.rewards.setRewarder(alice, {from: admin});
        expect(await this.rewards.rewarder()).to.equal(alice);
        await expectRevert(this.rewards.reward(carol, toTokenAmount(1000), {from: bob}), 'Not allowed');
        await this.rewards.reward(carol, toTokenAmount(1000), {from: alice});
    });

    it('allows setting daily max reward properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
        await openPosition(toTokenAmount(1000), alice);
        await time.increase(SECONDS_PER_DAY);
        const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp);

        await this.rewards.setMaxDailyReward(bobReward, {from: admin});
        expect(await this.rewards.maxDailyReward()).to.be.bignumber.equal(bobReward);

        await expectRevert(this.rewards.claimReward({from: alice}), 'Daily reward spent');
    });

    it('allows setting max single reward properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        await rewardAndValidate(bob, toTokenAmount(1000), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, MAX_SINGLE_REWARD);
        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD.div(new BN(2)), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {from: admin});
        await time.increase(30 * SECONDS_PER_DAY);
        expect(await this.rewards.maxSingleReward()).to.be.bignumber.equal(MAX_SINGLE_REWARD.div(new BN(2)));
        await rewardAndValidate(alice, toTokenAmount(1000), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, MAX_SINGLE_REWARD.div(new BN(2)));
    });

    it('allows setting max claim period properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));
        const {positionTimestamp} = await openPosition(toTokenAmount(1000), bob);

        await this.rewards.setMaxClaimPeriod(SECONDS_PER_DAY * 3, {from: admin});
        expect(await this.rewards.maxClaimPeriod()).to.be.bignumber.equal(new BN(SECONDS_PER_DAY * 3));

        await time.increaseTo(positionTimestamp.add(new BN(SECONDS_PER_DAY * 3 - 1)));
        await this.rewards.claimReward({from: bob});

        const {positionTimestamp: position2Timestamp} = await openPosition(toTokenAmount(1000), bob);

        await time.increaseTo(position2Timestamp.add(new BN(SECONDS_PER_DAY * 3 + 1)));
        await expectRevert(this.rewards.claimReward({from: bob}), 'Claim too late');
    });

    it('reverts when max reward time properly is set to zero', async () => {
        await expectRevert(this.rewards.setMaxRewardTime(0, {from: admin}), 'Max reward time not positive');
    });

    it('allows setting max reward time properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(10000));

        const maxRewardTime = new BN(SECONDS_PER_DAY * 4);
        await this.rewards.setMaxRewardTime(maxRewardTime, {from: admin});
        expect(await this.rewards.maxRewardTime()).to.be.bignumber.equal(maxRewardTime);

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
        await time.increase(SECONDS_PER_DAY);
        await claimAndValidate(bob, positionUnits, positionTimestamp, undefined, undefined, undefined, maxRewardTime);
    });

    it('allows setting the platform properly', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        const fakePlatform = await FakePlatform.new(toTokenAmount(1000), bob);

        await this.rewards.setPlatform(fakePlatform.address, {from: admin});
        const positionTimestamp = await time.latest();

        expect(await this.rewards.platform()).to.equal(fakePlatform.address);

        await this.rewards.setRewarder(admin, {from: admin});
        await this.rewards.reward(bob, toTokenAmount(2000), {from: admin});

        await time.increase(SECONDS_PER_DAY);

        await claimAndValidate(bob, toTokenAmount(1000), positionTimestamp);
    });

    it('allows stopping all rewards by setting daily max to zero', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        await rewardAndValidate(bob, toTokenAmount(1000));

        await this.rewards.setMaxDailyReward(0, {from: admin});

        await expectRevert(rewardAndValidate(bob, toTokenAmount(100)), 'Daily reward spent');
        await expectRevert(rewardAndValidate(alice, toTokenAmount(200)), 'Daily reward spent');
    });

    it('allows unclaimable rewards to become claimable by increasing max daily reward', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        await setPlatform();
        await depositToPlatform(toTokenAmount(50000));

        const {positionUnits, positionTimestamp} = await openPosition(toTokenAmount(1000), bob);
        const {positionUnits: alicePositionUnits, positionTimestamp: alicePositionTimestamp} = await openPosition(toTokenAmount(2000), alice);
        const {positionUnits: carolPositionUnits, positionTimestamp: carolPositionTimestamp} = await openPosition(toTokenAmount(3000), carol);

        await time.increaseTo(carolPositionTimestamp.add(new BN(3 * SECONDS_PER_DAY)));

        const bobReward = calculateReward(positionUnits, MAX_REWARD_TIME);
        const aliceReward = calculateReward(alicePositionUnits, MAX_REWARD_TIME);
        const carolReward = calculateReward(carolPositionUnits, MAX_REWARD_TIME);

        await this.rewards.setMaxDailyReward(bobReward.add(aliceReward), {from: admin});

        await claimAndValidate(bob, positionUnits, positionTimestamp);
        await claimAndValidate(alice, alicePositionUnits, alicePositionTimestamp);

        await expectRevert(this.rewards.claimReward({from: carol}), 'Daily reward spent');
        await this.rewards.setMaxDailyReward(bobReward.add(aliceReward).add(carolReward), {from: admin});

        await claimAndValidate(carol, carolPositionUnits, carolPositionTimestamp);
    });

    it('rewards less than max single reward even for a very high amount of position units', async () => {
        await transferRewardTokens(toTokenAmount(1000000));

        const fakePlatform = await FakePlatform.new(toBN(1, 35), bob);
        const positionTimestamp = await time.latest();
        await this.rewards.setPlatform(fakePlatform.address, {from: admin});

        await this.rewards.setRewarder(admin, {from: admin});
        await this.rewards.reward(bob, toBN(1, 35), {from: admin});

        await time.increase(SECONDS_PER_DAY);

        const reward = await claimAndValidate(bob, toBN(1, 35), positionTimestamp);
        expect(reward).to.be.bignumber.lte(MAX_SINGLE_REWARD);
    });

    it('helper returns correct rewards', async () => {
        const positionUnits = toTokenAmount(1000);

        const openTimestamp = await time.latest();
        await time.increase(SECONDS_PER_DAY);
        const reward = await this.positionRewardsHelper.calculatePositionReward(positionUnits, openTimestamp);
        const rewardTimestamp = await time.latest();

        const expectedReward = calculateReward(positionUnits, rewardTimestamp.sub(openTimestamp));

        expect(reward).to.be.bignumber.equal(expectedReward);
    });

    it('helper returns minimum after raising rewards', async () => {
        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD.mul(new BN(2)), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {from: admin});

        const positionUnits = toTokenAmount(1000);

        const openTimestamp = await time.latest();
        await time.increase(SECONDS_PER_DAY);
        const reward = await this.positionRewardsHelper.calculatePositionReward(positionUnits, openTimestamp);
        const rewardTimestamp = await time.latest();

        const expectedReward = calculateReward(positionUnits, rewardTimestamp.sub(openTimestamp));

        expect(reward).to.be.bignumber.equal(expectedReward);
    });

    it('helper returns minimum after lowering rewards', async () => {
        await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD.div(new BN(2)), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {from: admin});

        const positionUnits = toTokenAmount(1000);

        const openTimestamp = await time.latest();
        await time.increase(SECONDS_PER_DAY);
        const reward = await this.positionRewardsHelper.calculatePositionReward(positionUnits, openTimestamp);
        const rewardTimestamp = await time.latest();

        const expectedReward = calculateReward(positionUnits, rewardTimestamp.sub(openTimestamp), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, MAX_SINGLE_REWARD.div(new BN(2)));

        expect(reward).to.be.bignumber.equal(expectedReward);
    });
});
