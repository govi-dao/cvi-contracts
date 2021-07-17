const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const expect = chai.expect;

const {deployFullPlatform, deployPlatform, getContracts, setFeesCalculator, setRewards,
    setFeesCollector, setLiquidation, setStakingContractAddress} = require('./utils/DeployUtils');
const {createState, depositAndValidate, withdrawAndValidate, openPositionAndValidate, closePositionAndValidate, liquidateAndValidate,
    deposit, withdraw, withdrawLPTokens, openPosition, closePosition, calculateDepositAmounts, calculateWithdrawAmounts, calculateLiquidationCVI, calculateLiquidationDays} = require('./utils/PlatformUtils.js');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const { print } = require('./utils/DebugUtils');

const StakingRewards = contract.fromArtifact('USDTLPStakingRewards');
const FakeFeesCollector = contract.fromArtifact('FakeFeesCollector');

const [admin, bob, alice, carol, dave] = accounts;
const accountsUsed = [admin, bob, alice, carol];

const OPEN_FEE_PERC = new BN(15);
const LP_OPEN_FEE_PERC = new BN(15);
const DEPOSIT_FEE_PERC = new BN(0);
const WITHDRAW_FEE_PERC = new BN(0);
const TURBULENCE_PREMIUM_PERC_STEP = new BN(100);
const MAX_BUYING_PREMIUM_PERC = new BN(1000);
const MAX_FEE = new BN(10000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SECOND_INITIAL_RATE = toBN(1, 18);
const SECOND_ETH_INITIAL_RATE = toBN(1, 10);

const MARGINS_TO_TEST = [1, 2, 3, 4, 5, 6, 7, 8];

const leftTokensToWithdraw = async account => {
    const totalSupply = await this.platform.totalSupply();

    const totalBalance = this.isETH ? await balance.current(this.platform.address, 'wei') :
        await this.token.balanceOf(this.platform.address);

    const leftTokens = (await this.platform.balanceOf(account)).mul(totalBalance).div(totalSupply);

    return leftTokens;
};

const increaseSharedPool = async (account, amount) => {
    if (this.isETH) {
        await this.platform.increaseSharedPoolETH({from: account, value: amount});
    } else {
        await this.token.transfer(account, amount, {from: admin});
        await this.token.approve(this.platform.address, amount, {from: account});
        await this.platform.increaseSharedPool(amount, {from: account});
    }
};

const testMultipleAccountsDepositWithdraw = async (depositFee, withdrawFee, testEndBalance = true, addLiquidity = false) => {
    await this.feesCalculator.setDepositFee(depositFee, {from: admin});
    await this.feesCalculator.setWithdrawFee(withdrawFee, {from: admin});

    await depositAndValidate(this.state, 5000, bob);
    await depositAndValidate(this.state, 1000, alice);

    await time.increase(3 * 24 * 60 * 60);
    await this.fakePriceProvider.setPrice(toCVI(5000));

    await withdrawAndValidate(this.state, 1000, bob);
    await depositAndValidate(this.state, 3000, carol);

    if (addLiquidity) {
        await increaseSharedPool(dave, 5000);
        this.state.sharedPool = this.state.sharedPool.add(new BN(5000));
    }

    await withdrawAndValidate(this.state, 500, alice);

    await time.increase(3 * 24 * 60 * 60);
    await this.fakePriceProvider.setPrice(toCVI(5000));

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
    let positionUnitsAmountWithoutPremium = (openTokenAmount.sub(openPositionFee)).div(cviValue).mul(getContracts().maxCVIValue);
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

    let currPositionUnits = openTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(combineedBuyingPremiumPercent)).div(MAX_FEE).mul(getContracts().maxCVIValue).div(cviValue);
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
        it('reverts when calling deposit instead of depositETH', async() => {
            await expectRevert.unspecified(this.platform.deposit(toBN(1000, 18), new BN(0)));
        });

        it('reverts when calling openPosition instead of openPositionETH', async() => {
            await expectRevert.unspecified(this.platform.openPosition(toBN(1000, 18), getContracts().maxCVIValue, MAX_FEE, new BN(1)));
        });

        it('reverts when calling increaseSharedPool instead of increaseSharedPoolETH', async() => {
            await expectRevert.unspecified(this.platform.increaseSharedPool(toBN(1000, 18)));
        });
    }

    it('reverts when calling deposit too long after latest cvi oracle', async() => {
        await time.increase(5 * SECONDS_PER_DAY);
        await expectRevert(depositAndValidate(this.state, 1000, bob), 'Latest cvi too long ago');
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(this.state, 1000, bob);
    });

    it('reverts when calling open too long after latest cvi oracle', async() => {
        await depositAndValidate(this.state, 5000, bob);
        await time.increase(5 * SECONDS_PER_DAY);
        await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'Latest cvi too long ago');
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await openPositionAndValidate(this.state, 1000, alice);
    });

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
        this.feesCalculator.setTurbulenceUpdator(this.platform.address, {from: admin});

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

    it('handles increasing shared pool correctly', async () => {
        await this.platform.setAddressSpecificParameters(dave, true, false, true, {from: admin});
        await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, WITHDRAW_FEE_PERC, false, true);
    });

    it('reverts when trying to increase shared pool without permission', async () => {
        await expectRevert.unspecified(increaseSharedPool(bob, 1000)); // 'Not allowed'
        await expectRevert.unspecified(increaseSharedPool(alice, 1000)); // 'Not allowed'

        await this.platform.setAddressSpecificParameters(alice, true, false, true, {from: admin});

        await expectRevert.unspecified(increaseSharedPool(bob, 1000)); // 'Not allowed'
        await increaseSharedPool(alice, 1000);

        await this.platform.setAddressSpecificParameters(alice, true, false, false, {from: admin});

        await expectRevert.unspecified(increaseSharedPool(bob, 1000)); // 'Not allowed'
        await expectRevert.unspecified(increaseSharedPool(alice, 1000)); // 'Not allowed'
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

    it('lock time is not passed when staking/unstaking to staking contract address specified, and sets current time on withdraw', async () => {
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

        await setStakingContractAddress(staking.address, {from: admin});
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
        const withdrawTimestamp = await time.latest();

        expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);
        expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(withdrawTimestamp);
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
        await this.fakePriceProvider.setPrice(toCVI(5000));

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
        await setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await expectRevert(depositAndValidate(this.state, 5000, bob), 'revert');

        await setFeesCalculator(this.feesCalculator.address, {from: admin});
        await depositAndValidate(this.state, 5000, bob);
        await setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(1000, toBN(1, 40), bob), 'revert');
        await expectRevert(withdrawLPTokens(1000, bob), 'revert');

        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'revert');

        await setFeesCalculator(this.feesCalculator.address, {from: admin});
        await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await setFeesCalculator(ZERO_ADDRESS, {from: admin});
        await expectRevert(closePosition(1000, 5000, alice), 'revert');

        await setLiquidation(ZERO_ADDRESS, {from: admin});
        await expectRevert(this.platform.liquidatePositions([bob], {from: carol}), 'revert');

        await setFeesCalculator(this.feesCalculator.address, {from: admin});
        await setLiquidation(this.liquidation.address, {from: admin});

        await expectRevert(this.platform.liquidatePositions([bob], {from: carol}), 'No liquidatable position');
    });

    it('reverts when opening a position with zero tokens', async () => {
        await expectRevert(openPosition(0, 20000, alice), 'Tokens amount must be positive');
    });

    it('reverts when opening a position with a bad max CVI value', async () => {
        await expectRevert(openPosition(5000, 0, alice), 'Bad max CVI value');
        await expectRevert(openPosition(5000, getContracts().maxCVIValue.toNumber() + 1, alice), 'Bad max CVI value');
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

    it('calculates funding fees properly for different cvi values', async () => {
        await depositAndValidate(this.state, 100000, bob);

        const cviValues = [50, 50, 55, 75, 100, 125, 150, 180, 200];
        for (let cvi of cviValues) {
            await time.increase(3 * SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(cvi * 100));
            const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);
            await time.increase(3 * SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(cvi * 100));
            await closePositionAndValidate(this.state, positionUnits, alice);
            await time.increase(3 * SECONDS_PER_DAY);
        }
    });

    it('calcalates time turbulence with not enough deviation properly', async () => {
        await depositAndValidate(this.state, 40000, bob);

        // Cause turbulence
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5005));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5010));
        await time.increase(1);

        await openPositionAndValidate(this.state, 1000, alice);
    });

    it('calcalates time turbulence with more than enough deviation properly', async () => {
        await depositAndValidate(this.state, 40000, bob);

        // Cause turbulence
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(1);

        await openPositionAndValidate(this.state, 1000, alice);
    });

    it('calcalates time turbulence with nearly enough deviation properly', async () => {
        await depositAndValidate(this.state, 40000, bob);

        // Cause turbulence
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5300));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5400));
        await time.increase(1);

        await openPositionAndValidate(this.state, 1000, alice);
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
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(1);

        // Used to update snapshots
        await depositAndValidate(this.state, 1, bob);

        const turbulenceIndicatorPercent = TURBULENCE_PREMIUM_PERC_STEP.mul(new BN(3));

        await expectRevert(openPosition(5000, 7000, alice, turbulenceIndicatorPercent.add(LP_OPEN_FEE_PERC).sub(new BN(1))), 'Premium fee too high');
        await openPosition(5000, 7000, alice, turbulenceIndicatorPercent.add(LP_OPEN_FEE_PERC));
    });

    it('opens a position with no premium fee properly', async () => {
        await depositAndValidate(this.state, 40000, bob);

        // Cause turbulence
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5300));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5400));
        await time.increase(1);

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});
        await openPositionAndValidate(this.state, 1000, alice, true, true);
    });

    it('reverts when trying to open a position with no premium fee without privilage', async () => {
        await depositAndValidate(this.state, 40000, bob);

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, true, true));
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, true, true));

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, true, true));
        await openPositionAndValidate(this.state, 1000, alice, true, true);

        await this.platform.setAddressSpecificParameters(alice, true, false, false, {from: admin});

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, true, true));
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, true, true));
    });

    if (!isETH) {
        it('reverts when opening a position with too high position units', async () => {
            await expectRevert.unspecified(openPosition(toBN(374, 48), 5000, alice));
            await expectRevert.unspecified(openPosition(toBN(94, 48), 5000, alice));
        });

        it('reverts when merging a position with too high position units', async () => {
            await depositAndValidate(this.state, 5000, bob);
            await openPositionAndValidate(this.state, 1000, alice);

            await expectRevert.unspecified(openPosition(toBN(374, 48).sub(new BN(1000).div(new BN(4))), 5000, alice));
            await expectRevert.unspecified(openPosition(toBN(120, 48).sub(new BN(1000).div(new BN(4))), 5000, alice));
        });
    }

    it.skip('reverts if not enough liquidity expected after openning a position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.platform.address, toTokenAmount(50000), {from: alice});

    });

    it('reaches low enough gas values for deposit/withdraw actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));

        print('first deposit ever');
        await depositAndValidate(this.state, 4000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));

        print('second deposit');
        await depositAndValidate(this.state, 2000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));

        print('partial withdraw');
        await withdrawAndValidate(this.state, 2000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

        print('full withdraw');
        await withdrawAndValidate(this.state, 4000, bob);
    });

    it('reaches low enough gas values for open/close actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        print('first deposit ever');
        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));
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
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice);
        positionUnits = positionUnits.sub(positionUnits.div(new BN(2)));
        print('entire close');
        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await closePositionAndValidate(this.state, positionUnits, alice);

        print('partial withdraw');
        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await withdrawAndValidate(this.state, 10000, bob);
        print('second deposit');
        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await depositAndValidate(this.state, 10000, bob);
        print('full withdraw');
        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

        const tokensLeft = this.isETH ? await balance.current(this.platform.address, 'wei') :
            await this.token.balanceOf(this.platform.address);
        await withdrawAndValidate(this.state, tokensLeft, bob);
    });

    it('opens a position properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(this.state, 30000, bob);
        await time.increase(24 * 24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await openPositionAndValidate(this.state, 5000, alice);
    });

    for (let margin of MARGINS_TO_TEST) {
        it(`opens a margined position properly with premium fee (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            console.log('deposit: ',  5000 * margin - 5000 * (margin - 1));
            await depositAndValidate(this.state, 5000 * margin * 2 - 5000 * (margin - 1) - 5000, bob);
            await openPositionAndValidate(this.state, 5000, alice, true, false, margin);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`opens a margined position properly without premium fee (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            console.log('deposit: ',  (5000 * margin - 5000 * (margin - 1)) * 2);
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            await openPositionAndValidate(this.state, 5000, alice, true, false, margin);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`merges a margined position properly with premium fee (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            console.log('deposit: ',  (5000 * margin - 5000 * (margin - 1)) * 2);
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            await openPositionAndValidate(this.state, 5000, alice, true, false, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(12000));
            await openPositionAndValidate(this.state, 2500, alice, true, false, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await openPositionAndValidate(this.state, 2000, alice, true, false, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(13000));
            await openPositionAndValidate(this.state, 500, alice, true, false, margin);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`closes a margined position properly, cvi rises (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            const {positionUnits} = await openPositionAndValidate(this.state, 5000, alice, true, false, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(13000));
            await closePositionAndValidate(this.state, positionUnits, alice);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`closes a margined position properly, cvi rises (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            const {positionUnits} = await openPositionAndValidate(this.state, 5000, alice, true, false, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(13000));
            await closePositionAndValidate(this.state, positionUnits, alice);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`closes a margined position properly, cvi drops (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            const {positionUnits} = await openPositionAndValidate(this.state, 5000, alice, true, false, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await closePositionAndValidate(this.state, positionUnits, alice);
        });
    }

    const printCollateral = async () => {
        //console.log('collateral 1', this.state.totalPositionUnits.mul(toBN(1, 10)).div(this.state.sharedPool).toString());
        //console.log('total positions', (await this.platform.totalPositionUnitsAmount()).toString());
        //console.log('total leveraged', (await this.platform.totalLeveragedTokensAmount()).toString());
        //console.log('collateral', (await this.platform.totalPositionUnitsAmount()).mul(toBN(1, 10)).div(await this.platform.totalLeveragedTokensAmount()).toString());
    };

    it('opens multiple margined positioned together with different margins, including premium fee', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));
        await depositAndValidate(this.state, 100000, bob);
        await openPositionAndValidate(this.state, 5000, alice, true, false, 1);
        await printCollateral();
        await openPositionAndValidate(this.state, 15000, dave, true, false, 8);
        await printCollateral();
        await openPositionAndValidate(this.state, 15000, carol, true, false, 4);
        await printCollateral();
    });

    it.skip('opens and closes margined positions', async () => {

    });

    it.skip('liquidates an (also) margined position properly', async () => {

    });

    it.skip('opens and closes margined positions including liquidation and premium fee', async () => {

    });

    it.skip('merges a margined position properly', async () => {

    });

    it.skip('calculates premium fee correctly by collateral ratio', async () => {

    });

    it.skip('calculates premium fee correctly by collateral ratio in margined positions', async () => {

    });

    for (let margin of MARGINS_TO_TEST) {
        it(`liquidates position due to cvi drop (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, 50000, bob);
            await openPositionAndValidate(this.state, 1000, alice, true, false, margin);

            const liquidationCVI = await calculateLiquidationCVI(this.state, alice);

            await this.fakePriceProvider.setPrice(toCVI(liquidationCVI));
            await liquidateAndValidate(this.state, alice, carol, true);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`does not liquidates position due to nearly enough cvi drop (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, 50000, bob);
            await openPositionAndValidate(this.state, 1000, alice, true, false, margin);

            const liquidationCVI = (await calculateLiquidationCVI(this.state, alice)).add(new BN(100));

            await this.fakePriceProvider.setPrice(toCVI(liquidationCVI));
            await liquidateAndValidate(this.state, alice, carol, false);
        });
    }

    for (let margin of [1]) {
        it(`liquidates position due to funding fees (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toTokenAmount(50000), bob);
            await openPositionAndValidate(this.state, toTokenAmount(1000), alice, true, false, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000);

            await time.increase(daysToLiquidation.sub(new BN(1)).mul(new BN(3600 * 24)));

            await this.fakePriceProvider.setPrice(toCVI(10000));
            await liquidateAndValidate(this.state, alice, carol, false);

            await time.increase(new BN(3600 * 24));
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await liquidateAndValidate(this.state, alice, carol, true);
        });
    }

    it('LPs dont lose from margin debt calculation', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(this.state, 5000 * 2 * 2, bob);
        await depositAndValidate(this.state, 5000 * 2 * 2, dave);
        await openPositionAndValidate(this.state, 5000, alice, 2);
        await withdrawAndValidate(this.state, 5000 * 2 * 2, bob);
        await withdrawAndValidate(this.state, 5000 * 2 * 2, dave);
    });

    it('opens multiple positions and closes them, but gets reward correctly on last open and merge afterwards', async () => {
        await depositAndValidate(this.state, 60000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 5000, alice);
        await time.increase(SECONDS_PER_DAY * 2);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await closePositionAndValidate(this.state, positionUnits1, alice);
        const {positionUnits: positionUnits2} = await openPositionAndValidate(this.state, 4000, alice);
        await time.increase(SECONDS_PER_DAY * 2);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await closePositionAndValidate(this.state, positionUnits2, alice);

        await openPositionAndValidate(this.state, 3000, alice);
        await openPositionAndValidate(this.state, 1000, alice);
    });

    it('opens a position properly with no rewards', async () => {
        await setRewards(ZERO_ADDRESS, {from: admin});

        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(this.state, 30000, bob);
        await time.increase(24 * 24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await openPositionAndValidate(this.state, 5000, alice, false);
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

    it('cvi oracle truncates to max value', async () => {
        const cvi = getContracts().maxCVIValue.toNumber() + 1;
        await this.fakePriceProvider.setPrice(toCVI(cvi));

        expect((await this.fakeOracle.getCVILatestRoundData()).cviValue).to.be.bignumber.equal(getContracts().maxCVIValue);
        //expect((await getContracts().fakeOracleV2.getCVILatestRoundData()).cviValue).to.be.bignumber.equal(getContracts().maxCVIValue);
        //expect((await getContracts().fakeOracleV1.getCVILatestRoundData()).cviValue).to.be.bignumber.equal(getContracts().maxCVIValue);
    });

    it('reverts when trying to close too many positional units', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(this.platform.closePosition(1, 5000, {from: alice}), 'Not enough opened position units');
        await depositAndValidate(this.state, toTokenAmount(5), bob);
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

        await expectRevert.unspecified(closePosition(0, 5000, alice));
    });

    it('reverts when closing a position with an invalid min CVI value', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(positionUnits, 0, alice), 'Bad min CVI value');
        await expectRevert(closePosition(positionUnits, getContracts().maxCVIValue.toNumber() + 1, alice), 'Bad min CVI value');

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

    it('updates total funding fee back to zero instead of overflowing when rounding, if position units updates to zero', async () => {
        await depositAndValidate(this.state, 5000, bob);

        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));

        // Total funding fees grow here
        await depositAndValidate(this.state, 1000, bob);
        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it('updates total funding fee back to zero instead of overflowing when rounding on merge, if position units updates to zero', async () => {
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await depositAndValidate(this.state, 5000, bob);

        await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(2 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(10000));

        // Total funding fees grow here
        const {positionUnits} = await openPositionAndValidate(this.state, 5, alice);
        /*await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(10000));

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(this.state, positionUnits, alice);*/
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
        this.fakePriceProvider.setPrice(toCVI(5000));

        const timestamp2 = await withdrawAndValidate(this.state, 1000, bob);

        await testSnapshot(timestamp1, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {positionUnits, timestamp: timestamp3} = await openPositionAndValidate(this.state, 100, alice);
        await testSnapshot(timestamp2, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(24 * 60 * 60);
        this.fakePriceProvider.setPrice(toCVI(5000));

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

    it('sets can purge snapshots properly', async () => {
        const beforeEmergencyWithdrawAllowed = await this.platform.emergencyWithdrawAllowed();
        await this.platform.setEmergencyParameters(beforeEmergencyWithdrawAllowed, false, {from: admin});
        const afterEmergencyWithdrawAllowed = await this.platform.emergencyWithdrawAllowed();
        expect(beforeEmergencyWithdrawAllowed).to.equal(afterEmergencyWithdrawAllowed);

        await testLastSnapshotRemove(false);
    });

    it('reverts when opening with a leverage higher than max', async () => {
        await this.platform.setMaxAllowedLeverage(1, {from: admin});
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

        await setFeesCollector(anotherFakeFeesCollector.address, {from: admin});
        this.state.totalFeesSent = new BN(0);

        await openPositionAndValidate(this.state, 1000, alice);
        expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.not.equal(new BN(0));
        expect(await getFeesBalance(this.fakeFeesCollector)).to.be.bignumber.equal(feesCollectorBalance);
    });

    it('sets maxLeverage properly', async () => {
        await this.platform.setMaxAllowedLeverage(1, {from: admin});

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
        this.fakePriceProvider.setPrice(toCVI(5000));

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
        this.fakePriceProvider.setPrice(toCVI(5000));

        await withdrawAndValidate(this.state, 100, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 200, alice);
        await depositAndValidate(this.state, 3000, carol);

        await time.increase(3 * 24 * 60 * 60);
        this.fakePriceProvider.setPrice(toCVI(5000));

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

    it('reverts when action attempted during lockup period - buyers', async () => {
        await this.platform.setLockupPeriods(240, SECONDS_PER_DAY, {from: admin});

        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(SECONDS_PER_DAY - 10);
        await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice), 'Position locked');
        await time.increase(10);
        await closePositionAndValidate(this.state, positionUnits1, alice);
    });

    it('does not revert when in buyers lockup period but account set as not locked', async () => {
        await depositAndValidate(this.state, 20000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice);
        const {positionUnits: positionUnitsCarol} = await openPositionAndValidate(this.state, 1000, carol);
        await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice), 'Position locked');
        await expectRevert(closePositionAndValidate(this.state, positionUnitsCarol, carol), 'Position locked');
        await this.platform.setAddressSpecificParameters(alice, false, false, false, {from: admin});
        await expectRevert(closePositionAndValidate(this.state, positionUnitsCarol, carol), 'Position locked');
        await closePosition(positionUnits1, 5000, alice);

        await this.platform.setAddressSpecificParameters(alice, true, false, false, {from: admin});

        if (!getContracts().isETH) {
            await getContracts().token.transfer(alice, 1000, {from: admin});
            await getContracts().token.approve(getContracts().platform.address, 1000, {from: alice});
        }
        await openPosition(1000, 20000, alice);

        await expectRevert(closePosition(1, 5000, alice), 'Position locked');
    });

    it('reverts when action attempted during lockup period - LPs', async () => {
        await this.platform.setLockupPeriods(240, 120, {from: admin});

        await depositAndValidate(this.state, 1000, bob);
        await time.increase(200);
        const bobLPTokensBalance = await this.platform.balanceOf(bob);
        await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance), 'Funds are locked');
        await time.increase(40);
        await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance);
        expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0));
    });

    it('reverts when attempting to execute an ownable function by non admin user', async () => {
        const expectedError = 'Ownable: caller is not the owner';

        // Tests setSubContracts
        await expectRevert(setFeesCalculator(this.feesCalculator.address, {from: bob}), expectedError);

        await expectRevert(this.platform.setEmergencyParameters(false, false, {from: alice}), expectedError);
        await expectRevert(this.platform.setMaxAllowedLeverage(new BN(8), {from: dave}), expectedError);
        await expectRevert(this.platform.setLockupPeriods(60 * 60 * 24, 24 * 60 * 60, {from: dave}), expectedError);
        await expectRevert(this.platform.setAddressSpecificParameters(bob, false, true, true, {from: carol}), expectedError);
        await expectRevert(this.platform.setLatestOracleRoundId(2, {from: dave}), expectedError);

        const staking = await StakingRewards.new(admin, admin, this.cviToken.address, this.platform.address);
        await expectRevert(setStakingContractAddress(staking.address, {from: bob}), expectedError);
    });

    it('position balance calculated properly', async () => {
        await depositAndValidate(this.state, toBN(30000, 6), bob);
        await openPositionAndValidate(this.state, toBN(2000, 6), alice);

        const balance1 = (await getContracts().platform.calculatePositionBalance(alice))[0];
        console.log('balance1', balance1.toString());

        await this.fakePriceProvider.setPrice(toCVI(10000));

        const balance2 = (await getContracts().platform.calculatePositionBalance(alice))[0];
        console.log('balance2', balance2.toString());

        await time.increase(24 * 60 * 60);

        await this.fakePriceProvider.setPrice(toCVI(5000));

        const balance3 = (await getContracts().platform.calculatePositionBalance(alice))[0];
        console.log('balance3', balance3.toString());
    });
};

describe.skip('ETHPlatform', () => {
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

