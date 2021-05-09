const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');

const {toTokenAmount} = require('./utils/BNUtils.js');

const Rewards = contract.fromArtifact('Rewards');
const FakeERC20 = contract.fromArtifact('FakeERC20');

const expect = chai.expect;
const [admin, rewarder, bob, alice, carol] = accounts;

const DAILY_REWARD = toTokenAmount(165000);

const SECONDS_PER_DAY = new BN(24 * 60 * 60);

const toDay = timeBN => {
    return timeBN.div(new BN(SECONDS_PER_DAY));
};

const getToday = async () => {
    const latestTime = await time.latest();
    return toDay(latestTime);
};

const rewardAndValidate = async (account, reward) => {
    const today = await getToday();
    const oldAccountReward = await this.rewards.dailyPerAddressReward(account, today);
    const oldDailyReward = await this.rewards.totalRewardsPerDay(today);

    await this.rewards.reward(account, reward, {from: rewarder});

    const newAccountReward = await this.rewards.dailyPerAddressReward(account, today);
    expect(newAccountReward).to.be.bignumber.equal(oldAccountReward.add(reward));

    const newDailyReward = await this.rewards.totalRewardsPerDay(today);
    expect(newDailyReward).to.be.bignumber.equal(oldDailyReward.add(reward));

    return reward;
};

const transferRewardTokens = async amount => {
    await this.cviToken.transfer(this.rewards.address, amount, {from: admin});
};

describe.skip('Rewards', () => {
    beforeEach(async () => {
        this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(10000000), 18, {from: admin});
        this.rewards = await Rewards.new(this.cviToken.address, {from: admin});
        this.rewards.setRewarder(rewarder, {from: admin});
    });

    it('reverts when rewarding zero position units', async() => {
        await expectRevert(this.rewards.reward(bob, new BN(0), {from: rewarder}), 'Position units must be positive');
    });

    it('updates storage correctly when rewarding', async() => {
        const firstDay = await getToday();
        const bobReward = await rewardAndValidate(bob, toTokenAmount(1000));
        const aliceReward = await rewardAndValidate(alice, toTokenAmount(2000));
        const aliceSecondReward = await rewardAndValidate(alice, toTokenAmount(3000));

        await time.increase(SECONDS_PER_DAY);

        const secondDay = await getToday();
        const bobNextDayReward = await rewardAndValidate(bob, toTokenAmount(4000));
        const aliceNextDayReward = await rewardAndValidate(bob, toTokenAmount(5000));

        expect(await this.rewards.totalRewardsPerDay(firstDay)).to.be.bignumber.equal(bobReward.add(aliceReward).add(aliceSecondReward));
        expect(await this.rewards.totalRewardsPerDay(secondDay)).to.be.bignumber.equal(bobNextDayReward.add(aliceNextDayReward));
    });

    it('rewards correct amount when claiming', async() => {
        await transferRewardTokens(toTokenAmount(1000000));

        const rewardDay = await getToday();
        await rewardAndValidate(bob, toTokenAmount(1000));
        await time.increase(SECONDS_PER_DAY);

        let bobTokens = new BN(0);
        let aliceTokens = new BN(0);
        let carolTokens = new BN(0);

        await this.rewards.claimReward([rewardDay], {from: bob});
        bobTokens = bobTokens.add(DAILY_REWARD);
        expect(await this.cviToken.balanceOf(bob)).to.be.bignumber.equal(bobTokens);

        const secondRewardDay = await getToday();
        await rewardAndValidate(bob, toTokenAmount(1000));
        await rewardAndValidate(alice, toTokenAmount(1000));
        await time.increase(SECONDS_PER_DAY);

        await this.rewards.claimReward([secondRewardDay], {from: bob});
        bobTokens = bobTokens.add(DAILY_REWARD.div(new BN(2)));
        expect(await this.cviToken.balanceOf(bob)).to.be.bignumber.equal(bobTokens);
        expect(await this.cviToken.balanceOf(alice)).to.be.bignumber.equal(aliceTokens);

        await this.rewards.claimReward([secondRewardDay], {from: alice});
        aliceTokens = aliceTokens.add(DAILY_REWARD.div(new BN(2)));
        expect(await this.cviToken.balanceOf(alice)).to.be.bignumber.equal(aliceTokens);

        const thirdRewardDay = await getToday();
        await rewardAndValidate(bob, toTokenAmount(1000));
        await rewardAndValidate(alice, toTokenAmount(2000));
        await rewardAndValidate(carol, toTokenAmount(3000));
        await time.increase(SECONDS_PER_DAY);

        await this.rewards.claimReward([thirdRewardDay], {from: bob});
        await this.rewards.claimReward([thirdRewardDay], {from: alice});
        await this.rewards.claimReward([thirdRewardDay], {from: carol});

        bobTokens = bobTokens.add(DAILY_REWARD.div(new BN(6)));
        aliceTokens = aliceTokens.add(DAILY_REWARD.div(new BN(3)));
        carolTokens = carolTokens.add(DAILY_REWARD.div(new BN(2)));

        expect(await this.cviToken.balanceOf(bob)).to.be.bignumber.equal(bobTokens);
        expect(await this.cviToken.balanceOf(alice)).to.be.bignumber.equal(aliceTokens);
        expect(await this.cviToken.balanceOf(carol)).to.be.bignumber.equal(carolTokens);
    });

    it('flushes reward after claiming reward', async() => {
        await transferRewardTokens(toTokenAmount(1000000));

        const rewardDay = await getToday();
        await rewardAndValidate(bob, toTokenAmount(1000));
        await time.increase(SECONDS_PER_DAY);

        const preRewardTokens = await this.cviToken.balanceOf(bob);
        expect(preRewardTokens).to.be.bignumber.equal(new BN(0));
        await this.rewards.claimReward([rewardDay], {from: bob});
        const postRewardTokens = await this.cviToken.balanceOf(bob);
        expect(postRewardTokens).to.be.bignumber.above(new BN(0));

        await expectRevert(this.rewards.claimReward([rewardDay], {from: bob}), 'No reward');
    });

    it('reverts when claiming reward for today', async() => {
        await transferRewardTokens(toTokenAmount(1000000));

        const rewardDay = await getToday();

        await rewardAndValidate(bob, toTokenAmount(1000));

        await expectRevert(this.rewards.claimReward([rewardDay], {from: bob}), 'Open day is today or future');
        const secondsLeftInDay = SECONDS_PER_DAY * (rewardDay.toNumber() + 1) - (await time.latest()).toNumber();
        await time.increase(new BN(secondsLeftInDay - 1));
        await expectRevert(this.rewards.claimReward([rewardDay], {from: bob}), 'Open day is today or future');
        await time.increase(new BN(1));

        await this.rewards.claimReward([rewardDay], {from: bob});
    });

    it('reverts when claiming reward for future', async() => {
        const rewardDay = await getToday();
        await expectRevert(this.rewards.claimReward([rewardDay.add(new BN(1))], {from: bob}), 'Open day is today or future');
        await expectRevert(this.rewards.claimReward([rewardDay.add(new BN(1000))], {from: bob}), 'Open day is today or future');
    });

    it('reverts when claiming no reward', async() => {
        const yesterday = (await getToday()).sub(new BN(1));
        await expectRevert(this.rewards.claimReward([yesterday], {from: bob}), 'No reward');
        await expectRevert(this.rewards.claimReward([yesterday], {from: alice}), 'No reward');
        await expectRevert(this.rewards.claimReward([yesterday], {from: admin}), 'No reward');

        const today = (await getToday());
        await rewardAndValidate(bob, toTokenAmount(1000));

        await time.increase(SECONDS_PER_DAY);
        await expectRevert(this.rewards.claimReward([today], {from: alice}), 'No reward');
        await expectRevert(this.rewards.claimReward([today], {from: admin}), 'No reward');
    });

    it('reverts when not called by allowed caller', async() => {
        await expectRevert(this.rewards.reward(admin, toTokenAmount(1000), {from: bob}), 'Not allowed');
        await expectRevert(this.rewards.reward(admin, toTokenAmount(1000), {from: alice}), 'Not allowed');
        await expectRevert(this.rewards.reward(admin, toTokenAmount(1000), {from: admin}), 'Not allowed');

        this.rewards.reward(bob, toTokenAmount(1000), {from: rewarder});
        this.rewards.reward(alice, toTokenAmount(1000), {from: rewarder});
        this.rewards.reward(admin, toTokenAmount(1000), {from: rewarder});
    });

    it('reverts when out of CVI tokens to reward', async() => {
        await transferRewardTokens(DAILY_REWARD);

        const rewardDay = await getToday();
        await rewardAndValidate(bob, toTokenAmount(1000));
        await time.increase(SECONDS_PER_DAY);
        await this.rewards.claimReward([rewardDay], {from: bob});

        const secondRewardDay = await getToday();
        await rewardAndValidate(alice, toTokenAmount(1000));
        await rewardAndValidate(bob, toTokenAmount(1000));
        await rewardAndValidate(carol, toTokenAmount(1000));

        await time.increase(SECONDS_PER_DAY);
        await expectRevert(this.rewards.claimReward([secondRewardDay], {from: bob}), 'ERC20: transfer amount exceeds balance');
        await expectRevert(this.rewards.claimReward([secondRewardDay], {from: alice}), 'ERC20: transfer amount exceeds balance');
        await expectRevert(this.rewards.claimReward([secondRewardDay], {from: carol}), 'ERC20: transfer amount exceeds balance');
    });
});
