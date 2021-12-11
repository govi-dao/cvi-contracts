const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');

const chai = require('chai');
const expect = chai.expect;

const { MARGINS_TO_TEST } = require('./utils/TestUtils');

const {deployFullPlatform, deployPlatform, getContracts, getAccounts, setFeesCalculator, setRewards,
    setFeesCollector, setLiquidation, setStakingContractAddress, ZERO_ADDRESS} = require('./utils/DeployUtils');

const {createState, depositAndValidate, withdrawAndValidate, openPositionAndValidate, closePositionAndValidate, 
    liquidateAndValidate, MAX_FEE_DELTA_COLLATERAL, deposit, withdraw, withdrawLPTokens, openPosition, closePosition, 
    calculateBalance, calculateFundingFeesWithSnapshot, calculateFundingFeesWithTwoSnapshots, 
    calculateDepositAmounts, calculateWithdrawAmounts, calculatePositionBalance, calculateFundingFees, calculateMarginDebt,
    calculateLiquidationCVI, calculateLiquidationDays, updateSnapshots, getAccountBalance, getFeesBalance, GAS_PRICE,
    NO_FEES, ONLY_COLLATERAL_PREMIUM} = require('./utils/PlatformUtils.js');

const { TIME_WINDOW, FEE_TIME_WINDOW, MAX_VOLUME_FEE, MAX_CLOSE_VOLUME_FEE } = require('./utils/FeesUtils.js');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const { print } = require('./utils/DebugUtils');

const StakingRewards = artifacts.require('USDTLPStakingRewards');
const FakeFeesCollector = artifacts.require('FakeFeesCollector');

// Max gas values allowed
const MAX_GAS_FIRST_DEPOSIT_EVER = toBN(250000);
const MAX_GAS_FIRST_OPEN_EVER = toBN(300000);
const MAX_GAS_OPEN = toBN(230000);
const MAX_GAS_MERGE = toBN(220000);
const MAX_GAS_PARTIAL_CLOSE = toBN(250000);
const MAX_GAS_FULL_CLOSE = toBN(210000);
const MAX_GAS_DEPOSIT = toBN(200000);
const MAX_GAS_PARTIAL_WITHDRAW = toBN(200000);
const MAX_GAS_FULL_WITHDRAW = toBN(180000);

const OPEN_FEE_PERC = new BN(15);
const LP_OPEN_FEE_PERC = new BN(15);
const DEPOSIT_FEE_PERC = new BN(0);
const WITHDRAW_FEE_PERC = new BN(0);
const TURBULENCE_PREMIUM_PERC_STEP = new BN(100);
const MAX_BUYING_PREMIUM_PERC = new BN(1000);
const MAX_FEE = new BN(10000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);
const SECONDS_PER_HOUR = new BN(60 * 60);

const SECOND_INITIAL_RATE = toBN(1, 18);
const SECOND_ETH_INITIAL_RATE = toBN(1, 10);

let admin, bob, alice, carol, dave, eve, frank;
let accountsUsed;

const setAccounts = async () => {
    [admin, bob, alice, carol, dave, eve, frank] = await getAccounts();
    accountsUsed = [admin, bob, alice, carol, dave, eve, frank];
};

const leftTokensToWithdraw = async account => {
    const totalSupply = await this.platform.totalSupply();

    const totalBalance = await getAccountBalance(this.platform.address);

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

const getPositionAmountByDeltaCollateral = (deltaCollateral, deposit, cviValue) => {
    // (position * max / cvi) / (deposit + position) = deltaCollateral / max_fee
    // position * max / cvi = (deltaCollateral / max_fee) * (deposit + position) = (deltaCollateral / max_fee) * deposit + (deltaCollateral / max_fee) * position
    // position * (max / cvi - deltaCollateral / max_fee) = (deltaCollateral / max_fee) * deposit
    // position = ((deltaCollateral / max_fee) * deposit) / ((max * max_fee - deltaCollateral * cvi) / (cvi * max_fee))
    // position = (deltaCollateral / max_fee * deposit) * (cvi * max_fee) / (max * max_fee - deltaCollateral * cvi)
    // position = (deltaCollateral * deposit * cvi) / (max * max_fee - deltaCollateral * cvi)
    return deposit.mul(toBN(deltaCollateral)).mul(toBN(cviValue)).div(MAX_FEE.mul(getContracts().maxCVIValue).sub(toBN(deltaCollateral).mul(toBN(cviValue))));
};

const verifyNoVolumeFeeScenario = async (openPositionsNum, openPositionDeltaCollateral, depositAmount, timeBetweenOpens) => {
    const cviValue = 10000;
    await this.fakePriceProvider.setPrice(toCVI(cviValue));

    const deposit = new BN(depositAmount);
    await depositAndValidate(this.state, deposit, bob);

    const position = getPositionAmountByDeltaCollateral(openPositionDeltaCollateral, deposit, cviValue);

    for (let i = 0; i < openPositionsNum; i ++) {
        const { volumeFeePercentage } = await openPositionAndValidate(this.state, position, alice);
        expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0));

        if (timeBetweenOpens !== undefined) {
            await time.increase(timeBetweenOpens);
        }

        await this.fakePriceProvider.setPrice(toCVI(cviValue));
    }
};

const verifyNoCloseVolumeFeeScenario = async (closePositionsNum, closePositionDeltaCollateral, depositAmount, timeBetweenCloses) => {
    const cviValue = 10000;
    await this.fakePriceProvider.setPrice(toCVI(cviValue));

    const deposit = new BN(depositAmount);
    await depositAndValidate(this.state, deposit, bob);

    const position = getPositionAmountByDeltaCollateral(closePositionDeltaCollateral, deposit, cviValue);

    const allPositionUnits = [];
    let lastPositionUnits = toBN(0);
    for (let i = 0; i < closePositionsNum; i ++) {
        const { positionUnits } = await openPositionAndValidate(this.state, position, alice);
        allPositionUnits.push(positionUnits.sub(lastPositionUnits));
        lastPositionUnits = positionUnits;
    }

    await time.increase(SECONDS_PER_DAY.mul(toBN(3)));

    for (let i = 0; i < closePositionsNum; i ++) {
        const { volumeFeePercentage } = await closePositionAndValidate(this.state, allPositionUnits[i], alice);
        expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0));

        if (timeBetweenCloses !== undefined) {
            await time.increase(timeBetweenCloses);
        }
    }
};

const beforeEachPlatform = async isETH => {
    await setAccounts();
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
        const {depositTimestamp} = await depositAndValidate(this.state, 5000, bob);

        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(24 * 60 * 60)));
        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60 - 2)));
        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60)));

        await withdraw(toBN(1), toTokenAmount(1000000), bob);
    });

    it('reverts when withdrawing a zero amount', async () => {
        await expectRevert.unspecified(withdraw(toBN(0), toTokenAmount(1000000), bob));
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

    it('reverts when withdrawing funds that are holding current positions (broken collateral)', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));

        await depositAndValidate(this.state, toTokenAmount(2), bob);
        await depositAndValidate(this.state, toTokenAmount(1), carol);

        await time.increase(3 * 24 * 60 * 60);

        await this.fakePriceProvider.setPrice(toCVI(11000));
        await openPositionAndValidate(this.state, toTokenAmount(3), alice);

        // Note that there is quite a high premium + volume fee, so need to withdraw quite a lot to break collalteral
        await expectRevert(withdrawAndValidate(this.state, toTokenAmount(1).div(toBN(3)), bob), 'Collateral ratio broken');
        await expectRevert(withdrawAndValidate(this.state, toTokenAmount(1).div(toBN(3)), carol), 'Collateral ratio broken');
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
        this.feesCalculator.setStateUpdator(this.platform.address, {from: admin});

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
        const {depositTimestamp: timestamp} = await depositAndValidate(this.state, 1000, bob);
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
        const {depositTimestamp: timestamp} = await depositAndValidate(this.state, 1000, bob);
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
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await depositAndValidate(this.state, toTokenAmount(5), bob);

        await openPositionAndValidate(this.state, toTokenAmount(1), alice);

        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(10000));

        await expectRevert(withdrawAndValidate(this.state, toTokenAmount(5), bob), 'Collateral ratio broken');
        await this.platform.setEmergencyParameters(true, true, {from: admin});
        await withdrawAndValidate(this.state, toTokenAmount(3), bob);

        await depositAndValidate(this.state, toTokenAmount(5), bob);

        await expectRevert(withdrawAndValidate(this.state, toTokenAmount(5), bob), 'Funds are locked');

        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(10000));

        await this.platform.setEmergencyParameters(false, true, {from: admin});
        await withdrawAndValidate(this.state, toTokenAmount(5), bob);
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

        await expectRevert(this.platform.liquidatePositions([bob], {from: carol}), 'No liquidable position');
    });

    it('reverts when opening a position with zero tokens', async () => {
        await expectRevert.unspecified(openPosition(0, 20000, alice));
    });

    it('reverts when opening a position with a bad max CVI value', async () => {
        await expectRevert.unspecified(openPosition(5000, 0, alice));
        await expectRevert.unspecified(openPosition(5000, getContracts().maxCVIValue.toNumber() + 1, alice));
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
        await depositAndValidate(this.state, 800000, bob);

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

    it('opens a position with no volume fee properly (but with collateral fee)', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));
        await depositAndValidate(this.state, toTokenAmount(1), bob);

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});

        // Cause volume fee by moving collateral to 100% (and thus premium fee as well)
        const { volumeFeePercentage, premiumPercentage } = await openPositionAndValidate(this.state, toTokenAmount(1), alice, true, ONLY_COLLATERAL_PREMIUM);

        expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0));
        expect(premiumPercentage).to.be.bignumber.above(toBN(0));
    });

    it('closes a position with no volume fee properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));
        await depositAndValidate(this.state, toTokenAmount(1), bob);

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});

        const {positionUnits} = await openPositionAndValidate(this.state, toTokenAmount(1), alice, true, ONLY_COLLATERAL_PREMIUM);
        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));
        const {volumeFeePercentage} = await closePositionAndValidate(this.state, positionUnits, alice, undefined, undefined, true);

        expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0));
    });

    it('opens a position with no volume fee (adjusted timestamp is before h1)', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW)).div(toBN(2)).div(TIME_WINDOW), deposit, cviValue);

        await openPositionAndValidate(this.state, position, alice);
        const now = await time.latest();
        expect(await this.feesCalculator.adjustedVolumeTimestamp()).to.be.bignumber.at.most(now.sub(FEE_TIME_WINDOW));
        expect(await this.feesCalculator.adjustedVolumeTimestamp()).to.be.bignumber.at.least(now.sub(TIME_WINDOW));
    });

    it('closes a position with no volume fee (adjusted timestamp is before h1)', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW)).div(toBN(2)).div(TIME_WINDOW), deposit, cviValue);

        const {positionUnits} = await openPositionAndValidate(this.state, position, alice);
        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));
        await closePositionAndValidate(this.state, positionUnits, alice);

        const now = await time.latest();
        expect(await this.feesCalculator.closeAdjustedVolumeTimestamp()).to.be.bignumber.at.most(now.sub(FEE_TIME_WINDOW));
        expect(await this.feesCalculator.closeAdjustedVolumeTimestamp()).to.be.bignumber.at.least(now.sub(TIME_WINDOW));
    });

    it('opens a position with some volume fee (adjusted timestamp is after h1 but before now)', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW.div(toBN(2)))).div(TIME_WINDOW), deposit, cviValue);

        await openPositionAndValidate(this.state, position, alice);
        const now = await time.latest();
        expect(await this.feesCalculator.adjustedVolumeTimestamp()).to.be.bignumber.at.most(now);
        expect(await this.feesCalculator.adjustedVolumeTimestamp()).to.be.bignumber.at.least(now.sub(FEE_TIME_WINDOW));
    });

    it('closes a position with some volume fee (adjusted timestamp is after h1 but before now)', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW.div(toBN(2)))).div(TIME_WINDOW), deposit, cviValue);

        const {positionUnits} = await openPositionAndValidate(this.state, position, alice);
        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));
        await closePositionAndValidate(this.state, positionUnits, alice);

        const now = await time.latest();
        expect(await this.feesCalculator.closeAdjustedVolumeTimestamp()).to.be.bignumber.at.most(now);
        expect(await this.feesCalculator.closeAdjustedVolumeTimestamp()).to.be.bignumber.at.least(now.sub(FEE_TIME_WINDOW));
    });

    it('opens a position with max volume fee (adjusted timestamp is after now)', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(toBN(2)), deposit, cviValue);

        await openPositionAndValidate(this.state, position, alice);
        const now = await time.latest();
        expect(await this.feesCalculator.adjustedVolumeTimestamp()).to.be.bignumber.equal(now);
    });

    it('closes a position with max volume fee (adjusted timestamp is after now)', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(toBN(2)), deposit, cviValue);

        const {positionUnits} = await openPositionAndValidate(this.state, position, alice);
        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));
        await closePositionAndValidate(this.state, positionUnits, alice);

        const now = await time.latest();
        expect(await this.feesCalculator.closeAdjustedVolumeTimestamp()).to.be.bignumber.equal(now);
    });

    it('calculates volume fee correctly if fee at h1 is not zero', async () => {
        const newMidFee = toBN(30);
        this.feesCalculator.setMidVolumeFee(newMidFee);

        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = toTokenAmount(40);
        await depositAndValidate(this.state, deposit, bob);

        let position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW)).div(toBN(2)).div(TIME_WINDOW), deposit, cviValue);
        await openPositionAndValidate(this.state, position, alice, true, false, 1, toBN(newMidFee));

        await time.increase(SECONDS_PER_HOUR.mul(toBN(2)));

        position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW.div(toBN(2)))).div(TIME_WINDOW), deposit, cviValue);
        await openPositionAndValidate(this.state, position, alice, true, false, 1, toBN(newMidFee));
    });

    it('calculates close volume fee correctly if fee at h1 is not zero', async () => {
        const newMidFee = toBN(30);
        this.feesCalculator.setCloseMidVolumeFee(newMidFee);

        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = toTokenAmount(40);
        await depositAndValidate(this.state, deposit, bob);

        let position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW)).div(toBN(2)).div(TIME_WINDOW), deposit, cviValue);
        const {positionUnits} = await openPositionAndValidate(this.state, position, alice);
        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));
        await closePositionAndValidate(this.state, positionUnits, alice, undefined, undefined, undefined, newMidFee);

        await this.fakePriceProvider.setPrice(toCVI(cviValue));
        position = getPositionAmountByDeltaCollateral(MAX_FEE_DELTA_COLLATERAL.mul(TIME_WINDOW.sub(FEE_TIME_WINDOW.div(toBN(2)))).div(TIME_WINDOW), deposit, cviValue);
        const {positionUnits: positionUnits2} = await openPositionAndValidate(this.state, position, alice);
        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));
        await closePositionAndValidate(this.state, positionUnits, alice, undefined, undefined, undefined, newMidFee);
    });

    it('grows volume fee by massive opening of positions one after the other', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = toTokenAmount(40);
        await depositAndValidate(this.state, deposit, bob);

        const position = FEE_TIME_WINDOW.div(new BN(4)).mul(MAX_FEE_DELTA_COLLATERAL).mul(deposit).div(TIME_WINDOW).div(MAX_FEE).mul(toBN(cviValue)).div(getContracts().maxCVIValue);

        let lastAdjustedTimestamp = await this.feesCalculator.adjustedVolumeTimestamp();
        let lastVolumeFeePercentage = new BN(0);

        for (let i = 0; i < 10; i++) {
            const { volumeFeePercentage } = await openPositionAndValidate(this.state, position, alice);
            const currAdjustedTimestamp = await this.feesCalculator.adjustedVolumeTimestamp();
            expect(currAdjustedTimestamp).to.be.bignumber.above(lastAdjustedTimestamp);
            expect(volumeFeePercentage).to.be.bignumber.at.least(lastVolumeFeePercentage);
            lastAdjustedTimestamp = currAdjustedTimestamp;
            lastVolumeFeePercentage = volumeFeePercentage;
        }
    });

    it('grows close volume fee by massive closing of positions one after the other', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = toTokenAmount(40);
        await depositAndValidate(this.state, deposit, bob);

        const position = FEE_TIME_WINDOW.div(new BN(4)).mul(MAX_FEE_DELTA_COLLATERAL).mul(deposit).div(TIME_WINDOW).div(MAX_FEE).mul(toBN(cviValue)).div(getContracts().maxCVIValue);

        let positionUnits;
        for (let i = 0; i < 10; i++) {
            positionUnits = (await openPositionAndValidate(this.state, position, alice)).positionUnits;
        }

        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));

        let lastAdjustedTimestamp = await this.feesCalculator.closeAdjustedVolumeTimestamp();
        let lastVolumeFeePercentage = new BN(0);

        for (let i = 0; i < 10; i++) {
            const { volumeFeePercentage } = await closePositionAndValidate(this.state, positionUnits.div(toBN(10)), alice);
            const currAdjustedTimestamp = await this.feesCalculator.closeAdjustedVolumeTimestamp();
            expect(currAdjustedTimestamp).to.be.bignumber.above(lastAdjustedTimestamp);
            expect(volumeFeePercentage).to.be.bignumber.at.least(lastVolumeFeePercentage);
            lastAdjustedTimestamp = currAdjustedTimestamp;
            lastVolumeFeePercentage = volumeFeePercentage;
        }
    });

    it('zeroes volume fee if waiting until time window is over', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = TIME_WINDOW.mul(new BN(2)).mul(MAX_FEE_DELTA_COLLATERAL).mul(deposit).div(TIME_WINDOW).div(MAX_FEE).mul(toBN(cviValue)).div(getContracts().maxCVIValue);

        await openPositionAndValidate(this.state, position, alice);
        
        await time.increase(TIME_WINDOW);

        const positionNoFees = TIME_WINDOW.sub(FEE_TIME_WINDOW).mul(MAX_FEE_DELTA_COLLATERAL).mul(deposit).div(TIME_WINDOW).div(MAX_FEE).mul(toBN(cviValue)).div(getContracts().maxCVIValue);
        const { volumeFeePercentage } = await openPositionAndValidate(this.state, positionNoFees, alice);
        expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0));
    });

    it('zeroes close volume fee if waiting until time window is over', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const deposit = new BN(40000);
        await depositAndValidate(this.state, deposit, bob);

        const position = TIME_WINDOW.mul(new BN(2)).mul(MAX_FEE_DELTA_COLLATERAL).mul(deposit).div(TIME_WINDOW).div(MAX_FEE).mul(toBN(cviValue)).div(getContracts().maxCVIValue);

        const {positionUnits} = await openPositionAndValidate(this.state, position, alice);

        const positionNoFees = TIME_WINDOW.sub(FEE_TIME_WINDOW).mul(MAX_FEE_DELTA_COLLATERAL).mul(deposit).div(TIME_WINDOW).div(MAX_FEE).mul(toBN(cviValue)).div(getContracts().maxCVIValue);

        const {positionUnits: positionUnitsCarol} = await openPositionAndValidate(this.state, positionNoFees, carol);        

        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));

        await closePositionAndValidate(this.state, positionUnits, alice);
        
        await time.increase(TIME_WINDOW);

        const {volumeFeePercentage} = await closePositionAndValidate(this.state, positionUnitsCarol, carol);
        expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0));
    });

    it('does not charge volume fee on regular demand (big trades)', async () => {
        await verifyNoVolumeFeeScenario(8, 100, 40000, SECONDS_PER_HOUR);
    });

    it('does not charge volume fee on regular demand (small trades)', async () => {
        await verifyNoVolumeFeeScenario(16, 50, 40000, SECONDS_PER_HOUR.div(toBN(2)));
    });

    it('does not charge volume fee on regular demand (small successive trades)', async () => {
        await verifyNoVolumeFeeScenario(10, 10, 40000);
    });

    it('does not charge close volume fee on regular demand (big trades)', async () => {
        await verifyNoCloseVolumeFeeScenario(8, 100, 40000, SECONDS_PER_HOUR);
    });

    it('does not charge close volume fee on regular demand (small trades)', async () => {
        await verifyNoCloseVolumeFeeScenario(16, 50, 40000, SECONDS_PER_HOUR.div(toBN(2)));
    });

    it('does not charge close volume fee on regular demand (small successive trades)', async () => {
        await verifyNoCloseVolumeFeeScenario(10, 10, 40000);
    });

    it('does not reduce volume fee on many small trades attack', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = new BN(400000);
        await depositAndValidate(this.state, deposit, bob);

        const bigPosition = getPositionAmountByDeltaCollateral(301, deposit, cviValue);

        const { volumeFeePercentage: bigVolumeFeePercentage } = await openPositionAndValidate(this.state, bigPosition, alice);
        const volumeFeePercentage = MAX_VOLUME_FEE.mul(toBN(300).sub(toBN(200))).div(toBN(400).sub(toBN(200)));
        expect(bigVolumeFeePercentage).to.be.bignumber.at.least(volumeFeePercentage);

        for (let i = 0; i < 20; i ++) {
            const epsilonPosition = getPositionAmountByDeltaCollateral(1, deposit, cviValue);

            await openPositionAndValidate(this.state, epsilonPosition, alice);
        }

        const mediumPosition = getPositionAmountByDeltaCollateral(50, deposit, cviValue);

        const { volumeFeePercentage: mediumVolumeFeePercentage } = await openPositionAndValidate(this.state, mediumPosition, alice);
        expect(mediumVolumeFeePercentage).to.be.bignumber.at.least(MAX_VOLUME_FEE.div(volumeFeePercentage));
    });

    it('does not reduce close volume fee on many small trades attack', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = new BN(400000);
        await depositAndValidate(this.state, deposit, bob);

        const allPositionUnits = [];
        let lastPositionUnits = toBN(0);
        let positionUnits;

        const mediumPosition = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        positionUnits = (await openPositionAndValidate(this.state, mediumPosition, alice)).positionUnits;
        deposit = deposit.add(mediumPosition);
        allPositionUnits.push(positionUnits.sub(lastPositionUnits));
        lastPositionUnits = positionUnits;

        for (let i = 0; i < 20; i ++) {
            const epsilonPosition = getPositionAmountByDeltaCollateral(1, deposit, cviValue);
            deposit = deposit.add(epsilonPosition);
            positionUnits = (await openPositionAndValidate(this.state, epsilonPosition, alice)).positionUnits;
            allPositionUnits.push(positionUnits.sub(lastPositionUnits));
            lastPositionUnits = positionUnits;
        }

        const bigPosition = getPositionAmountByDeltaCollateral(306, deposit, cviValue);
        deposit = deposit.add(bigPosition);
        positionUnits = (await openPositionAndValidate(this.state, bigPosition, alice)).positionUnits;
        allPositionUnits.push(positionUnits.sub(lastPositionUnits));
        lastPositionUnits = positionUnits;

        await time.increase(SECONDS_PER_DAY.mul(toBN(3)));

        const { volumeFeePercentage: bigVolumeFeePercentage } = await closePositionAndValidate(this.state, allPositionUnits[21], alice);
        const volumeFeePercentage = MAX_CLOSE_VOLUME_FEE.mul(toBN(300).sub(toBN(200))).div(toBN(400).sub(toBN(200)));
        expect(bigVolumeFeePercentage).to.be.bignumber.at.least(volumeFeePercentage);

        for (let i = 0; i < 20; i ++) {
            await closePositionAndValidate(this.state, allPositionUnits[20 - i], alice);
        }

        const { volumeFeePercentage: mediumVolumeFeePercentage } = await closePositionAndValidate(this.state, allPositionUnits[0], alice);
        expect(mediumVolumeFeePercentage).to.be.bignumber.at.least(MAX_CLOSE_VOLUME_FEE.div(volumeFeePercentage));
    });

    it('changes volume fee adequately after withdrawing a large amount', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = new BN(100000);
        await depositAndValidate(this.state, deposit, bob);
        await depositAndValidate(this.state, deposit, alice);
        await depositAndValidate(this.state, deposit, carol);
        await depositAndValidate(this.state, deposit, dave);

        deposit = deposit.mul(new BN(4));

        await time.increase(SECONDS_PER_DAY * 3);
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const bigPosition = getPositionAmountByDeltaCollateral(100, deposit, cviValue);

        const smallPosition = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        const { volumeFeePercentage : bigVolumeFeePercentage } = await openPositionAndValidate(this.state, bigPosition, eve);

        expect(bigVolumeFeePercentage).to.be.bignumber.equal(toBN(0));

        await withdrawAndValidate(this.state, 0, bob, (await this.platform.balanceOf(bob)));
        await withdrawAndValidate(this.state, 0, alice, (await this.platform.balanceOf(alice)));
        await withdrawAndValidate(this.state, 0, carol, (await this.platform.balanceOf(carol)));

        const { volumeFeePercentage : smallVolumeFeePercentage } = await openPositionAndValidate(this.state, smallPosition, eve);
        expect(smallVolumeFeePercentage).to.be.bignumber.above(toBN(0));
    });

    it('changes close volume fee adequately after depositing a large amount', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = new BN(100000);
        await depositAndValidate(this.state, deposit, bob);
        await depositAndValidate(this.state, deposit, alice);
        await depositAndValidate(this.state, deposit, carol);
        await depositAndValidate(this.state, deposit, dave);

        deposit = deposit.mul(new BN(4));

        const bigPosition = getPositionAmountByDeltaCollateral(100, deposit, cviValue);
        const smallPosition = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        const { positionUnits: bigPositionUnits } = await openPositionAndValidate(this.state, bigPosition, eve);
        const { positionUnits } = await openPositionAndValidate(this.state, smallPosition, eve);
        const smallPositionUnits = positionUnits.sub(bigPositionUnits);

        await time.increase(SECONDS_PER_DAY * 3);

        const { volumeFeePercentage: bigVolumeFeePercentage } = await closePositionAndValidate(this.state, bigPositionUnits, eve);
        expect(bigVolumeFeePercentage).to.be.bignumber.equal(toBN(0));

        await withdrawAndValidate(this.state, 0, bob, (await this.platform.balanceOf(bob)));
        await withdrawAndValidate(this.state, 0, alice, (await this.platform.balanceOf(alice)));
        await withdrawAndValidate(this.state, 0, carol, (await this.platform.balanceOf(carol)));

        const { volumeFeePercentage : smallVolumeFeePercentage } = await closePositionAndValidate(this.state, smallPositionUnits, eve);
        expect(smallVolumeFeePercentage).to.be.bignumber.above(toBN(0));
    });

    it('hardly changes volume fee adequately after withdrawing a very small amount', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = new BN(400000);
        await depositAndValidate(this.state, deposit, bob);
        await depositAndValidate(this.state, new BN(10000), alice);
        await depositAndValidate(this.state, new BN(10000), carol);
        await depositAndValidate(this.state, new BN(10000), dave);

        deposit = deposit.add((new BN(10000)).mul(new BN(3)));

        await time.increase(SECONDS_PER_DAY * 3);
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const bigPosition = getPositionAmountByDeltaCollateral(100, deposit, cviValue);
        const smallPosition = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        const { volumeFeePercentage: bigVolumeFeePercentage } = await openPositionAndValidate(this.state, bigPosition, eve);

        expect(bigVolumeFeePercentage).to.be.bignumber.equal(toBN(0));

        await withdrawAndValidate(this.state, 0, dave, (await this.platform.balanceOf(dave)));
        await withdrawAndValidate(this.state, 0, alice, (await this.platform.balanceOf(alice)));
        await withdrawAndValidate(this.state, 0, carol, (await this.platform.balanceOf(carol)));

        const { volumeFeePercentage: smallVolumeFeePercentage } = await openPositionAndValidate(this.state, smallPosition, eve);
        expect(smallVolumeFeePercentage).to.be.bignumber.equal(toBN(0));
    });

    it('hardly changes close volume fee adequately after withdrawing a very small amount', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = new BN(400000);
        await depositAndValidate(this.state, deposit, bob);
        await depositAndValidate(this.state, new BN(10000), alice);
        await depositAndValidate(this.state, new BN(10000), carol);
        await depositAndValidate(this.state, new BN(10000), dave);

        deposit = deposit.add((new BN(10000)).mul(new BN(3)));

        const bigPosition = getPositionAmountByDeltaCollateral(100, deposit, cviValue);
        const smallPosition = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        const { positionUnits: bigPositionUnits } = await openPositionAndValidate(this.state, bigPosition, eve);
        const { positionUnits } = await openPositionAndValidate(this.state, smallPosition, eve);
        const smallPositionUnits = positionUnits.sub(bigPositionUnits);

        await time.increase(SECONDS_PER_DAY * 3);

        const { volumeFeePercentage: bigVolumeFeePercentage } = await closePositionAndValidate(this.state, bigPositionUnits, eve);
        expect(bigVolumeFeePercentage).to.be.bignumber.equal(toBN(0));

        await withdrawAndValidate(this.state, 0, dave, (await this.platform.balanceOf(dave)));
        await withdrawAndValidate(this.state, 0, alice, (await this.platform.balanceOf(alice)));
        await withdrawAndValidate(this.state, 0, carol, (await this.platform.balanceOf(carol)));

        const { volumeFeePercentage: smallVolumeFeePercentage } = await closePositionAndValidate(this.state, smallPositionUnits, eve);
        expect(smallVolumeFeePercentage).to.be.bignumber.equal(toBN(0));
    });

    it('charges higher fees for a big trade rather than parts-splitted trade of equal amount', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = toTokenAmount(4);
        await depositAndValidate(this.state, deposit, bob);

        const bigPosition = getPositionAmountByDeltaCollateral(200, deposit, cviValue);
        const { positionUnits } = await openPositionAndValidate(this.state, bigPosition, alice);
        const { volumeFeePercentage: volumeFeePercentageSingleTrade, positionUnits: positionUnits2 } = await openPositionAndValidate(this.state, bigPosition, carol);

        await time.increase(SECONDS_PER_DAY * 2);
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        await closePositionAndValidate(this.state, positionUnits, alice);
        await closePositionAndValidate(this.state, positionUnits2, carol);

        await time.increase(SECONDS_PER_DAY);
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        await openPositionAndValidate(this.state, bigPosition, alice);
        const { volumeFeePercentage: volumeFeePercentageFirstTrade } = await openPositionAndValidate(this.state, bigPosition.div(toBN(2)), carol);

        await time.increase(SECONDS_PER_HOUR.div(toBN(6)));

        const { volumeFeePercentage: volumeFeePercentageSecondTrade } = await openPositionAndValidate(this.state, bigPosition.div(toBN(2)), carol);

        const singleTradeVolumeFee = bigPosition.mul(volumeFeePercentageSingleTrade).div(MAX_FEE);
        const firstTradeVolumeFee = bigPosition.div(toBN(2)).mul(volumeFeePercentageFirstTrade).div(MAX_FEE);
        const secondTradeVolumeFee = bigPosition.div(toBN(2)).mul(volumeFeePercentageSecondTrade).div(MAX_FEE);

        expect(singleTradeVolumeFee).to.be.bignumber.above(firstTradeVolumeFee.add(secondTradeVolumeFee));
        expect(singleTradeVolumeFee).to.be.bignumber.below(firstTradeVolumeFee.add(secondTradeVolumeFee).mul(toBN(2)));
    });

    it('charges higher close fees for a big trade rather than parts-splitted trade of equal amount', async () => {
        const cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = toTokenAmount(4);
        await depositAndValidate(this.state, deposit, bob);

        const bigPosition = getPositionAmountByDeltaCollateral(200, deposit, cviValue);
        const { positionUnits } = await openPositionAndValidate(this.state, bigPosition, alice);
        const { positionUnits: positionUnits2 } = await openPositionAndValidate(this.state, bigPosition, carol);

        await time.increase(SECONDS_PER_DAY * 3);
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        await closePositionAndValidate(this.state, positionUnits, alice);
        const { volumeFee: volumeFeeSingleTrade } = await closePositionAndValidate(this.state, positionUnits2, carol);

        await time.increase(SECONDS_PER_DAY);
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        const { positionUnits: positionUnitsTotal } = await openPositionAndValidate(this.state, bigPosition, alice);
        const { positionUnits: positionUnitsTrade } = await openPositionAndValidate(this.state, bigPosition, carol);

        await time.increase(SECONDS_PER_DAY * 3);

        await closePositionAndValidate(this.state, positionUnits, alice);
        const { volumeFee: volumeFeeFirstTrade } = await closePositionAndValidate(this.state, positionUnitsTrade.div(toBN(2)), carol);
        const { volumeFee: volumeFeeSecondTrade } = await closePositionAndValidate(this.state, positionUnitsTrade.div(toBN(2)), carol);

        expect(volumeFeeSingleTrade).to.be.bignumber.above(volumeFeeFirstTrade.add(volumeFeeSecondTrade));
        expect(volumeFeeSingleTrade).to.be.bignumber.below(volumeFeeFirstTrade.add(volumeFeeSecondTrade).mul(toBN(2)));
    });

    it('calculates volume fees correctly on a complex scenario', async () => {
        let cviValue = 10000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let deposit = toTokenAmount(10);
        await depositAndValidate(this.state, deposit, bob);
        await depositAndValidate(this.state, deposit, alice);
        await depositAndValidate(this.state, deposit, carol);
        await depositAndValidate(this.state, deposit, dave);

        deposit = deposit.mul(new BN(4));

        await time.increase(SECONDS_PER_DAY * 3);

        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        let position = getPositionAmountByDeltaCollateral(100, deposit, cviValue);
        const evePosition = position;
        const { positionUnits: positionUnits1} = await openPositionAndValidate(this.state, position, eve);
        deposit = deposit.add(position);

        await time.increase(SECONDS_PER_HOUR);

        cviValue = 11000;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        position = getPositionAmountByDeltaCollateral(150, deposit, cviValue);
        let frankPosition = position;
        await openPositionAndValidate(this.state, position, frank);
        deposit = deposit.add(position);

        await time.increase(SECONDS_PER_DAY);

        await withdrawAndValidate(this.state, 0, bob, (await this.platform.balanceOf(bob)));
        deposit = deposit.sub(toTokenAmount(10));

        await closePositionAndValidate(this.state, positionUnits1, eve);
        deposit = deposit.sub(evePosition);

        cviValue = 10500;
        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        await time.increase(SECONDS_PER_HOUR.div(toBN(4)));

        await depositAndValidate(this.state, toTokenAmount(20), bob);
        deposit = deposit.add(toTokenAmount(20));

        position = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        frankPosition = frankPosition.add(position);
        await openPositionAndValidate(this.state, position, frank);
        deposit = deposit.add(position);

        await time.increase(SECONDS_PER_DAY);

        const positionUnitsFrank = (await this.platform.positions(frank)).positionUnitsAmount;

        await closePositionAndValidate(this.state, positionUnitsFrank.div(toBN(2)), frank);
        deposit = deposit.sub(frankPosition.div(toBN(2)));

        await time.increase(SECONDS_PER_HOUR);

        await closePositionAndValidate(this.state, positionUnitsFrank.div(toBN(2)), frank);
        deposit = deposit.sub(frankPosition.div(toBN(2)));

        await withdrawAndValidate(this.state, 0, alice, (await this.platform.balanceOf(alice)));
        deposit = deposit.sub(toTokenAmount(10));

        await this.fakePriceProvider.setPrice(toCVI(cviValue));

        position = getPositionAmountByDeltaCollateral(50, deposit, cviValue);
        await openPositionAndValidate(this.state, position, eve);
        deposit = deposit.add(position);
    });

    it('reverts when trying to open a position with no premium fee without privilage', async () => {
        await depositAndValidate(this.state, 40000, bob);

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, NO_FEES));
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, undefined, NO_FEES));

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, NO_FEES));
        await openPositionAndValidate(this.state, 1000, alice, undefined, NO_FEES);

        await this.platform.setAddressSpecificParameters(alice, true, false, false, {from: admin});

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, NO_FEES));
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, undefined, NO_FEES));
    });

    it('reverts when trying to open a position with no volume fee without privilage', async () => {
        await depositAndValidate(this.state, 40000, bob);

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, ONLY_COLLATERAL_PREMIUM));
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, undefined, ONLY_COLLATERAL_PREMIUM));

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, ONLY_COLLATERAL_PREMIUM));
        await openPositionAndValidate(this.state, 1000, alice, undefined, ONLY_COLLATERAL_PREMIUM);

        await this.platform.setAddressSpecificParameters(alice, true, false, false, {from: admin});

        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, ONLY_COLLATERAL_PREMIUM));
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, undefined, ONLY_COLLATERAL_PREMIUM));
    });

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

    it('reverts when opening a position with no liquidity at all (special division by zero revert)', async () => {
        await expectRevert.unspecified(openPositionAndValidate(this.state, toTokenAmount(15), alice));
    });

    for (let margin of MARGINS_TO_TEST) {
        it(`reverts if not enough liquidity expected after openning a position (margin = ${margin})`, async () => {
            this.feesCalculator.setBuyingPremiumFeeMax(0, {from: admin});
            this.feesCalculator.setOpenPositionFee(0, {from: admin});

            let cviValue = toCVI(11000);
            await this.fakePriceProvider.setPrice(cviValue);

            await depositAndValidate(this.state, toTokenAmount(9), bob);
            const deposit = toTokenAmount(10);

            // amount margined = x
            // total position units = x * 2 (cvi) * margin
            // x * 2 * margin < deposit + x * margin
            // x * margin < deposit => x < deposit / margin
            const open = toBN((1e18 * 10 / margin + 1000000).toString());

            
            // Note: not using openPositionAndValidate since open position fees and preimum fees are disabled, and would cause test to fail
            if (!getContracts().isETH) {
                await getContracts().token.transfer(alice, open, {from: admin});
                await getContracts().token.approve(getContracts().platform.address, open, {from: alice});
                await expectRevert(this.platform.openPosition(open, toBN(22000), toBN(1), margin, {from: alice}), 'Not enough liquidity');
            } else {
                await expectRevert(this.platform.openPositionETH(toBN(22000), toBN(1), margin, {from: alice, value: open}), 'Not enough liquidity');
            }

            await depositAndValidate(this.state, toTokenAmount(1), bob);
            
            if (!getContracts().isETH) {
                await getContracts().token.transfer(alice, open, {from: admin});
                await getContracts().token.approve(getContracts().platform.address, open, {from: alice});
                await expectRevert(this.platform.openPosition(open, toBN(22000), toBN(1), margin, {from: alice}), 'Not enough liquidity');
            } else {
                await expectRevert(this.platform.openPositionETH(toBN(22000), toBN(1), margin, {from: alice, value: open}), 'Not enough liquidity');
            }            

            await depositAndValidate(this.state, toBN(1000000000), bob);

            if (!getContracts().isETH) {
                await getContracts().token.transfer(alice, open, {from: admin});
                await getContracts().token.approve(getContracts().platform.address, open, {from: alice});
                await this.platform.openPosition(open, toBN(22000), toBN(1), margin, {from: alice});
            } else {
                await this.platform.openPositionETH(toBN(22000), toBN(1), margin, {from: alice, value: open});
            }

            await time.increase(SECONDS_PER_DAY * 3);

            await this.fakePriceProvider.setPrice(toCVI(22000));

            const position = await this.platform.positions(alice);
            await this.platform.closePosition(position.positionUnitsAmount, toBN(1), 1000, {from: alice});
        });

        it(`reverts when opening a position with a different margin than an already opened position (margin = ${margin})`, async () => {
            const firstMargin = MARGINS_TO_TEST[0];
            const secondMargin = MARGINS_TO_TEST[1];

            expect(firstMargin).not.equal(secondMargin);

            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, 5000 * firstMargin * 2 - 5000 * (firstMargin - 1) - 5000, bob);
            await openPositionAndValidate(this.state, 5000, alice, true, false, firstMargin);

            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, 5000 * secondMargin * 2 - 5000 * (secondMargin - 1) - 5000, bob);
            await expectRevert.unspecified(openPositionAndValidate(this.state, 5000, alice, true, false, secondMargin));
        });
    }

    it('checks liquidity check disregards margin debt until close', async () => {
        let cviValue = toCVI(11000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(this.state, toTokenAmount(2), bob);

        const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice, 2);

        await time.increase(SECONDS_PER_DAY * 3);

        await this.fakePriceProvider.setPrice(toCVI(22000));
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it('reaches low enough gas values for deposit/withdraw actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));

        const {gasUsed: firstDepositGasUsed} = await depositAndValidate(this.state, 4000, bob);
        print('first deposit', firstDepositGasUsed.div(GAS_PRICE).toString());
        expect(firstDepositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FIRST_DEPOSIT_EVER);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));

        const {gasUsed: depositGasUsed} = await depositAndValidate(this.state, 2000, bob);
        print('deposit', depositGasUsed.div(GAS_PRICE).toString());
        expect(depositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_DEPOSIT);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));

        const {gasUsed: partialWithdrawGasUsed} = await withdrawAndValidate(this.state, 2000, bob);
        print('partial withdraw', partialWithdrawGasUsed.div(GAS_PRICE).toString());
        expect(partialWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_PARTIAL_WITHDRAW);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

        const {gasUsed: fullWithdrawGasUsed} = await withdrawAndValidate(this.state, 4000, bob);
        print('full withdraw', fullWithdrawGasUsed.div(GAS_PRICE).toString());
        expect(fullWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FULL_WITHDRAW);
    });

    it('reaches low enough gas values for open/close actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));

        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        const {gasUsed: firstDepositGasUsed} = await depositAndValidate(this.state, 40000, bob);
        print('first deposit', firstDepositGasUsed.div(GAS_PRICE).toString());
        expect(firstDepositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FIRST_DEPOSIT_EVER);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(60 * 60);

        const {gasUsed: firstOpenGasUsed, positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 5000, alice);
        print('first open', firstOpenGasUsed.div(GAS_PRICE).toString());
        expect(firstOpenGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FIRST_OPEN_EVER);

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(60 * 60);

        const {gasUsed: mergeGasUsed, positionUnits: positionUnits2} = await openPositionAndValidate(this.state, 3000, alice);
        print('merge', mergeGasUsed.div(GAS_PRICE).toString());
        expect(mergeGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_MERGE);

        const {gasUsed: openGasUsed, positionUnits: positionUnitsCarol} = await openPositionAndValidate(this.state, 3000, carol);
        print('open', openGasUsed.div(GAS_PRICE).toString());
        expect(openGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_OPEN);

        let positionUnits = positionUnits2;

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(60 * 60);

        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        const {gasUsed: partialCloseGasUsed} = await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice);
        print('partial close', partialCloseGasUsed.div(GAS_PRICE).toString());
        expect(partialCloseGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_PARTIAL_CLOSE);

        positionUnits = positionUnits.sub(positionUnits.div(new BN(2)));
        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        const {gasUsed: fullCloseGasUsed} = await closePositionAndValidate(this.state, positionUnits, alice);
        print('full close', fullCloseGasUsed.div(GAS_PRICE).toString());
        expect(fullCloseGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FULL_CLOSE);

        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        const {gasUsed: partialWithdrawGasUsed} = await withdrawAndValidate(this.state, 10000, bob);
        print('partial withdraw', partialWithdrawGasUsed.div(GAS_PRICE).toString());
        expect(partialWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_PARTIAL_WITHDRAW);

        await time.increase(24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        const {gasUsed: depositGasUsed} = await depositAndValidate(this.state, 10000, bob);
        print('deposit', depositGasUsed.div(GAS_PRICE).toString());
        expect(depositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_DEPOSIT);

        await time.increase(3 * 24 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

        await closePositionAndValidate(this.state, positionUnitsCarol, carol);

        const tokensLeft = await getAccountBalance(this.platform.address);
        const {gasUsed: fullWithdrawGasUsed} = await withdrawAndValidate(this.state, tokensLeft, bob);
        print('full withdraw', fullWithdrawGasUsed.div(GAS_PRICE).toString());
        expect(fullWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FULL_WITHDRAW);
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
            await depositAndValidate(this.state, 5000 * margin * 2 - 5000 * (margin - 1) - 5000, bob);
            await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`opens a margined position properly without premium fee (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`merges a margined position properly with premium fee (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(12000));
            await openPositionAndValidate(this.state, 2500, alice, undefined, undefined, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await openPositionAndValidate(this.state, 2000, alice, undefined, undefined, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(13000));
            await openPositionAndValidate(this.state, 500, alice, undefined, undefined, margin);
        });

        it(`liquidates a negative balance margined position on merge properly (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            await openPositionAndValidate(this.state, toTokenAmount(2), alice, undefined, undefined, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 11000, true);
            await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation));

            await this.fakePriceProvider.setPrice(toCVI(11000));
            await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin, undefined, true);
        });

        it(`does not liquidates a liquidable positive balance position on merge (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            await openPositionAndValidate(this.state, toTokenAmount(2), alice, undefined, undefined, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 11000);
            await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation));

            await this.fakePriceProvider.setPrice(toCVI(11000));
            await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`closes a margined position properly, cvi rises (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            const {positionUnits} = await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(13000));
            await closePositionAndValidate(this.state, positionUnits, alice);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`closes a margined position properly, cvi drops (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            const {positionUnits} = await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin);
            await time.increase(SECONDS_PER_DAY);
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await closePositionAndValidate(this.state, positionUnits, alice);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`closes part of a margined position properly (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob);
            const {positionUnits} = await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin);
            await time.increase(24 * 60 * 60);
            await closePositionAndValidate(this.state, positionUnits.div(new BN(3)), alice);
            await time.increase(24 * 60 * 60);
            await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice);
        });
    }

    it('opens multiple margined positioned together with different margins, including premium fee', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));
        await depositAndValidate(this.state, 100000, bob);
        await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, 1);
        await openPositionAndValidate(this.state, 15000, dave, undefined, undefined, 8);
        await openPositionAndValidate(this.state, 15000, carol, undefined, undefined, 4);
    });

    const positionForCollateral = (deposit, positionUnits, collateral) => {
        // (deposit + position) / (positionUnits + position * 2) = collateral / MAX_FEE
        // position = (deposit * MAX_FEE - collateral * positionUnits) / (2 * collateral - MAX_FEE)

        return deposit.mul(MAX_FEE).sub(collateral.mul(positionUnits)).div(toBN(2).mul(collateral).sub(MAX_FEE));
    }

    const testPremiumFeeByMerge = async (margin, firstDelta, secondDelta) => {
        await this.fakePriceProvider.setPrice(toCVI(11000));

        let deposit = toTokenAmount(5);
        const positionUnits = toBN(0);

        await depositAndValidate(this.state, deposit, bob);

        const position = getPositionAmountByDeltaCollateral(6500, deposit, 11000).div(toBN(margin));
        const { premiumPercentage } = await openPositionAndValidate(this.state, position, alice, undefined, undefined, margin);

        expect(premiumPercentage).to.be.bignumber.equal(toBN(0));

        await time.increase(SECONDS_PER_HOUR.mul(toBN(2)));

        const position2 = getPositionAmountByDeltaCollateral(2000, deposit, 11000).div(toBN(margin));
        const { premiumPercentage: premiumPercentage2 } = await openPositionAndValidate(this.state, position2, alice, undefined, undefined, margin);

        expect(premiumPercentage2).to.be.bignumber.above(toBN(0));
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`calculates premium fee correctly by collateral ratio (margin = ${margin})`, async () => {
            await testPremiumFeeByMerge(margin, 6500, 2000);
        });

        it(`calculates premium fee correctly by part that passed collateral ratio (margin = ${margin})`, async () => {
            await testPremiumFeeByMerge(margin, 5000, 3000);
        });
    };

    for (let margin of MARGINS_TO_TEST) {
        it(`liquidates positions due to cvi drop (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin);
            await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin);

            const liquidationCVI = await calculateLiquidationCVI(this.state, alice);
            const carolLiquidationCVI = await calculateLiquidationCVI(this.state, carol);

            await this.fakePriceProvider.setPrice(toCVI(liquidationCVI));

            await liquidateAndValidate(this.state, [alice], dave, true);

            await this.fakePriceProvider.setPrice(toCVI(carolLiquidationCVI));

            await liquidateAndValidate(this.state, [carol], dave, true);
        });

        it(`liquidates multiple positions at once due to cvi drop (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(11000));
            await depositAndValidate(this.state, 50000, bob);
            await openPositionAndValidate(this.state, 1000, alice, undefined, undefined, margin);
            await openPositionAndValidate(this.state, 2000, carol, undefined, undefined, margin);

            let liquidationCVI = await calculateLiquidationCVI(this.state, alice);
            const carolLiquidationCVI = await calculateLiquidationCVI(this.state, carol);

            if (carolLiquidationCVI.lt(liquidationCVI)) {
                liquidationCVI = carolLiquidationCVI;
            }

            await this.fakePriceProvider.setPrice(toCVI(liquidationCVI));

            await liquidateAndValidate(this.state, [alice, carol], dave, true);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`does not liquidates positions due to nearly enough cvi drop (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, 50000, bob);
            await openPositionAndValidate(this.state, 1000, alice, undefined, undefined, margin);

            const liquidationCVI = (await calculateLiquidationCVI(this.state, alice)).add(new BN(100));

            await this.fakePriceProvider.setPrice(toCVI(liquidationCVI));
            await liquidateAndValidate(this.state, [alice], carol, false);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`liquidates position due to funding fees (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin);
            await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000);
            const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000);

            expect(daysToLiquidation).to.be.bignumber.equal(carolDaysToLiquidation);

            await time.increase(daysToLiquidation.sub(new BN(1)).mul(SECONDS_PER_DAY));

            await this.fakePriceProvider.setPrice(toCVI(10000));
            await liquidateAndValidate(this.state, [alice], dave, false);
            await liquidateAndValidate(this.state, [carol], dave, false);

            await time.increase(new BN(3600 * 24));
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await liquidateAndValidate(this.state, [alice], dave, true);
            await liquidateAndValidate(this.state, [carol], dave, true);
        });

        it(`liquidates only liquidable positions from accounts list due to funding fees (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin);
            await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000);
            const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000);

            expect(daysToLiquidation).to.be.bignumber.equal(carolDaysToLiquidation);

            await time.increase(daysToLiquidation.sub(new BN(1)).mul(SECONDS_PER_DAY));

            await this.fakePriceProvider.setPrice(toCVI(10000));
            await openPositionAndValidate(this.state, toTokenAmount(3), eve, undefined, undefined, margin);
            await expectRevert(liquidateAndValidate(this.state, [alice, carol], dave, [false, false]), 'No liquidable position');

            await time.increase(new BN(3600 * 24));
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await liquidateAndValidate(this.state, [alice, carol, eve], dave, [true, true, false]);
        });
    }

    for (let margin of MARGINS_TO_TEST) {
        it(`liquidates a negative balance position on full or partial close (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            const {positionUnits} = await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin);
            const {positionUnits: positionUnitsCarol} = await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000, true);
            const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000, true);

            expect(daysToLiquidation).to.be.bignumber.equal(carolDaysToLiquidation);
            await time.increase(daysToLiquidation.mul(SECONDS_PER_DAY));

            await this.fakePriceProvider.setPrice(toCVI(10000));
            await closePositionAndValidate(this.state, positionUnits, alice, true);
            await closePositionAndValidate(this.state, positionUnits.div(toBN(2)), carol, true);
        });

        it(`does not liquidates a liquidable positive balance position on close (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            const {positionUnits} = await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin);

            const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000, false);

            await time.increase(daysToLiquidation.mul(SECONDS_PER_DAY));

            await this.fakePriceProvider.setPrice(toCVI(10000));
            await closePositionAndValidate(this.state, positionUnits, alice);
        });
    }

    it('liquidates margined positions sooner', async () => {
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await depositAndValidate(this.state, toTokenAmount(50), bob);
        await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, 4);
        await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, 2);
        await openPositionAndValidate(this.state, toTokenAmount(2), eve, undefined, undefined, 1);


        const aliceDaysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000);
        const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000);
        const eveDaysToLiquidation = await calculateLiquidationDays(this.state, eve, 10000);

        expect(carolDaysToLiquidation).to.be.bignumber.at.least(aliceDaysToLiquidation);
        expect(eveDaysToLiquidation).to.be.bignumber.at.least(carolDaysToLiquidation);

        await time.increase(aliceDaysToLiquidation.sub(new BN(1)).mul(SECONDS_PER_DAY));

        await this.fakePriceProvider.setPrice(toCVI(10000));

        await liquidateAndValidate(this.state, [alice], dave, false);
        await liquidateAndValidate(this.state, [carol], dave, false);
        await liquidateAndValidate(this.state, [eve], dave, false);

        await time.increase(SECONDS_PER_DAY);
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await liquidateAndValidate(this.state, [alice], dave, true);
        await liquidateAndValidate(this.state, [carol], dave, false);
        await liquidateAndValidate(this.state, [eve], dave, false);

        await time.increase(carolDaysToLiquidation.sub(aliceDaysToLiquidation).sub(new BN(1)).mul(SECONDS_PER_DAY));
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await liquidateAndValidate(this.state, [carol], dave, false);
        await liquidateAndValidate(this.state, [eve], dave, false);

        await time.increase(SECONDS_PER_DAY);
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await liquidateAndValidate(this.state, [carol], dave, true);
        await liquidateAndValidate(this.state, [eve], dave, false);

        await time.increase(eveDaysToLiquidation.sub(carolDaysToLiquidation).sub(new BN(1)).mul(SECONDS_PER_DAY));
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await liquidateAndValidate(this.state, [eve], dave, false);

        await time.increase(SECONDS_PER_DAY);
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await liquidateAndValidate(this.state, [eve], dave, true);
    });

    it('LPs dont lose from margin debt calculation', async () => {
        await this.platform.setLockupPeriods(0, 0, {from: admin});

        await this.fakePriceProvider.setPrice(toCVI(5000));

        await depositAndValidate(this.state, 5000 * 2 * 2 * 100, carol); // Multiply by 100 to prevent volume fee on open

        const beforeBobBalance = await getAccountBalance(bob);
        const beforeDaveBalance = await getAccountBalance(dave);

        let bobGasUsed = new BN(0);
        let daveGasUsed = new BN(0);

        const bobDeposit = new BN(5000 * 2 * 2);
        const daveDeposit = new BN(10000 * 2 * 2);

        const {gasUsed: bobDepositGas} = await depositAndValidate(this.state, bobDeposit, bob);
        const {gasUsed: daveDepositGas} = await depositAndValidate(this.state, daveDeposit, dave);

        bobGasUsed = bobGasUsed.add(bobDepositGas);
        daveGasUsed = daveGasUsed.add(daveDepositGas);

        await openPositionAndValidate(this.state, 5000, alice, 2);

        const bobLPTokensBalance = await this.platform.balanceOf(bob);
        const daveLPTokensBalance = await this.platform.balanceOf(dave);

        const {gasUsed: bobWithdrawGas} = await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance);
        const {gasUsed: daveWithdrawGas} = await withdrawAndValidate(this.state, 0, dave, daveLPTokensBalance);

        bobGasUsed = bobGasUsed.add(bobWithdrawGas);
        daveGasUsed = daveGasUsed.add(daveWithdrawGas);

        const afterWithdrawBobBalance = await getAccountBalance(bob);
        const afterWithdrawDaveBalance = await getAccountBalance(dave);

        const maxReasonableFundingFeesGain = new BN(10);

        if (this.isETH) {
            expect(beforeBobBalance.sub(afterWithdrawBobBalance)).to.be.bignumber.at.least(bobGasUsed.sub(maxReasonableFundingFeesGain));
            expect(beforeDaveBalance.sub(afterWithdrawDaveBalance)).to.be.bignumber.at.least(daveGasUsed.sub(maxReasonableFundingFeesGain));

            expect(beforeBobBalance.sub(afterWithdrawBobBalance)).to.be.bignumber.at.most(bobGasUsed);
            expect(beforeDaveBalance.sub(afterWithdrawDaveBalance)).to.be.bignumber.at.most(daveGasUsed);
        } else {
            expect(afterWithdrawBobBalance.sub(bobDeposit)).to.be.bignumber.at.most(maxReasonableFundingFeesGain);
            expect(afterWithdrawDaveBalance.sub(daveDeposit)).to.be.bignumber.at.most(maxReasonableFundingFeesGain);

            expect(afterWithdrawBobBalance.sub(bobDeposit)).to.be.bignumber.at.least(new BN(0));
            expect(afterWithdrawDaveBalance.sub(daveDeposit)).to.be.bignumber.at.least(new BN(0));
        }
    });

    const testMultiplePositions = async (openFees, closeFees) => {
        if (openFees !== undefined) {
            this.feesCalculator.setOpenPositionFee(openFees, {from: admin});
        }

        if (closeFees !== undefined) {
            this.feesCalculator.setClosePositionFee(closeFees, {from: admin});
        }

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
    };

    it('opens multiple positions and closes them, but gets reward correctly on last open and merge afterwards', async () => {
        await testMultiplePositions();
    });

    it('opens multiple positions and closes them with different open fee and no close fees', async () => {
        await testMultiplePositions(40, 0);
    });

    it('opens multiple positions and closes them with no open fees and different close fees', async () => {
        await testMultiplePositions(0, 40);
    });

    it('opens multiple positions and closes them with different no open fees and no close fees', async () => {
        await testMultiplePositions(0, 0);
    });

    it('opens multiple positions and closes them with different non default open fees and close fees', async () => {
        await testMultiplePositions(40, 50);
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

    it('merges a position properly with premium fee', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));
        await depositAndValidate(this.state, 60000, bob);
        await openPositionAndValidate(this.state, 10000, alice);

        await openPositionAndValidate(this.state, 10000, alice);

        await openPositionAndValidate(this.state, 10000, alice);
    });

    it('merges a position with less position units after merge properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(11000));
        await depositAndValidate(this.state, toTokenAmount(6), bob);
        const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice);

        await time.increase(SECONDS_PER_DAY * 2);
        await this.fakePriceProvider.setPrice(toCVI(11000));

        const { positionUnits: positionUnits2, positionUnitsAdded } = await openPositionAndValidate(this.state, 5000000000, alice);

        expect(positionUnits2).to.be.bignumber.below(positionUnits);
        expect(positionUnitsAdded).to.be.bignumber.equal(toBN(0));
    });

    it('cvi oracle truncates to max value', async () => {
        const cvi = getContracts().maxCVIValue.toNumber() + 1;
        await this.fakePriceProvider.setPrice(toCVI(cvi));

        expect((await this.fakeOracle.getCVILatestRoundData()).cviValue).to.be.bignumber.equal(getContracts().maxCVIValue);
    });

    it('reverts when trying to close too many positional units', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert.unspecified(this.platform.closePosition(1, 5000, 1000, {from: alice}));
        await depositAndValidate(this.state, toTokenAmount(5), bob);
        await expectRevert.unspecified(this.platform.closePosition(1, 5000, 1000, {from: alice}));
        const {positionUnits} = await openPositionAndValidate(this.state, toTokenAmount(1), alice);

        await time.increase(24 * 60 * 60);

        await expectRevert.unspecified(this.platform.closePosition(positionUnits.add(new BN(1)), 5000, 1000, {from: alice}));
        await closePositionAndValidate(this.state, positionUnits, alice);
    });

    it('reverts when closing zero position units', async () => {
        await depositAndValidate(this.state, 5000, bob);
        await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert.unspecified(closePosition(0, 5000,alice));
    });

    it('reverts when closing a position with an invalid min CVI value', async () => {
        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits} = await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert.unspecified(closePosition(positionUnits, 0, alice));
        await expectRevert.unspecified(closePosition(positionUnits, getContracts().maxCVIValue.toNumber() + 1, alice));

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

    it('updates total funding fee back to zero instead of one when rounding, if position units updates to zero', async () => {
        await depositAndValidate(this.state, 1000, bob);

        const {positionUnits} = await openPositionAndValidate(this.state, 201, alice);
        await time.increase(96 * 59 * 59);
        await this.fakePriceProvider.setPrice(toCVI(5000));

        // Total funding fees grow here
        await depositAndValidate(this.state, 1001, bob);
        await time.increase(96 * 59 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5000));

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
        const {depositTimestamp: timestamp1} = await depositAndValidate(this.state, 2000, bob);
        expect(await this.platform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(3 * 24 * 60 * 60);
        this.fakePriceProvider.setPrice(toCVI(5000));

        const {timestamp: timestamp2} = await withdrawAndValidate(this.state, 1000, bob);

        await testSnapshot(timestamp1, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {positionUnits, timestamp: timestamp3} = await openPositionAndValidate(this.state, 100, alice);
        await testSnapshot(timestamp2, canPurgeSnapshots);
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(24 * 60 * 60);
        this.fakePriceProvider.setPrice(toCVI(5000));

        const {timestamp: timestamp4} = await closePositionAndValidate(this.state, positionUnits, alice);
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {depositTimestamp: timestamp5} = await depositAndValidate(this.state, 2000, bob);
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
        await expectRevert.unspecified(openPosition(1000, 5000, bob, 1000, 2));
    });

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
        await expectRevert.unspecified(openPosition(1000, 5000, alice, 1000, 9));
        await openPosition(1000, 5000, alice, 1000, 8);
    });

    it('sets fees calculator properly', async () => {
        const beforeSet = await this.platform.feesCalculator();

        await this.platform.setFeesCalculator(ZERO_ADDRESS);

        const afterSet = await this.platform.feesCalculator();
        expect(beforeSet).to.be.not.equal(afterSet);
    });
    
    it('sets latest oracle round id properly', async () => {
        const beforeSet = await this.platform.latestOracleRoundId();
        expect(beforeSet).to.be.bignumber.equal(new BN(0));

        await this.platform.setLatestOracleRoundId(222);

        const afterSet = await this.platform.latestOracleRoundId();
        expect(afterSet).to.be.bignumber.equal(new BN(222));
    });
    
    it('sets max time allowed after latest round properly', async () => {
        await this.platform.setMaxTimeAllowedAfterLatestRound(SECONDS_PER_DAY);
        const set1 = await this.platform.maxTimeAllowedAfterLatestRound();
        expect(set1).to.be.bignumber.equal(new BN(SECONDS_PER_DAY));

        await time.increase(SECONDS_PER_DAY);
        
        await expectRevert(depositAndValidate(this.state, 1000, bob), 'Latest cvi too long ago');
        await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'Latest cvi too long ago');

        this.fakePriceProvider.setPrice(toCVI(11000));
        await this.platform.setMaxTimeAllowedAfterLatestRound(SECONDS_PER_DAY * 2);
        const set2 = await this.platform.maxTimeAllowedAfterLatestRound();
        expect(set2).to.be.bignumber.equal(new BN(SECONDS_PER_DAY * 2));

        await time.increase(SECONDS_PER_DAY);

        await depositAndValidate(this.state, 20000, bob);
        await openPositionAndValidate(this.state, 1000, alice);

        await time.increase(SECONDS_PER_DAY);

        await expectRevert(depositAndValidate(this.state, 1000, bob), 'Latest cvi too long ago');
        await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'Latest cvi too long ago');
    });

    it('sets no lock address properly', async () => {
        await depositAndValidate(this.state, 20000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice);

        const beforeSet = await this.platform.noLockPositionAddresses(alice);
        expect(beforeSet).to.equal(false);

        await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice, false, true), 'Position locked');

        await this.platform.setAddressSpecificParameters(alice, false, false, false, {from: admin});
        const afterSet = await this.platform.noLockPositionAddresses(alice);
        expect(afterSet).to.equal(true);

        await closePositionAndValidate(this.state, positionUnits1, alice, false, true);
    });

    it('sets no premium fee allowed properly', async () => {
        await depositAndValidate(this.state, 20000, bob);

        const beforeSet = await this.platform.noPremiumFeeAllowedAddresses(alice);
        expect(beforeSet).to.equal(false);
        
        await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, true, NO_FEES)); // "Not allowed"

        await this.platform.setAddressSpecificParameters(alice, true, true, false, {from: admin});
        const afterSet = await this.platform.noPremiumFeeAllowedAddresses(alice);
        expect(afterSet).to.equal(true);

        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice, true, NO_FEES);
    });

    it('sets increase shared pool allowed properly', async () => {
        const totalLeveragedTokensAmount = await this.platform.totalLeveragedTokensAmount();
        const beforeSet = await this.platform.increaseSharedPoolAllowedAddresses(alice);
        expect(beforeSet).to.equal(false);

        const addAmount = toTokenAmount(1000);
        await expectRevert.unspecified(increaseSharedPool(alice, addAmount)); // "Not allowed"

        await this.platform.setAddressSpecificParameters(alice, true, false, true, {from: admin});

        const afterSet = await this.platform.increaseSharedPoolAllowedAddresses(alice);
        expect(afterSet).to.equal(true);

        await increaseSharedPool(alice, addAmount);
        
        const totalLeveragedTokensAmount1 = await this.platform.totalLeveragedTokensAmount();
        expect(totalLeveragedTokensAmount1).to.be.bignumber.equal(totalLeveragedTokensAmount.add(addAmount));
    });

    it('sets can emergency withdraw allowed properly', async () => {
        this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(this.state, 10000, alice);
        await openPositionAndValidate(this.state, 2000, bob, true, false, 1);
        const beforeEmergencyWithdrawAllowed = await this.platform.emergencyWithdrawAllowed();
        expect(beforeEmergencyWithdrawAllowed).to.equal(false);

        await time.increase(3 * 24 * 60 * 60);
        this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(withdrawAndValidate(this.state, 10000, alice), 'Collateral ratio broken');
        await this.platform.setEmergencyParameters(true, false, {from: admin});
        const afterEmergencyWithdrawAllowed = await this.platform.emergencyWithdrawAllowed();
        expect(afterEmergencyWithdrawAllowed).to.equal(true);
        await withdrawAndValidate(this.state, 10000, alice);
    });

    it('sets max allowed leverage properly', async () => {
        await depositAndValidate(this.state, 10000, alice);
        await this.platform.setMaxAllowedLeverage(1, {from: admin});
        const beforeLeverage = await this.platform.maxAllowedLeverage()
        expect(beforeLeverage).to.be.bignumber.equal(new BN(1))
        await expectRevert.unspecified(openPosition(1000, 5000, bob, 1000, 2));

        await this.platform.setMaxAllowedLeverage(2, {from: admin});
        const afterLeverage = await this.platform.maxAllowedLeverage()
        expect(afterLeverage).to.be.bignumber.equal(new BN(2))
        await openPositionAndValidate(this.state, 1000, bob, true, false, 2);
        await expectRevert.unspecified(openPosition(1000, 5000, carol, 1000, 3));
    });

    it('does not delete snapshot if an open occured on its block', async () => {
        const {depositTimestamp: timestamp1} = await depositAndValidate(this.state, 2000, bob);
        const {timestamp: timestamp2} = await openPositionAndValidate(this.state, 100, alice);

        if (timestamp1 === timestamp2) {
            expect(await this.platform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(3 * 24 * 60 * 60);
        this.fakePriceProvider.setPrice(toCVI(5000));

        const {timestamp: timestamp4} = await openPositionAndValidate(this.state, 100, alice);
        const {timestamp: timestamp3} = await withdrawAndValidate(this.state, 1000, bob);

        if (timestamp3 === timestamp4) {
            expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {timestamp: timestamp5} = await openPositionAndValidate(this.state, 10, alice);
        const {depositTimestamp: timestamp6} = await depositAndValidate(this.state, 1, bob);

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
        await expectRevert(this.platform.liquidatePositions([alice], {from: dave}), 'No liquidable position');
        await expectRevert(this.platform.liquidatePositions([bob, carol], {from: dave}), 'No liquidable position');
        await expectRevert(this.platform.liquidatePositions([alice, bob, carol, dave], {from: dave}), 'No liquidable position');
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

    it('sets lockup period correctly - buyers', async () => {
        await this.platform.setLockupPeriods(240, SECONDS_PER_DAY, {from: admin});
        const period1 = await this.platform.buyersLockupPeriod();
        expect(period1).to.be.bignumber.equal(new BN(SECONDS_PER_DAY));

        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(SECONDS_PER_DAY - 10);
        await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice), 'Position locked');
        await time.increase(10);
        await closePositionAndValidate(this.state, positionUnits1, alice);
        
        await this.platform.setLockupPeriods(240, +SECONDS_PER_DAY + 100, {from: admin});
        const period2 = await this.platform.buyersLockupPeriod();
        expect(period2).to.be.bignumber.equal(new BN(+SECONDS_PER_DAY + 100));

        await this.fakePriceProvider.setPrice(toCVI(11000));

        await depositAndValidate(this.state, 5000, bob);
        const {positionUnits: positionUnits2} = await openPositionAndValidate(this.state, 1000, alice);
        await time.increase(SECONDS_PER_DAY - 10);
        await expectRevert(closePositionAndValidate(this.state, positionUnits2, alice), 'Position locked');
        await time.increase(10);
        await expectRevert(closePositionAndValidate(this.state, positionUnits2, alice), 'Position locked');
        await time.increase(94);
        await expectRevert(closePositionAndValidate(this.state, positionUnits2, alice), 'Position locked');
        await time.increase(6);
        await closePositionAndValidate(this.state, positionUnits2, alice);
    });

    it('sets lockup period correctly - LPs', async () => {
        await this.platform.setLockupPeriods(240, 120, {from: admin});
        const period1 = await this.platform.lpsLockupPeriod();
        expect(period1).to.be.bignumber.equal(new BN(240));

        await depositAndValidate(this.state, 1000, bob);
        await time.increase(200);
        const bobLPTokensBalance = await this.platform.balanceOf(bob);
        await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance), 'Funds are locked');
        await time.increase(40);
        await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance);
        expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0));

        await this.platform.setLockupPeriods(500, 120, {from: admin});
        const period2 = await this.platform.lpsLockupPeriod();
        expect(period2).to.be.bignumber.equal(new BN(500));

        await depositAndValidate(this.state, 1000, bob);
        await time.increase(200);
        const bobLPTokensBalance2 = await this.platform.balanceOf(bob);
        await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2), 'Funds are locked');
        await time.increase(40);
        await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2), 'Funds are locked');
        await time.increase(254);
        await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2), 'Funds are locked');
        await time.increase(6);
        await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2);
        expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0));
    });

    it('close fee decay functions properly', async () => {
        await depositAndValidate(this.state, 20000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice);
        const {positionUnits: positionUnitsBob} = await openPositionAndValidate(this.state, 1000, bob);
        const {positionUnits: positionUnitsCarol} = await openPositionAndValidate(this.state, 1000, carol);

        const closePositionMaxFeePercent = await this.feesCalculator.closePositionMaxFeePercent();
        const closePositionFeeDecayPeriod = await this.feesCalculator.closePositionFeeDecayPeriod();

        const period = await this.platform.buyersLockupPeriod();
        await time.increase(period);
        // min decay (after lockup is over)
        await closePositionAndValidate(this.state, positionUnits1, alice);

        await time.increase(closePositionFeeDecayPeriod / 2 - period);
        // middle decay
        await closePositionAndValidate(this.state, positionUnitsBob, bob);

        await time.increase(closePositionFeeDecayPeriod / 2);
        // max decay
        await closePositionAndValidate(this.state, positionUnitsCarol, carol);
    });

    it('no lock addresses do not get close decay fees but minimal close fees always', async () => {
        await depositAndValidate(this.state, 20000, bob);
        const {positionUnits: positionUnits1} = await openPositionAndValidate(this.state, 1000, alice);

        await this.platform.setAddressSpecificParameters(alice, false, false, false, {from: admin});

        const period = await this.platform.buyersLockupPeriod();
        await time.increase(period);

        await closePositionAndValidate(this.state, positionUnits1, alice, false, true);
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
        await expectRevert(this.platform.setSubContracts(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, {from: dave}), expectedError);
        await expectRevert(this.platform.setMaxTimeAllowedAfterLatestRound(2, {from: dave}), expectedError);

        const staking = await StakingRewards.new(admin, admin, this.cviToken.address, this.platform.address);
        await expectRevert(setStakingContractAddress(staking.address, {from: bob}), expectedError);
    });

    it('reverts when trying to get balance/funding fees with addendum of a non-existing position', async () => {
        await expectRevert.unspecified(this.platform.calculatePositionBalance(bob));
        await expectRevert.unspecified(this.platform.calculatePositionBalance(alice));
        await expectRevert.unspecified(this.platform.calculatePositionPendingFees(bob, 0));
        await expectRevert.unspecified(this.platform.calculatePositionPendingFees(alice, 0));
    });

    it('reverts when trying to get balance/funding fees with addendum of an already-closed position', async () => {
        await depositAndValidate(this.state, toTokenAmount(5), bob);
        const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice);

        await time.increase(SECONDS_PER_DAY * 3);

        await closePositionAndValidate(this.state, positionUnits, alice);

        await expectRevert.unspecified(this.platform.calculatePositionBalance(alice));
        await expectRevert.unspecified(this.platform.calculatePositionPendingFees(alice, positionUnits));
    });

    it('reverts when trying to get funding fees with addendum for more than position\'s position units', async () => {
        await depositAndValidate(this.state, toTokenAmount(5), bob);
        const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice);

        await this.platform.calculatePositionPendingFees(alice, toBN(0));
        await this.platform.calculatePositionPendingFees(alice, positionUnits.div(toBN(2)));
        await this.platform.calculatePositionPendingFees(alice, positionUnits);
        await expectRevert.unspecified(this.platform.calculatePositionPendingFees(alice, positionUnits.add(toBN(1))));
    });

    const verifyPendingFees = async (account, positionUnits) => {
        const pendingFees = await this.platform.calculatePositionPendingFees(account, positionUnits);
        const {snapshot: pendingFeesSnapshot} = await updateSnapshots(this.state, false);        

        const feesUpToLatestSnapshot = calculateFundingFeesWithSnapshot(this.state, 
            this.state.snapshots[this.state.latestSnapshotTimestamp], account, positionUnits);

        const feesFromLatestSnapshot = calculateFundingFeesWithTwoSnapshots(this.state.snapshots[this.state.latestSnapshotTimestamp], 
                        pendingFeesSnapshot, positionUnits);
        const expectedPendingFees = feesUpToLatestSnapshot.add(feesFromLatestSnapshot);

        expect(pendingFees).to.be.bignumber.equal(expectedPendingFees);
    };

    const verifyBalance = async (account, isPositive = true) => {
        const result = await this.platform.calculatePositionBalance(account);
        const {latestTimestamp: timestamp, snapshot} = await updateSnapshots(this.state, false);

        expect(result.isPositive).to.equal(isPositive);
        expect(result.positionUnitsAmount).to.be.bignumber.equal(this.state.positions[account].positionUnitsAmount);
        expect(result.leverage).to.be.bignumber.equal(this.state.positions[account].leverage);

        const fundingFees = calculateFundingFeesWithSnapshot(this.state, snapshot, account, this.state.positions[account].positionUnitsAmount);
        expect(result.fundingFees).to.be.bignumber.equal(fundingFees);

        const marginDebt = calculateMarginDebt(this.state, account);
        expect(result.marginDebt).to.be.bignumber.equal(marginDebt);

        const positionBalance = await calculatePositionBalance(this.state.positions[account].positionUnitsAmount);
        expect(result.currentPositionBalance).to.be.bignumber.equal(isPositive ? 
            positionBalance.sub(fundingFees).sub(marginDebt) : fundingFees.add(marginDebt).sub(positionBalance));
    };

    const verifyTotalBalance = async () => {
        const result = await this.platform.totalBalance(true);
        const {totalFundingFees: addendumFundingFees} = await updateSnapshots(this.state, false);

        const totalBalance = await calculateBalance(this.state, addendumFundingFees);
        expect(result).to.be.bignumber.equal(totalBalance);
    };

    it('calculates latest turbulence indicator percent properly', async () => {
        await depositAndValidate(this.state, 40000, bob);

        // Cause turbulence
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(1);

        // Causes snapshot
        await openPositionAndValidate(this.state, 1000, alice);

        expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(300));

        await time.increase(SECONDS_PER_HOUR);

        expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(300));

        await this.fakePriceProvider.setPrice(toCVI(6000)); // Turbulence drops to 150
        await time.increase(1);
        await this.fakePriceProvider.setPrice(toCVI(5000)); // Rises to 250
        await time.increase(1);

        expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(250));

        await this.fakePriceProvider.setPrice(toCVI(6000)); // Rises to 350
        await time.increase(1);

        expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(350));

        await this.fakePriceProvider.setPrice(toCVI(7000)); // Rises to 350
        await time.increase(1);

        // Should be 0 as there are 3 rounds and deviation si not enough
        expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(0));
    });

    for (let margin of MARGINS_TO_TEST) {
        it(`calculates all addendum view functions results properly (margin = ${margin})`, async () => {
            await this.fakePriceProvider.setPrice(toCVI(10000));
            await depositAndValidate(this.state, toTokenAmount(50), bob);
            await openPositionAndValidate(this.state, toTokenAmount(2), alice, undefined, undefined, margin);
            await openPositionAndValidate(this.state, toTokenAmount(1), carol, undefined, undefined, margin);
            
            await verifyBalance(alice);
            await verifyBalance(carol);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)));
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount);
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)));
            await verifyTotalBalance();

            await time.increase(SECONDS_PER_DAY);

            await this.fakePriceProvider.setPrice(toCVI(10000));
            await verifyBalance(alice);
            await verifyBalance(carol);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)));
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount);
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)));
            await verifyTotalBalance();

            await time.increase(24 * 60 * 60);

            await this.fakePriceProvider.setPrice(toCVI(9500));
            await verifyBalance(alice);
            await verifyBalance(carol);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)));
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount);
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)));
            await verifyTotalBalance();

            const daysToNegativeBalance = await calculateLiquidationDays(this.state, alice, 9500, true);

            await time.increase(daysToNegativeBalance.mul(SECONDS_PER_DAY));

            await verifyBalance(alice, false);
            await verifyBalance(carol, false);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount);
            await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)));
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount);
            await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)));
            await verifyTotalBalance();
        });
    }
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
