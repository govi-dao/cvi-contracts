const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const expect = chai.expect;

const {deployFullPlatform, deployPlatform, getContracts} = require('./utils/DeployUtils');
const {createState, depositAndValidate, withdrawAndValidate, openPositionAndValidate, closePositionAndValidate,
    deposit, withdraw, withdrawLPTokens, openPosition, closePosition, calculateDepositAmounts, calculateWithdrawAmounts} = require('./utils/PlatformUtils.js');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const { print } = require('./utils/DebugUtils');

const StakingRewards = contract.fromArtifact('USDTLPStakingRewards');
const FakeFeesCollector = contract.fromArtifact('FakeFeesCollector');

const [admin, bob, alice, carol, dave] = accounts;
const accountsUsed = [admin, bob, alice, carol];

const OPEN_FEE_PERC = new BN(30);
const DEPOSIT_FEE_PERC = new BN(0);
const WITHDRAW_FEE_PERC = new BN(0);
const TURBULENCE_PREMIUM_PERC_STEP = new BN(100);
const MAX_BUYING_PREMIUM_PERC = new BN(1000);
const MAX_FEE = new BN(10000);
const MAX_CVI_VALUE = new BN(20000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SECOND_INITIAL_RATE = toBN(1, 18);
const SECOND_ETH_INITIAL_RATE = toBN(1, 10);

const leftTokensToWithdraw = async account => {
    const totalSupply = await this.platform.totalSupply();

    const totalBalance = this.isETH ? await balance.current(this.platform.address, 'wei') :
        await this.token.balanceOf(this.platform.address);

    const leftTokens = (await this.platform.balanceOf(account)).mul(totalBalance).div(totalSupply);

    return leftTokens;
};

const testMultipleAccountsDepositWithdraw = async (depositFee, withdrawFee, testEndBalance = true) => {
    await this.feesCalculator.setDepositFee(depositFee, {from: admin});
    await this.feesCalculator.setWithdrawFee(withdrawFee, {from: admin});

    await depositAndValidate(this.state, 5000, bob);
    await depositAndValidate(this.state, 1000, alice);

    await time.increase(3 * 24 * 60 * 60);

    await withdrawAndValidate(this.state, 1000, bob);
    await depositAndValidate(this.state, 3000, carol);
    await withdrawAndValidate(this.state, 500, alice);

    await time.increase(3 * 24 * 60 * 60);

    if (depositFee.toNumber() === 0 && withdrawFee.toNumber() === 0) {
        await withdrawAndValidate(this.state, 500, alice);
        await withdrawAndValidate(this.state, 3000, carol);
    } else {
        let leftTokens = await leftTokensToWithdraw(alice);
        await withdrawAndValidate(this.state, leftTokens, alice);

        leftTokens = await leftTokensToWithdraw(carol);
        await withdrawAndValidate(this.state, leftTokens, carol);
    }

    if (testEndBalance) {
        expect(await this.platform.balanceOf(carol)).is.bignumber.equal(new BN(0));
        expect(await this.platform.balanceOf(alice)).is.bignumber.equal(new BN(0));
    }
};

const calculationsForBuyingPremium = async(cviValue, openTokenAmount, previousPositionUnits) => {
    let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
    let openPositionFee = openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE);
    let positionUnitsAmountWithoutPremium = (openTokenAmount.sub(openPositionFee)).div(cviValue).mul(MAX_CVI_VALUE);
    let minPositionUnitsAmount = positionUnitsAmountWithoutPremium.mul(new BN(90)).div(new BN(100));
    let totalPositionUnitsAmount =  await this.platform.totalPositionUnitsAmount();

    let tokensInSharedPoolBalance = await this.token.balanceOf(this.platform.address);
    let collateralRatio = toTokenAmount(totalPositionUnitsAmount.add(minPositionUnitsAmount)).div(tokensInSharedPoolBalance.add(openTokenAmount).sub(openPositionFee)).div(new BN(100000000));
    let buyingPremium = await this.feesCalculator.calculateBuyingPremiumFee(openTokenAmount, collateralRatio);

    let buyingPremiumPercent = buyingPremium.mul(MAX_FEE).div(openTokenAmount);
    let combineedBuyingPremiumPercent = new BN(buyingPremiumPercent.add(currTurbulence));
    if (combineedBuyingPremiumPercent.gt(MAX_BUYING_PREMIUM_PERC)) {
        combineedBuyingPremiumPercent = MAX_BUYING_PREMIUM_PERC;
    }

    let currPositionUnits = openTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(combineedBuyingPremiumPercent)).div(MAX_FEE).mul(MAX_CVI_VALUE).div(cviValue);
    let combinedPositionUnits = currPositionUnits.add(previousPositionUnits);

    return [combinedPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount];
};

const beforeEachPlatform = async isETH => {
    await deployFullPlatform(isETH);

    this.isETH = isETH;
    this.cviToken = getContracts().cviToken;
    this.tokenAddress = getContracts().tokenAddress;
    this.token = getContracts().token;
    this.fakePriceProvider = getContracts().fakePriceProvider;
    this.fakeOracle =getContracts().fakeOracle;
    this.feesCalculator = getContracts().feesCalculator;
    this.fakeFeesCollector = getContracts().fakeFeesCollector;
    this.rewards = getContracts().rewards;
    this.liquidation = getContracts().liquidation;
    this.platform = getContracts().platform;

    this.state = createState(accountsUsed);

    await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, {from: admin});
    await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, {from: admin});
};

const setPlatformTests = isETH => {
    it('reverts when deposit gives less than min LP tokens', async () => {
        const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } = await calculateDepositAmounts(this.state, 5000);

        if (!this.isETH) {
            await this.token.transfer(bob, bobDepositTokens, {from: admin});
            await this.token.approve(this.platform.address, bobLPTokens, {from: bob});
        }

        await expectRevert(deposit(bobDepositTokens, bobLPTokens.add(new BN(1)), bob), 'Too few LP tokens');
    });

    if (!isETH) {
        it('reverts when depositing and not enough tokens are allowed', async() => {
            const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } =
                await calculateDepositAmounts(this.state, 5000);

            await this.token.transfer(bob, bobDepositTokens, {from: admin});

            await expectRevert(deposit(bobDepositTokens, bobLPTokens, bob), 'ERC20: transfer amount exceeds allowance');
            await this.token.approve(this.platform.address, bobDepositTokens.sub(new BN(1)), {from: bob});
            await expectRevert(deposit(bobDepositTokens, bobLPTokens, bob), 'ERC20: transfer amount exceeds allowance');
            await this.token.approve(this.platform.address, bobLPTokens, {from: bob});

            await this.platform.deposit(bobDepositTokens, bobLPTokens, {from: bob});
        });
    }

    if (isETH) {
        it('reverts when calling deposit and openPosition instead of depositETH and openPositionETH', async() => {
            await expectRevert(this.platform.deposit(toBN(1000, 18), new BN(0)), 'Use depositETH');
            await expectRevert(this.platform.openPosition(toBN(1000, 18), MAX_CVI_VALUE, MAX_FEE, new BN(1)), 'Use openPositionETH');
        });
    }

    it('deposits liquidity correctly', async () => {
        await depositAndValidate(this.state, 5000, bob);
        await depositAndValidate(this.state, 1000, bob);
        await depositAndValidate(this.state, 2000, alice);
    });

    it('withdraws all lp tokens correctly', async () => {
        await depositAndValidate(this.state, 1000, bob);
        await time.increase(3 * SECONDS_PER_DAY);

        const bobLPTokensBalance = await this.platform.balanceOf(bob);
        await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance);

        expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0));
    });

    it('reverts when withdrawing locked funds', async () => {
        const depositTimestamp = await depositAndValidate(this.state, 5000, bob);

        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(24 * 60 * 60)));
        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60 - 2)));
        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60)));

        await withdraw(toBN(1), toTokenAmount(1000000), bob);
    });

    it('reverts when withdrawing a zero amount', async () => {
        await expectRevert(withdraw(toBN(0), toTokenAmount(1000000), bob), 'Tokens amount must be positive');
    });

    it('reverts when withdraw results in burning more than max requested LP tokens', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const { withdrawTokens, burnedLPTokens } = await calculateWithdrawAmounts(this.state, 5000);

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(withdrawTokens, burnedLPTokens.sub(new BN(1)), bob), 'Too much LP tokens to burn');
    });

    it('reverts when withdrawing with not enough LP tokens in account balance', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const { withdrawTokens, burnedLPTokens } = await calculateWithdrawAmounts(this.state, 5001);

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(withdrawTokens, burnedLPTokens, bob), 'Not enough LP tokens for account');
    });

    it('withdraws liquidity correctly', async () => {
        await depositAndValidate(this.state, 5000, bob);

        await time.increase(3 * 24 * 60 * 60);

        await withdrawAndValidate(this.state, 1000, bob);
        await withdrawAndValidate(this.state, 500, bob);
        await withdrawAndValidate(this.state, 2000, bob);

        const leftTokens = await leftTokensToWithdraw(bob);
        await withdrawAndValidate(this.state, leftTokens, bob);

        expect(await this.platform.balanceOf(bob)).is.bignumber.equal(new BN(0));
    });

    it('handles multiple accounts deposit and withdraw correctly with a different initial rate', async () => {
        await deployPlatform(this.isETH, SECOND_INITIAL_RATE, SECOND_ETH_INITIAL_RATE);
        this.platform = getContracts().platform;

        await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, WITHDRAW_FEE_PERC);
    });

    it('handles multiple accounts deposit and withdraw correctly', async () => {
        await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, WITHDRAW_FEE_PERC);
    });

    it('handles multiple accounts deposit and withdraw correctly with no fees', async () => {
        await testMultipleAccountsDepositWithdraw(new BN(0), new BN(0));
    });

    it('handles multiple accounts deposit and withdraw correctly with deposit fee only', async () => {
        await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, new BN(0));
    });

    it('handles multiple accounts deposit and withdraw correctly with withdraw fee only', async () => {
        await testMultipleAccountsDepositWithdraw(new BN(0), WITHDRAW_FEE_PERC);
    });

    it('prevents bypassing lock by passing token to antoher address', async () => {
        const timestamp = await depositAndValidate(this.state, 1000, bob);
        const lpTokensNum = await this.platform.balanceOf(bob);

        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), bob), 'Funds are locked');

        await time.increaseTo(timestamp.add(new BN(SECONDS_PER_DAY)));
        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), bob), 'Funds are locked');

        await this.platform.transfer(alice, lpTokensNum, {from: bob});

        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), alice), 'Funds are locked');

        await time.increaseTo(timestamp.add(new BN(3 * SECONDS_PER_DAY - 2)));
        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), alice), 'Funds are locked');

        await time.increaseTo(timestamp.add(new BN(3 * SECONDS_PER_DAY)));
        await withdraw(new BN(1), toTokenAmount(1000000), alice);
    });

    it('lock time is not passed when staking/unstaking to staking contract address specified', async () => {
        if (!this.isETH) {
            await this.token.transfer(bob, 2000, {from: admin});
            await this.token.approve(this.platform.address, 2000, {from: bob});

            await this.token.transfer(alice, 1000, {from: admin});
            await this.token.approve(this.platform.address, 1000, {from: alice});
        }

        const staking = await StakingRewards.new(admin, admin, this.cviToken.address, this.platform.address);

        await deposit(1000, 0, bob);
        const timestamp = await time.latest();
        const lpTokensNum = await this.platform.balanceOf(bob);

        expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp);

        await time.increase(60);

        await this.platform.approve(staking.address, lpTokensNum, {from: bob});
        await staking.stake(lpTokensNum, {from: bob});
        expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp);

        await time.increase(60);

        await deposit(1000, 0, alice);
        const timestamp2 = await time.latest();
        const lpTokensNum2 = await this.platform.balanceOf(alice);
        expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp);

        await time.increase(60);

        await this.platform.approve(staking.address, lpTokensNum2, {from: alice});
        await staking.stake(lpTokensNum2, {from: alice});
        expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);

        await time.increase(60);

        await staking.withdraw(lpTokensNum, {from: bob});
        expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp2);

        await this.platform.setStakingContractAddress(staking.address, {from: admin});
        await time.increase(60);

        await deposit(1000, 0, bob);
        const timestamp3 = await time.latest();
        const lpTokensNum3 = await this.platform.balanceOf(bob);
        expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3);

        await time.increase(60);

        this.platform.approve(staking.address, lpTokensNum3, {from: bob});
        await staking.stake(lpTokensNum3, {from: bob});
        expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);
        expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3);

        await time.increase(60);

        await staking.withdraw(lpTokensNum3, {from: bob});

        expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);
        expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3);
    });

    it('prevents transfer of locked tokens if recipient sets so', async () => {
        const timestamp = await depositAndValidate(this.state, 1000, bob);
        const lpTokensNum = await this.platform.balanceOf(bob);

        if (!this.isETH) {
            await this.token.transfer(bob, 1000, {from: admin});
            await this.token.approve(this.platform.address, 1000, {from: bob});

            await this.token.transfer(alice, 1000, {from: admin});
            await this.token.approve(this.platform.address, 1000, {from: alice});
        }

        await time.increaseTo(timestamp.add(new BN(2 * SECONDS_PER_DAY)));

        expect(await this.platform.revertLockedTransfered(bob)).to.be.false;
        expect(await this.platform.revertLockedTransfered(alice)).to.be.false;

        await this.platform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob});
        await this.platform.setRevertLockedTransfers(true, {from: bob});
        expect(await this.platform.revertLockedTransfered(bob)).to.be.true;

        await time.increase(1);
        await deposit(10, 0, bob);

        await this.platform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob});
        await this.platform.setRevertLockedTransfers(true, {from: alice});
        expect(await this.platform.revertLockedTransfered(alice)).to.be.true;

        await time.increase(1);
        await deposit(10, 0, bob);

        await expectRevert(this.platform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob}), 'Recipient refuses locked tokens');
        await this.platform.setRevertLockedTransfers(false, {from: alice});

        await time.increase(1);
        await deposit(10, 0, alice);

        await this.platform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob});
        await expectRevert(this.platform.transfer(bob, lpTokensNum.div(new BN(4)), {from: alice}), 'Recipient refuses locked tokens');
    });

    it('allows emergency withdraw if set even when collateral is broken but keeps lock', async () => {
        await depositAndValidate(this.state, 5000, bob);
        //await this.fakePriceProvider.setPrice(toCVI(5000));

        await openPositionAndValidate(this.state, 1000, alice);

        /*await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdrawAndValidate(this.state, 3000, bob), 'Collateral ratio broken');
        await this.platform.setEmergencyWithdrawAllowed(true, {from: admin});
        await withdrawAndValidate(this.state, 3000, bob);

        await depositAndValidate(this.state, 5000, bob);

        await expectRevert(withdrawAndValidate(this.state, 3000, bob), 'Funds are locked');

        await time.increase(3 * 24 * 60 * 60);

        await this.platform.setEmergencyWithdrawAllowed(false, {from: admin});
        await expectRevert(withdrawAndValidate(this.state, 5000, bob), 'Collateral ratio broken');*/

    });

    it('allows complete shutdown of all operations by setters', async () => {
        await this.platform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await expectRevert(depositAndValidate(this.state, 5000, bob), 'revert');

        await this.platform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await depositAndValidate(this.state, 5000, bob);
        await this.platform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(1000, toBN(1, 40), bob), 'revert');
        await expectRevert(withdrawLPTokens(1000, bob), 'revert');

        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'revert');

        await this.platform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await this.platform.setFeesCalculator(ZERO_ADDRESS, {from: admin});
        await expectRevert(closePosition(1000, 5000, alice), 'revert');

        await this.platform.setLiquidation(ZERO_ADDRESS, {from: admin});
        await expectRevert(this.platform.liquidatePositions([bob], {from: carol}), 'revert');

        await this.platform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await this.platform.setLiquidation(this.liquidation.address, {from: admin});

        await expectRevert(this.platform.liquidatePositions([bob], {from: carol}), 'No liquidatable position');
    });

    it('reverts when opening a position with zero tokens', async () => {
        await expectRevert(openPosition(0, 20000, alice), 'Tokens amount must be positive');
    });

    it('reverts when opening a position with a bad max CVI value', async () => {
        await expectRevert(openPosition(5000, 0, alice), 'Bad max CVI value');
        await expectRevert(openPosition(5000, 20001, alice), 'Bad max CVI value');
    });

    it('reverts when opening a position with CVI value higher than max CVI', async () => {
        await depositAndValidate(this.state, 40000, bob);

        if (!this.isETH) {
            await this.token.transfer(alice, 10000, {from: admin});
            await this.token.approve(this.platform.address, 10000, {from: alice});
        }

        await this.fakePriceProvider.setPrice(toCVI(5000));
        await expectRevert(openPosition(5000, 4999, alice), 'CVI too high');

        await this.fakePriceProvider.setPrice(toCVI(6000));
        await openPosition(5000, 6000, alice);
        await openPosition(5000, 6001, alice);
        await expectRevert(openPosition(5000, 5999, alice), 'CVI too high');
    });

    it('reverts when opening a position with buying premium percentage higher than max', async () => {
        await depositAndValidate(this.state, 40000, bob);

        if (!this.isETH) {
            await this.token.transfer(alice, 10000, {from: admin});
            await this.token.approve(this.platform.address, 10000, {from: alice});
        }

        // Cause turbulence
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);

        // Used to update snapshots
        await depositAndValidate(this.state, 1, bob);

        const turbulenceIndicatorPercent = TURBULENCE_PREMIUM_PERC_STEP.mul(new BN(3));

        await expectRevert(openPosition(5000, 5000, alice, turbulenceIndicatorPercent.sub(new BN(1))), 'Premium fee too high');
        await openPosition(5000, 5000, alice, turbulenceIndicatorPercent);
    });

    if (!isETH) {
        it('reverts when opening a position with too high position units', async () => {
            const overflowReason = this.isETH ? 'SafeMath: subtraction overflow': 'Too much position units';
            await expectRevert(openPosition(toBN(374, 48), 5000, alice), overflowReason);
            await expectRevert(openPosition(toBN(94, 48), 5000, alice), overflowReason);
        });

        it('reverts when merging a position with too high position units', async () => {
            await depositAndValidate(this.state, 4000, bob);
            await openPositionAndValidate(this.state, 1000, alice);

            const overflowReason = this.isETH ? 'SafeMath: subtraction overflow': 'Too much position units';
            await expectRevert(openPosition(toBN(374, 48).sub(new BN(1000).div(new BN(4))), 5000, alice), overflowReason);
            await expectRevert(openPosition(toBN(120, 48).sub(new BN(1000).div(new BN(4))), 5000, alice), overflowReason);
        });
    }

    it.skip('reverts if not enough liquidity expected after openning a position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: alice});

        /*
        await expectRevert(this.platform.openPosition(toTokenAmount(1000), 5000, {from: alice}), 'Not enough liquidity');
        await depositAndValidate(this.state, toTokenAmount(3000), bob);
        await expectRevert(this.platform.openPosition(toTokenAmount(1000), 5000, {from: alice}), 'Not enough liquidity');
        await depositAndValidate(this.state, toTokenAmount(10), bob);

        await this.platform.openPosition(toTokenAmount(1000), 5000, {from: alice});*/
    });

    it('reaches low enough gas values for deposit/withdraw actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 60);
        print('first deposit ever');
        await depositAndValidate(this.state, 4000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(24 * 60);

        print('second deposit');
        await depositAndValidate(this.state, 2000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));

        await time.increase(3 * 24 * 60 * 60);

        print('partial withdraw');
        await withdrawAndValidate(this.state, 2000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(24 * 60);

        print('full withdraw');
        await withdrawAndValidate(this.state, 4000, bob);
    });

    it('reaches low enough gas values for open/close actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        print('first deposit ever');
        await time.increase(24 * 60 * 60);
        await depositAndValidate(this.state, 40000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(60 * 60);

        print('first open ever');
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 5000, alice);

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(60 * 60);

        print('open merge');
        const {positionUnits: positionUnits2} = await openPositionAndValidate(this.state, 3000, alice);

        let positionUnits = positionUnits2;

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(60 * 60);

        print('partial close');
        await time.increase(3 * 24 * 60 * 60);
        await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice);
        positionUnits = positionUnits.sub(positionUnits.div(new BN(2)));
        print('entire close');
        await time.increase(24 * 60 * 60);
        await closePositionAndValidate(this.state, positionUnits, alice);

        print('partial withdraw');
        await time.increase(3 * 24 * 60 * 60);
        await withdrawAndValidate(this.state, 10000, bob);
        print('second deposit');
        await time.increase(24 * 60 * 60);
        await depositAndValidate(this.state, 10000, bob);
        print('full withdraw');
        await time.increase(3 * 24 * 60 * 60);

        const tokensLeft = this.isETH ? await balance.current(this.platform.address, 'wei') :
            await this.token.balanceOf(this.platform.address);
        await withdrawAndValidate(this.state, tokensLeft, bob);
    });

    it('opens a position properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 24 * 60);
        await depositAndValidate(this.state, 20000, bob);
        await time.increase(24 * 24 * 60);
        await openPositionAndValidate(this.state, 5000, alice);
    });

    it('opens a position properly with no rewards', async () => {
        await this.platform.setRewards(ZERO_ADDRESS, {from: admin});

        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 24 * 60);
        await depositAndValidate(this.state, 20000, bob);
        await time.increase(24 * 24 * 60);
        await openPositionAndValidate(this.state, 5000, alice);
    });

    it('merges a position properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(this.state, 60000, bob);
        await openPositionAndValidate(this.state, 5000, alice);

        // To avoid turbulence
        await time.increase(60 * 60);

        await this.fakePriceProvider.setPrice(toCVI(6000));
        await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

        await openPositionAndValidate(this.state, 1000, alice);

    });

    it('reverts when trying to close too many positional units', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(this.platform.closePosition(1, 5000, {from: alice}), 'Not enough opened position units');
        await depositAndValidate(this.state, toTokenAmount(4), bob);
        await expectRevert(this.platform.closePosition(1, 5000, {from: alice}), 'Not enough opened position units');
        const {positionUnits} = await openPositionAndValidate(this.state, toTokenAmount(1), alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(this.platform.closePosition(positionUnits.add(new BN(1)), 5000, {from: alice}), 'Not enough opened position units');
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it('reverts when closing zero position units', async () => {
        await depositAndValidate(this.state, 5000, bob);
        await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(0, 5000, alice), 'Position units not positive');
    });

    it('reverts when closing a position with an invalid min CVI value', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(positionUnits, 0, alice), 'Bad min CVI value');
        await expectRevert(closePosition(positionUnits, 20001, alice), 'Bad min CVI value');

        await closePosition(positionUnits, 5000, alice);
    });

    it('reverts when closing a position while locked', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits, timestamp} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increaseTo(timestamp.add(new BN(5 * 60 * 60)));
        await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked');
        await time.increaseTo(timestamp.add(new BN(6 * 60 * 60 - 15)));
        await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked');

        await time.increaseTo(timestamp.add(new BN(6 * 60 * 60)));
        await closePosition(positionUnits, 5000, alice);
    });

    it('reverts when closing a position with CVI below min CVI', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(positionUnits, 5001, alice), 'CVI too low');

        await this.fakePriceProvider.setPrice(toCVI(6000));

        await expectRevert(closePosition(positionUnits, 6001, alice), 'CVI too low');
        await closePosition(positionUnits, 6000, alice);
    });

    it('closes a position properly', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it('closes part of a position properly', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await closePositionAndValidate(this.state, positionUnits.div(new BN(3)), alice);

        await time.increase(24 * 60 * 60);

        await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice);
    });

    it('updates total funding fee back to zero instead of overflowing when rounding, if poision units updates to zero', async () => {
        await depositAndValidate(this.state, 5000, bob);

        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(24 * 60 * 60);

        // Total funding fees grow here
        await depositAndValidate(this.state, 1000, bob);
        await time.increase(24 * 60 * 60);

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it('updates total funding fee back to zero instead of overflowing when rounding on merge, if poision units updates to zero', async () => {
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await depositAndValidate(this.state, 5000, bob);

        await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(2 * 24 * 60 * 60);

        // Total funding fees grow here
        const {positionUnits} = await openPositionAndValidate(this.state, 5, alice);
        await time.increase(24 * 60 * 60);

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it.skip('updates total funding fee back to zero instead of one when rounding, if position units updates to zero', async () => {
        await depositAndValidate(this.state, 1000, bob);

        const {positionUnits} = await openPositionAndValidate(this.state, 201, alice);
        await time.increase(96 * 59 * 59);

        // Total funding fees grow here
        await depositAndValidate(this.state, 1001, bob);
        await time.increase(96 * 59 * 60);

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    const testSnapshot = async (timestamp, shouldBeZero) => {
        if (shouldBeZero) {
            expect(await this.platform.cviSnapshots(timestamp)).to.be.bignumber.equal(new BN(0));
        } else {
            expect(await this.platform.cviSnapshots(timestamp)).to.be.bignumber.not.equal(new BN(0));
        }
    };

    const testLastSnapshotRemove = async canPurgeSnapshots => {
        const timestamp1 = await depositAndValidate(this.state, 2000, bob);
        expect(await this.platform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(3 * 24 * 60 * 60);

        const timestamp2 = await withdrawAndValidate(this.state, 1000, bob);

        await testSnapshot(timestamp1, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {positionUnits, timestamp: timestamp3} = await openPositionAndValidate(this.state, 100, alice);
        await testSnapshot(timestamp2, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(24 * 60 * 60);

        const timestamp4 = await closePositionAndValidate(this.state, positionUnits, alice);
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const timestamp5 = await depositAndValidate(this.state, 2000, bob);
        await testSnapshot(timestamp4, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp5)).to.be.bignumber.not.equal(new BN(0));
    };

    it('deletes last snapshot only if it was not an open position snapshot', async () => {
        await testLastSnapshotRemove(true);
    });

    it('sets purgeSnapshots properly', async () => {
        await this.platform.setCanPurgeSnapshots(false, {from: admin});
        await testLastSnapshotRemove(false);
    });

    it('reverts when opening with a leverage higher than max', async () => {
        await expectRevert(openPosition(1000, 5000, bob, 1000, 2), 'Leverage excceeds max allowed');
    });

    const getFeesBalance = async feesCollector => {
        return (this.isETH ? await balance.current(feesCollector.address, 'wei') :
            await feesCollector.getProfit());
    };

    it('sets feesCollector properly', async () => {
        await depositAndValidate(this.state, 10000, bob);

        const anotherFakeFeesCollector = await FakeFeesCollector.new(this.tokenAddress, {from: admin});

        expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.equal(new BN(0));
        expect(await getFeesBalance(this.fakeFeesCollector)).to.be.bignumber.equal(new BN(0));

        await openPositionAndValidate(this.state, 1000, alice);

        expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.equal(new BN(0));

        const feesCollectorBalance = await getFeesBalance(this.fakeFeesCollector);
        expect(feesCollectorBalance).to.be.bignumber.not.equal(new BN(0));

        await this.platform.setFeesCollector(anotherFakeFeesCollector.address, {from: admin});
        this.state.totalFeesSent = new BN(0);

        await openPositionAndValidate(this.state, 1000, alice);
        expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.not.equal(new BN(0));
        expect(await getFeesBalance(this.fakeFeesCollector)).to.be.bignumber.equal(feesCollectorBalance);
    });

    it('sets maxLeverage properly', async () => {
        if (!this.isETH) {
            await this.token.transfer(alice, 1000, {from: admin});
            await this.token.approve(this.platform.address, 10000, {from: alice});
        }

        await depositAndValidate(this.state, 30000, bob);

        expect(await this.platform.maxAllowedLeverage()).to.be.bignumber.equal(new BN(1));
        await this.platform.setMaxAllowedLeverage(new BN(8), {from: admin});
        expect(await this.platform.maxAllowedLeverage()).to.be.bignumber.equal(new BN(8));
        await expectRevert(openPosition(1000, 5000, alice, 1000, 9), 'Leverage excceeds max allowed');
        await openPosition(1000, 5000, alice, 1000, 8);
    });

    /*function setFeesCollector(IFeesCollector _newCollector) external override onlyOwner {
        if (address(feesCollector) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(feesCollector), uint256(-1));
        }

        feesCollector = _newCollector;

        if (address(_newCollector) != address(0) && address(token) != address(0)) {
            token.safeApprove(address(feesCollector), uint256(-1));
        }
    }

    function setFeesCalculator(IFeesCalculatorV3 _newCalculator) external override onlyOwner {
        feesCalculator = _newCalculator;
    }

    function setCVIOracle(ICVIOracleV3 _newOracle) external override onlyOwner {
        cviOracle = _newOracle;
    }

    function setRewards(IPositionRewardsV2 _newRewards) external override onlyOwner {
        rewards = _newRewards;
    }

    function setLiquidation(ILiquidationV2 _newLiquidation) external override onlyOwner {
        liquidation = _newLiquidation;
    }

    function setLatestOracleRoundId(uint80 _newOracleRoundId) external override onlyOwner {
        latestOracleRoundId = _newOracleRoundId;
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

    function setEmergencyWithdrawAllowed(bool _newEmergencyWithdrawAllowed) external override onlyOwner {
        emergencyWithdrawAllowed = _newEmergencyWithdrawAllowed;
    }

    function setStakingContractAddress(address _newStakingContractAddress) external override onlyOwner {
        stakingContractAddress = _newStakingContractAddress;
    }*/

    it('does not delete snapshot if an open occured on its block', async () => {
        const timestamp1 = await depositAndValidate(this.state, 2000, bob);
        const {timestamp: timestamp2} = await openPositionAndValidate(this.state, 100, alice);

        if (timestamp1 === timestamp2) {
            expect(await this.platform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(3 * 24 * 60 * 60);

        const {timestamp: timestamp4} = await openPositionAndValidate(this.state, 100, alice);
        const timestamp3 = await withdrawAndValidate(this.state, 1000, bob);

        if (timestamp3 === timestamp4) {
            expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {timestamp: timestamp5} = await openPositionAndValidate(this.state, 10, alice);
        const timestamp6 = await depositAndValidate(this.state, 1, bob);

        if (timestamp5 === timestamp6) {
            expect(await this.platform.cviSnapshots(timestamp6)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.platform.cviSnapshots(timestamp5)).to.be.bignumber.not.equal(new BN(0));
    });

    it('runs multiple actions on same blocks properly', async () => {
        await depositAndValidate(this.state, 2000, bob);
        await depositAndValidate(this.state, 1000, alice);
        await depositAndValidate(this.state, 3000, carol);

        await time.increase(3 * 24 * 60 * 60);

        await withdrawAndValidate(this.state, 100, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 200, alice);
        await depositAndValidate(this.state, 3000, carol);

        await time.increase(3 * 24 * 60 * 60);

        await closePositionAndValidate(this.state, positionUnits, alice);
        await withdrawAndValidate(this.state, 3000, carol);
        await depositAndValidate(this.state, 3000, carol);
    });

    it('runs deposit/withdraw actions properly with many positions opened', async () => {
        await depositAndValidate(this.state, 30000, bob);

        await time.increase(60);

        await openPositionAndValidate(this.state, 200, bob);
        await time.increase(1);
        await openPositionAndValidate(this.state, 200, alice);
        await time.increase(1);
        await openPositionAndValidate(this.state, 200, carol);

        await time.increase(1);

        await testMultipleAccountsDepositWithdraw(new BN(0), new BN(0), false);
    });

    it('reverts when liquidating non-existing position', async () => {
        await expectRevert(this.platform.liquidatePositions([alice], {from: dave}), 'No liquidatable position');
        await expectRevert(this.platform.liquidatePositions([bob, carol], {from: dave}), 'No liquidatable position');
        await expectRevert(this.platform.liquidatePositions([alice, bob, carol, dave], {from: dave}), 'No liquidatable position');
    });

    /*
    it('withdraws all lp tokens prevented due to collateral ratio restrictions', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: alice});

        await this.platform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});
        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let bobLPTokensBalance = await this.platform.balanceOf(bob);

        await time.increase(3 * SECONDS_PER_DAY);

        let tx = await this.platform.openPosition(toTokenAmount(1000), 5000, 1, {from: alice});
        let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
        let currPositionUnits = toTokenAmount(1000).mul(new BN(4)).mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(currTurbulence)).div(MAX_FEE);
        let feesAmount = toTokenAmount(1000).mul(OPEN_FEE_PERC.add(currTurbulence)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, toTokenAmount(1000), currPositionUnits, cviValueFromOracle, feesAmount);

        await expectRevert(this.platform.withdrawLPTokens(bobLPTokensBalance, {from: bob}), 'Collateral ratio broken');
    });

    it('Verify turbulence premium ', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: alice});

        await this.platform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});
        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let bobLPTokensBalance = await this.platform.balanceOf(bob);

        await time.increase( 1800 );
        await this.fakePriceProvider.setPrice(cviValue);

        await this.feeModel.updateSnapshots();

        let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
        expect(currTurbulence).to.be.bignumber.equal(TURBULENCE_PREMIUM_PERC_STEP);

        let tx = await this.platform.openPosition(toTokenAmount(1000), 5000, 1, {from: alice});
        let currPositionUnits = toTokenAmount(1000).mul(new BN(4)).mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(currTurbulence)).div(MAX_FEE);
        let feesAmount = toTokenAmount(1000).mul(OPEN_FEE_PERC.add(currTurbulence)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, toTokenAmount(1000), currPositionUnits, cviValueFromOracle, feesAmount);

        await time.increase( 1800 );
        await this.feeModel.updateSnapshots();
        await time.increase( 1800 );

        await this.fakePriceProvider.setPrice(cviValue);

        await time.increase( 1800 );
        await this.feeModel.updateSnapshots();

        currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
        expect(currTurbulence).to.be.bignumber.equal(new BN(0));

        let tx2 = await this.platform.openPosition(toTokenAmount(1000), 5000, 1, {from: alice});
        let currPositionUnits2 = currPositionUnits.add(toTokenAmount(1000).mul(new BN(4)).mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(currTurbulence)).div(MAX_FEE));
        let newFeesAmount = toTokenAmount(1000).mul(OPEN_FEE_PERC.add(currTurbulence)).div(MAX_FEE);
        verifyOpenPositionEvent(tx2.logs[0], alice, toTokenAmount(1000), currPositionUnits2, cviValueFromOracle, newFeesAmount);
    });

    it('opens first position properly for a high collateral ratio', async () => {
        let cviValue = toCVI(4000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: alice});

        let depositTokenAmount = toTokenAmount(5000);
        await this.platform.deposit(depositTokenAmount, toTokenAmount(48500), {from: bob});
        let feesTokens = depositTokenAmount.mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = depositTokenAmount.mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let openTokenAmount = toTokenAmount(1250);

        let currPositionUnits;
        let combineedBuyingPremiumPercent;
        let collateralRatio;
        let minPositionUnitsAmount;
        let previousPositionUnits = new BN(0);
        [currPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount] = await calculationsForBuyingPremium(cviValueFromOracle, openTokenAmount, previousPositionUnits);

        let tx = await this.platform.openPosition(openTokenAmount, 10000, 1, {from: alice});
        let feesAmount = openTokenAmount.mul(OPEN_FEE_PERC.add(combineedBuyingPremiumPercent)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, openTokenAmount, currPositionUnits, cviValueFromOracle, feesAmount);

        tokensInSharedPool = tokensInSharedPool.add(openTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.platform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal( toTokenAmount(50000).sub(openTokenAmount) );
    });

    it('opens two positions properly for a high collateral ratio', async () => {
        let cviValue = toCVI(4000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: alice});

        let depositTokenAmount = toTokenAmount(5000);
        await this.platform.deposit(depositTokenAmount, toTokenAmount(48500), {from: bob});
        let feesTokens = depositTokenAmount.mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = depositTokenAmount.mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let openTokenAmount = toTokenAmount(750);
        let currPositionUnits;
        let combineedBuyingPremiumPercent;
        let collateralRatio;
        let minPositionUnitsAmount;
        let previousPositionUnits = new BN(0);
        [currPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount] = await calculationsForBuyingPremium(cviValueFromOracle, openTokenAmount, previousPositionUnits);

        let tx = await this.platform.openPosition(openTokenAmount, 10000, 1, {from: alice});
        let feesAmount = openTokenAmount.mul(OPEN_FEE_PERC.add(combineedBuyingPremiumPercent)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, openTokenAmount, currPositionUnits, cviValueFromOracle, feesAmount);
        tokensInSharedPool = tokensInSharedPool.add(openTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));

        let newOpenTokenAmount = toTokenAmount(500);
        [currPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount] = await calculationsForBuyingPremium(cviValueFromOracle, newOpenTokenAmount, currPositionUnits);

        tx = await this.platform.openPosition(newOpenTokenAmount, 10000, 1, {from: alice});
        let newFeesAmount = newOpenTokenAmount.mul(OPEN_FEE_PERC.add(combineedBuyingPremiumPercent)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, newOpenTokenAmount, currPositionUnits, cviValueFromOracle, newFeesAmount);

        tokensInSharedPool = tokensInSharedPool.add(newOpenTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(newOpenTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.platform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal( toTokenAmount(50000).sub(openTokenAmount).sub(newOpenTokenAmount) );
    });*/
};

describe('ETHPlatform', () => {
    beforeEach(async () => {
        await beforeEachPlatform(true);
    });

    setPlatformTests(true);
});

describe('Platform', () => {
    beforeEach(async () => {
        await beforeEachPlatform(false);
    });

    setPlatformTests(false);
});

