const {expectRevert, time, BN, balance, send} = require('@openzeppelin/test-helpers');
const {accounts, contract, web3} = require('@openzeppelin/test-environment');
const chai = require('chai');

const {toTokenAmount, toBN} = require('./utils/BNUtils.js');

const Staking = contract.fromArtifact('Staking');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakeWETH = contract.fromArtifact('FakeWETH');
const FakeExchange = contract.fromArtifact('FakeExchange');
const ETHStakingProxy = contract.fromArtifact('ETHStakingProxy');

const expect = chai.expect;
const [admin, bob, alice, carol] = accounts;

const TO_WETH_RATE = toBN(1, 9);
const PRECISION_DECIMALS = toBN(1, 18);

const GAS_PRICE = toBN(1, 10);

const sendProfitAndValidate = async (token, account, amount, recipient, isProfit) => {
    const beforeProfit = await this.staking.totalProfits(token.address);
    const stakes = await this.staking.totalStaked();

    const beforeSenderBalance = await token.balanceOf(account);
    const beforeRecipientBalane = await token.balanceOf(recipient);
    await token.approve(this.staking.address, amount, {from: account});
    await this.staking.sendProfit(amount, token.address, {from: account});
    const afterSenderBalance = await token.balanceOf(account);
    const afterRecipientBalance = await token.balanceOf(recipient);

    expect(afterRecipientBalance.sub(beforeRecipientBalane)).to.be.bignumber.equal(amount);
    expect(beforeSenderBalance.sub(afterSenderBalance)).to.be.bignumber.equal(amount);

    const afterProfit = await this.staking.totalProfits(token.address);

    let profitAdded = new BN(0);

    if (isProfit) {
        profitAdded = amount.mul(PRECISION_DECIMALS).div(stakes);
    }

    expect(afterProfit.sub(beforeProfit)).to.be.bignumber.equal(profitAdded);

    return profitAdded;
};

const stakeAndValidate = async (account, amount) => {
    const stakesBefore = await this.staking.stakes(account);
    const totalStakesBefore = await this.staking.totalStaked();
    const cviStakingBefore = await this.cviToken.balanceOf(this.staking.address);
    const cviBefore = await this.cviToken.balanceOf(account);

    await this.cviToken.approve(this.staking.address, amount, {from: account});
    await this.staking.stake(amount, {from: account});
    const stakeTimestamp = await time.latest();

    const stakesAfter = await this.staking.stakes(account);
    const totalStakesAfter = await this.staking.totalStaked();
    const cviStakingAfter = await this.cviToken.balanceOf(this.staking.address);
    const cviAfter = await this.cviToken.balanceOf(account);
    expect(await this.staking.stakeTimestamps(account)).to.be.bignumber.equal(stakeTimestamp);

    expect(cviBefore.sub(cviAfter)).to.be.bignumber.equal(amount);
    expect(cviStakingAfter.sub(cviStakingBefore)).to.be.bignumber.equal(amount);
    expect(stakesAfter.sub(stakesBefore)).to.be.bignumber.equal(amount);
    expect(totalStakesAfter.sub(totalStakesBefore)).to.be.bignumber.equal(amount);

    return stakeTimestamp;
};

const unstakeAndValidate = async (account, amount) => {
    const stakesBefore = await this.staking.stakes(account);
    const totalStakesBefore = await this.staking.totalStaked();
    const cviStakingBefore = await this.cviToken.balanceOf(this.staking.address);
    const cviBefore = await this.cviToken.balanceOf(account);

    await this.staking.unstake(new BN(amount), {from: account});

    const stakesAfter = await this.staking.stakes(account);
    const totalStakesAfter = await this.staking.totalStaked();
    const cviStakingAfter = await this.cviToken.balanceOf(this.staking.address);
    const cviAfter = await this.cviToken.balanceOf(account);

    expect(cviAfter.sub(cviBefore)).to.be.bignumber.equal(amount);
    expect(cviStakingBefore.sub(cviStakingAfter)).to.be.bignumber.equal(amount);
    expect(stakesBefore.sub(stakesAfter)).to.be.bignumber.equal(amount);
    expect(totalStakesBefore.sub(totalStakesAfter)).to.be.bignumber.equal(amount);
};

const claimAndValidate = async (account, tokens, expectedProfit) => {
    const tokensBefore = [];
    for (let token of tokens) {
        tokensBefore.push(await token.balanceOf(account));
    }

    const ethBefore = await balance.current(account, 'wei');

    let profits = [];
    let tx;
    if (tokens.length === 1) {
        const profit = await this.staking.claimProfit.call(tokens[0].address, {from: account});
        tx = await this.staking.claimProfit(tokens[0].address, {from: account, gasPrice: GAS_PRICE});
        profits.push(profit);
    } else {
        profits = await this.staking.claimAllProfits.call({from: account});
        tx = await this.staking.claimAllProfits({from: account, gasPrice: GAS_PRICE});
    }

    let index = 0;
    for (let token of tokens) {
        if ((await token.name()) === 'WETH') {
            const ethAfter = await balance.current(account, 'wei');
            expect(ethAfter.sub(ethBefore)).to.be.bignumber.equal(expectedProfit.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
        } else {
            const tokenAfter = await token.balanceOf(account);
            expect(tokenAfter.sub(tokensBefore[index])).to.be.bignumber.equal(expectedProfit);
        }
        index++;
    }

    expect(profits.length).to.equal(tokens.length);

    for (let profit of profits) {
        expect(profit).to.be.bignumber.equal(expectedProfit);
    }
};

const calculateProfit = (stakeTimeProfitsPerAmount, unstakeTimeProfitsPerAmount, amount) => {
    return unstakeTimeProfitsPerAmount.sub(stakeTimeProfitsPerAmount).mul(amount).div(PRECISION_DECIMALS);
};

const testAddAndRemoveTokens = async (addToken, removeToken, getTokens) => {
    expect(await getTokens()).to.eql([]);

    await addToken(this.wethToken);
    expect(await getTokens()).to.eql([this.wethToken.address]);

    await addToken(this.daiToken);
    expect(await getTokens()).to.eql([this.wethToken.address, this.daiToken.address]);

    await removeToken(this.wethToken);
    expect(await getTokens()).to.eql([this.daiToken.address]);

    await removeToken(this.daiToken);
    expect(await getTokens()).to.eql([]);
};

describe('Staking', () => {
    beforeEach(async () => {
        this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(1000000000), 18, {from: admin});
        this.wethToken = await FakeWETH.new('WETH', 'WETH', toTokenAmount(1000000000000000), 18, {from: admin});
        this.cotiToken = await FakeERC20.new('COTI', 'COTI', toTokenAmount(1000000000), 18, {from: admin});
        this.daiToken = await FakeERC20.new('DAI', 'DAI', toTokenAmount(1000000000), 18, {from: admin});
        this.usdtToken = await FakeERC20.new('USDT', 'USDT', toTokenAmount(1000000000), 18, {from: admin});
        this.fakeExchange = await FakeExchange.new(this.wethToken.address, TO_WETH_RATE, {from: admin});
        this.wethToken.transfer(this.fakeExchange.address, toTokenAmount(1000000000), {from: admin});
        this.staking = await Staking.new(this.cviToken.address, this.fakeExchange.address, {from: admin});
        this.stakingProxy = await ETHStakingProxy.new(this.wethToken.address, this.staking.address, {from: admin});
    });

    it('exposes correct precision decimals', async() => {
        expect(await this.staking.PRECISION_DECIMALS()).to.be.bignumber.equal(PRECISION_DECIMALS);
    });

    it('reverts when staking zero amount', async() => {
        await expectRevert(this.staking.stake(new BN(0), {from: bob}), 'Amount must be positive');
    });

    it('stakes properly when no claimable tokens', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await this.cviToken.transfer(alice, toTokenAmount(2000), {from: admin});
        await this.cviToken.transfer(carol, toTokenAmount(3000), {from: admin});

        await stakeAndValidate(bob, toTokenAmount(1000));
        await stakeAndValidate(alice, toTokenAmount(2000));
        await stakeAndValidate(carol, toTokenAmount(3000));
    });

    it('accepts profit for claimable or other token only', async () => {
        await this.wethToken.approve(this.staking.address, toTokenAmount(10000), {from: admin});
        await this.daiToken.approve(this.staking.address, toTokenAmount(10000), {from: admin});
        await this.cviToken.approve(this.staking.address, toTokenAmount(10000), {from: admin});

        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin}), 'Token not supported');
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin}), 'Token not supported');
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.cviToken.address, {from: admin}), 'Token not supported');

        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin}), 'Token not supported');
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.cviToken.address, {from: admin}), 'Token not supported');

        await this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin});

        await this.staking.addClaimableToken(this.daiToken.address, {from: admin});

        await this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin});
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.cviToken.address, {from: admin}), 'Token not supported');

        await this.staking.removeClaimableToken(this.daiToken.address, {from: admin});

        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin}), 'Token not supported');
        await this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin});

        await this.staking.removeClaimableToken(this.wethToken.address, {from: admin});
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin}), 'Token not supported');

        await this.staking.addToken(this.wethToken.address, {from: admin});

        await this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin});
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin}), 'Token not supported');
        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.cviToken.address, {from: admin}), 'Token not supported');

        await this.staking.removeToken(this.wethToken.address, {from: admin});
        await this.staking.addToken(this.daiToken.address, {from: admin});

        await expectRevert(this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin}), 'Token not supported');
        await this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin});

        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        await this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin});
        await this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, {from: admin});
    });

    it('sends profit to fallback recipient if no stakes', async () => {
        await this.wethToken.transfer(bob, toTokenAmount(2000), {from: admin});
        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        await sendProfitAndValidate(this.wethToken, bob, toTokenAmount(2000), admin, false);
    });

    it('handles adding profit properly for claimable token', async () => {
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        await stakeAndValidate(bob, toTokenAmount(1000));

        await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true);
    });

    it('transfers tokens to contract only for other token', async () => {
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await this.staking.addToken(this.daiToken.address, {from: admin});

        await stakeAndValidate(bob, toTokenAmount(1000));

        await sendProfitAndValidate(this.daiToken, admin, toTokenAmount(2000), this.staking.address, false);
    });

    it('saves last profits for each and only claimable token on staking', async () => {
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await this.cviToken.transfer(alice, toTokenAmount(1000), {from: admin});

        await this.staking.addClaimableToken(this.daiToken.address, {from: admin});
        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});
        await this.staking.addClaimableToken(this.cotiToken.address, {from: admin});

        await this.staking.addToken(this.usdtToken.address, {from: admin});

        await stakeAndValidate(bob, toTokenAmount(500));

        const daiTotalProfits = await sendProfitAndValidate(this.daiToken, admin, toTokenAmount(1000), this.staking.address, true);
        const wethTotalProfits = await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true);
        const cotiTotalProfits = await sendProfitAndValidate(this.cotiToken, admin, toTokenAmount(3000), this.staking.address, true);

        await stakeAndValidate(bob, toTokenAmount(500));
        await stakeAndValidate(alice, toTokenAmount(250));

        const daiTotalProfits2 = daiTotalProfits.add(await sendProfitAndValidate(this.daiToken, admin, toTokenAmount(1000), this.staking.address, true));
        const wethTotalProfits2 = wethTotalProfits.add(await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true));
        const cotiTotalProfits2 = cotiTotalProfits.add(await sendProfitAndValidate(this.cotiToken, admin, toTokenAmount(3000), this.staking.address, true));

        expect(await this.staking.profitOf(bob, this.daiToken.address)).to.be.bignumber.
            equal(calculateProfit(new BN(0), daiTotalProfits, toTokenAmount(500)).add(calculateProfit(daiTotalProfits, daiTotalProfits2, toTokenAmount(1000))));
        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.
            equal(calculateProfit(new BN(0), wethTotalProfits, toTokenAmount(500)).add(calculateProfit(wethTotalProfits, wethTotalProfits2, toTokenAmount(1000))));
        expect(await this.staking.profitOf(bob, this.cotiToken.address)).to.be.bignumber.
            equal(calculateProfit(new BN(0), cotiTotalProfits, toTokenAmount(500)).add(calculateProfit(cotiTotalProfits, cotiTotalProfits2, toTokenAmount(1000))));

        expect(await this.staking.profitOf(alice, this.daiToken.address)).to.be.bignumber.
            equal(calculateProfit(daiTotalProfits, daiTotalProfits2, toTokenAmount(250)));
        expect(await this.staking.profitOf(alice, this.wethToken.address)).to.be.bignumber.
            equal(calculateProfit(wethTotalProfits, wethTotalProfits2, toTokenAmount(250)));
        expect(await this.staking.profitOf(alice, this.cotiToken.address)).to.be.bignumber.
            equal(calculateProfit(cotiTotalProfits, cotiTotalProfits2, toTokenAmount(250)));

        expect(await this.staking.profitOf(alice, this.usdtToken.address)).to.be.bignumber.equal(new BN(0));
        expect(await this.staking.profitOf(bob, this.usdtToken.address)).to.be.bignumber.equal(new BN(0));
    });

    it('unstakes and restakes new amnount if staking when already staked', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(2000), {from: admin});

        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        await stakeAndValidate(bob, toTokenAmount(250));

        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(new BN(0));

        await stakeAndValidate(bob, toTokenAmount(750));

        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(new BN(0));
        await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true);
        const firstTotalProfit = toTokenAmount(2000).mul(PRECISION_DECIMALS).div(toTokenAmount(1000));
        const firstProfit = calculateProfit(new BN(0), firstTotalProfit, toTokenAmount(1000));
        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(firstProfit);

        await stakeAndValidate(bob, toTokenAmount(500));
        await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(3000), this.staking.address, true);
        const secondTotalProfit = firstTotalProfit.add(toTokenAmount(3000).mul(PRECISION_DECIMALS).div(toTokenAmount(1500)));
        const secondProfit = calculateProfit(firstTotalProfit, secondTotalProfit, toTokenAmount(1500));

        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(firstProfit.add(secondProfit));
    });

    it('reverts when unstaking zero amount', async() => {
        await expectRevert(this.staking.unstake(new BN(0), {from: bob}), 'Amount must be positive');
    });

    it('reverts when unstaking amount more than staked', async() => {
        await expectRevert(this.staking.unstake(new BN(1), {from: bob}), 'Not enough staked');

        await this.cviToken.transfer(bob, toTokenAmount(500), {from: admin});
        await stakeAndValidate(bob, toTokenAmount(500));

        await expectRevert(this.staking.unstake(toTokenAmount(501), {from: bob}), 'Not enough staked');
        await expectRevert(this.staking.unstake(toTokenAmount(500), {from: bob}), 'Funds locked');
    });

    it('reverts when stakes are locked', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(500), {from: admin});
        const stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(500));

        await expectRevert(this.staking.unstake(toTokenAmount(500), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp.add(new BN(60 * 60 - 1)));

        await expectRevert(this.staking.unstake(toTokenAmount(500), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp.add(new BN(60 * 60)));
        await unstakeAndValidate(bob, toTokenAmount(500));
    });

    it('locks all stakes when adding stakes', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        const stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(500));

        await expectRevert(this.staking.unstake(toTokenAmount(500), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp.add(new BN(10 * 60)));
        const stakeTimestamp2 = await stakeAndValidate(bob, toTokenAmount(500));

        await time.increaseTo(stakeTimestamp.add(new BN(60 * 60)));
        await expectRevert(this.staking.unstake(toTokenAmount(500), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp2.add(new BN(60 * 60 - 2)));
        await expectRevert(this.staking.unstake(toTokenAmount(500), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp2.add(new BN(60 * 60)));
        await unstakeAndValidate(bob, toTokenAmount(500));
    });

    it('allows staking before adding claimable token', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(500), {from: admin});
        await stakeAndValidate(bob, toTokenAmount(500));

        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});
        const totalProfit = await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(1000), this.staking.address, true);

        await time.increase(60 * 60);

        await unstakeAndValidate(bob, toTokenAmount(500));

        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(calculateProfit(new BN(0), totalProfit, toTokenAmount(500)));
    });

    it('calculates profits proportionally for multiple accounts', async() => {
        await this.cviToken.transfer(alice, toTokenAmount(1000), {from: admin});
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await this.cviToken.transfer(carol, toTokenAmount(1000), {from: admin});

        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        await stakeAndValidate(bob, toTokenAmount(500));
        const totalProfit1 = await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(1000), this.staking.address, true);

        await stakeAndValidate(alice, toTokenAmount(400));
        const totalProfit2 = totalProfit1.add(await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(4000), this.staking.address, true));

        await stakeAndValidate(carol, toTokenAmount(300));
        const totalProfit3 = totalProfit2.add(await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true));

        await time.increase(60 * 60);

        await unstakeAndValidate(carol, toTokenAmount(200));
        await stakeAndValidate(alice, toTokenAmount(100));
        const totalProfit4 = totalProfit3.add(await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(3000), this.staking.address, true));

        await time.increase(60 * 60);

        await unstakeAndValidate(alice, toTokenAmount(400));
        const totalProfit5 = totalProfit4.add(await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(500), this.staking.address, true));

        await unstakeAndValidate(bob, toTokenAmount(300));
        const totalProfit6 = totalProfit5.add(await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(7000), this.staking.address, true));

        await unstakeAndValidate(bob, toTokenAmount(200));
        await unstakeAndValidate(carol, toTokenAmount(100));

        const bobProfit = calculateProfit(new BN(0), totalProfit5, toTokenAmount(500)).
            add(calculateProfit(totalProfit5, totalProfit6, toTokenAmount(200)));

        const aliceProfit = calculateProfit(totalProfit1, totalProfit4, toTokenAmount(400)).
            add(calculateProfit(totalProfit3, totalProfit6, toTokenAmount(100)));

        const carolProfit = calculateProfit(totalProfit2, totalProfit3, toTokenAmount(300)).
            add(calculateProfit(totalProfit3, totalProfit6, toTokenAmount(100)));

        expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(bobProfit);
        expect(await this.staking.profitOf(alice, this.wethToken.address)).to.be.bignumber.equal(aliceProfit);
        expect(await this.staking.profitOf(carol, this.wethToken.address)).to.be.bignumber.equal(carolProfit);
    });

    it('sets locking period properly', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(500), {from: admin});
        await this.staking.setStakingLockupTime(0, {from: admin});
        expect(await this.staking.stakeLockupTime()).to.be.bignumber.equal(new BN(0));

        let stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(100), {from: bob});
        await unstakeAndValidate(bob, toTokenAmount(100));

        await this.staking.setStakingLockupTime(60, {from: admin});
        expect(await this.staking.stakeLockupTime()).to.be.bignumber.equal(new BN(60));

        stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(100), {from: bob});
        await expectRevert(this.staking.unstake(toTokenAmount(100), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp.add(new BN(60 - 1)));
        await expectRevert(this.staking.unstake(toTokenAmount(100), {from: bob}), 'Funds locked');

        await time.increaseTo(stakeTimestamp.add(new BN(60)));
        await unstakeAndValidate(bob, toTokenAmount(100));
    });

    it('reverts when setting locking period, or adding/removing tokens not by owner', async() => {
        await expectRevert(this.staking.setStakingLockupTime(60, {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.staking.addToken(this.wethToken.address, {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.staking.removeToken(this.wethToken.address, {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.staking.addClaimableToken(this.wethToken.address, {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.staking.removeClaimableToken(this.wethToken.address, {from: bob}), 'Ownable: caller is not the owner');
    });

    it('adds and removes claimable tokens properly', async() => {
        const addOtherToken = token => this.staking.addClaimableToken(token.address, {from: admin});
        const removeOtherToken = token => this.staking.removeClaimableToken(token.address, {from: admin});
        const getTokens = () => this.staking.getClaimableTokens();

        await testAddAndRemoveTokens(addOtherToken, removeOtherToken, getTokens);
    });

    it('adds and removes other tokens properly', async() => {
        const addOtherToken = token => this.staking.addToken(token.address, {from: admin});
        const removeOtherToken = token => this.staking.removeToken(token.address, {from: admin});
        const getTokens = () => this.staking.getOtherTokens();

        await testAddAndRemoveTokens(addOtherToken, removeOtherToken, getTokens);
    });

    // Note: was not functioning well after moving to safeApprove as didn't approve 0 on remove
    it('allows moving tokens from claimable to other and back again', async() => {
        await this.staking.addClaimableToken(this.daiToken.address, {from: admin});
        await this.staking.removeClaimableToken(this.daiToken.address, {from: admin});
        await this.staking.addToken(this.daiToken.address, {from: admin});
        await this.staking.removeToken(this.daiToken.address, {from: admin});
        await this.staking.addClaimableToken(this.daiToken.address, {from: admin});
        await this.staking.removeClaimableToken(this.daiToken.address, {from: admin});
        await this.staking.addToken(this.daiToken.address, {from: admin});
    });

    const testClaimProfit = async (tokens, convertToToken) => {
        await this.cviToken.transfer(bob, convertToToken(1000), {from: admin});

        for (let token of tokens) {
            await this.staking.addClaimableToken(token.address, {from: admin});
        }

        if (tokens.length === 1) {
            await expectRevert(this.staking.claimProfit(tokens[0].address, {from: bob}), 'No profit for token');
        } else {
            await expectRevert(this.staking.claimAllProfits({from: bob}), 'No profit');
        }

        await stakeAndValidate(bob, convertToToken(500));

        let totalProfit1;
        for (let token of tokens) {
            totalProfit1 = await sendProfitAndValidate(token, admin, convertToToken(1000), this.staking.address, true);
        }

        await claimAndValidate(bob, tokens, calculateProfit(new BN(0), totalProfit1, convertToToken(500)));

        let totalProfit2;
        let totalProfit3;
        for (let token of tokens) {
            totalProfit2 = totalProfit1.add(await sendProfitAndValidate(token, admin, convertToToken(4000), this.staking.address, true));
            totalProfit3 = totalProfit2.add(await sendProfitAndValidate(token, admin, convertToToken(2000), this.staking.address, true));
        }

        await claimAndValidate(bob, tokens, calculateProfit(totalProfit1, totalProfit3, convertToToken(500)));

        //TODO: Function?
        if (tokens.length === 1) {
            await expectRevert(this.staking.claimProfit(tokens[0].address, {from: bob}), 'No profit for token');
        } else {
            await expectRevert(this.staking.claimAllProfits({from: bob}), 'No profit');
        }
    };

    it('reverts when claiming unsupported token or no profit', async() => {
        await expectRevert(this.staking.claimProfit(this.daiToken.address, {from: bob}), 'Token not supported');
        await this.staking.addToken(this.daiToken.address, {from: admin});
        await expectRevert(this.staking.claimProfit(this.daiToken.address, {from: bob}), 'Token not supported');

        await this.staking.addClaimableToken(this.daiToken.address, {from: admin});
        await expectRevert(this.staking.claimProfit(this.daiToken.address, {from: bob}), 'No profit for token');
    });

    it('claims profit properly for non-weth token', async() => {
        await testClaimProfit([this.daiToken], amount => toTokenAmount(amount));
    });

    it('claims profit as eth for weth token', async() => {
        await this.wethToken.deposit({from: admin, value: web3.utils.toWei('10')});
        await testClaimProfit([this.wethToken], amount => toBN(amount, 13));
    });

    it('reverts when claiming all profits with no profits', async () => {
        await expectRevert(this.staking.claimAllProfits({from: bob}), 'No profit');
    });

    it('claims all profits including eth for weth token properly', async() => {
        await this.wethToken.deposit({from: admin, value: web3.utils.toWei('10')});
        await testClaimProfit([this.daiToken, this.usdtToken, this.wethToken], amount => toBN(amount, 13));
    });

    it('reverts when no funds to convert', async() => {
        await this.staking.addToken(this.daiToken.address, {from: admin});
        await this.staking.addToken(this.usdtToken.address, {from: admin});
        await this.staking.addToken(this.cotiToken.address, {from: admin});

        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await stakeAndValidate(bob, toTokenAmount(1000));

        await expectRevert(this.staking.convertFunds(), 'No funds to convert');

        await this.daiToken.approve(this.staking.address, toTokenAmount(1000), {from: admin});
        await this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin});

        await this.staking.convertFunds({from: bob});
    });

    it('converts all other tokens to weth properly when calling convert', async() => {
        await this.staking.addToken(this.daiToken.address, {from: admin});
        await this.staking.addToken(this.usdtToken.address, {from: admin});
        await this.staking.addToken(this.cotiToken.address, {from: admin});

        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await stakeAndValidate(bob, toTokenAmount(1000));

        await this.daiToken.approve(this.staking.address, toTokenAmount(1000), {from: admin});
        await this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, {from: admin});

        await this.usdtToken.approve(this.staking.address, toTokenAmount(2000), {from: admin});
        await this.staking.sendProfit(toTokenAmount(2000), this.usdtToken.address, {from: admin});

        await this.cviToken.transfer(alice, toTokenAmount(1000), {from: admin});
        await stakeAndValidate(alice, toTokenAmount(1000));

        await this.cotiToken.approve(this.staking.address, toTokenAmount(3000), {from: admin});
        await this.staking.sendProfit(toTokenAmount(3000), this.cotiToken.address, {from: admin});

        expect(await this.staking.profitOf(bob, this.wethToken.address, {from: bob})).to.be.bignumber.equal(new BN(0));
        expect(await this.staking.profitOf(alice, this.wethToken.address, {from: alice})).to.be.bignumber.equal(new BN(0));

        await this.staking.convertFunds({from: carol});

        const daiProfit = toTokenAmount(1000).div(TO_WETH_RATE).mul(PRECISION_DECIMALS).div(toTokenAmount(2000));
        const usdtProfit = toTokenAmount(2000).div(TO_WETH_RATE).mul(PRECISION_DECIMALS).div(toTokenAmount(2000));
        const cotiProfit = toTokenAmount(3000).div(TO_WETH_RATE).mul(PRECISION_DECIMALS).div(toTokenAmount(2000));

        const totalProfit = daiProfit.add(usdtProfit).add(cotiProfit);

        const bobProfit = calculateProfit(new BN(0), totalProfit, toTokenAmount(1000));
        const aliceProfit = calculateProfit(new BN(0), totalProfit, toTokenAmount(1000));

        expect(await this.staking.profitOf(bob, this.wethToken.address, {from: bob})).to.be.bignumber.equal(bobProfit);
        expect(await this.staking.profitOf(alice, this.wethToken.address, {from: alice})).to.be.bignumber.equal(aliceProfit);
    });

    it('ETH proxy stakes properly receives profits', async() => {
        const amount = toTokenAmount(1);
        const proxyBalanceBefore = await balance.current(this.stakingProxy.address, 'wei');
        await send.ether(admin, this.stakingProxy.address, amount);
        const proxyBalanceAfter = await balance.current(this.stakingProxy.address, 'wei');
        expect(proxyBalanceBefore.add(amount)).to.be.bignumber.equal(proxyBalanceAfter);
    });

    it('ETH proxy stakes properly converts and transfers profits to staking', async() => {
        await this.cviToken.transfer(bob, toTokenAmount(1000), {from: admin});
        await stakeAndValidate(bob, toTokenAmount(1000));

        await this.staking.addClaimableToken(this.wethToken.address, {from: admin});

        const amount = toTokenAmount(10);
        await send.ether(admin, this.stakingProxy.address, amount);

        const stakingBalanceBefore = await this.wethToken.balanceOf(this.staking.address);
        await this.stakingProxy.convertETHFunds({from: admin});

        const stakingBalanceAfter = await this.wethToken.balanceOf(this.staking.address);
        expect(stakingBalanceBefore.add(amount)).to.be.bignumber.equal(stakingBalanceAfter);
    });
});
