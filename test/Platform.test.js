const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee} = require('./utils/FeesUtils.js');

const Platform = contract.fromArtifact('Platform');
const ETHPlatform = contract.fromArtifact('ETHPlatform');
const CVIOracle = contract.fromArtifact('CVIOracle');
const Rewards = contract.fromArtifact('Rewards');
const FeesModel = contract.fromArtifact('FeesModel');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const FakeWETH = contract.fromArtifact('FakeWETH');
const WETH9 = contract.fromArtifact('WETH9');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const fakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const Liquidation = contract.fromArtifact('Liquidation');

const expect = chai.expect;
const [admin, bob, alice, carol] = accounts;
const accountsUsed = [admin, bob, alice, carol];

const OPEN_FEE_PERC = new BN(30);
const CLOSE_FEE_PERC = new BN(30);
const DEPOSIT_FEE_PERC = new BN(30);
const WITHDRAW_FEE_PERC = new BN(30);
const TURBULENCE_PREMIUM_PERC_STEP = new BN(100);
const MAX_BUYING_PREMIUM_PERC = new BN(1000);
const MAX_FEE = new BN(10000);
const MAX_FUNDING_FEE = new BN(1000000);
const MAX_CVI_VALUE = new BN(20000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const INITIAL_RATE = toBN(1, 12);
const PRECISION_DECIMALS = toBN(1, 10);
    return bigNumber.mul(fee).div(MAX_FEE);
};

const getBNMinusFee = (bigNumber, fee) => {
    return bigNumber.mul(MAX_FEE.sub(fee)).div(MAX_FEE);
};

const getFee = (amount, fee) => {
    return getBNFee(toBN(amount), fee);
};

const getTokensMinusFee = (tokenAmount, fee) => {
    return getBNMinusFee(tokenAmount.mul(INITIAL_RATE), fee);
};

//TODO: Share a function for open and close events, nearly exact same code
const verifyOpenPositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    expect(event.event).to.equal('OpenPosition');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.account).to.equal(sender);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(feesAmount);
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
    expect(event.args.cviValue).to.be.bignumber.equal(new BN(cviValue));
};

const verifyClosePositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    expect(event.event).to.equal('ClosePosition');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.account).to.equal(sender);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(feesAmount);
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
    expect(event.args.cviValue).to.be.bignumber.equal(new BN(cviValue));
};

const verifyDepositEvent = async (event, sender, tokenAmount) => {
    const depositFees = await this.feesCalculator.depositFeePercent();

    expect(event.event).to.equal('Deposit');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(depositFees).div(MAX_FEE));
    expect(event.args.account).to.equal(sender);
};

const verifyWithdrawEvent = async (event, sender, tokenAmount) => {
    const withdrawFees = await this.feesCalculator.withdrawFeePercent();

    expect(event.event).to.equal('Withdraw');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(withdrawFees).div(MAX_FEE));
    expect(event.args.account).to.equal(sender);
};

const createState = () => {
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
        lpBalances
    };
};

const updateSnapshots = async () => {
    const latestTimestamp = await time.latest();
    const timestamp = latestTimestamp.toNumber();
    const latestCVIRound = (await this.fakeOracle.getCVILatestRoundData()).cviRoundId.toNumber();

    if (this.state.latestSnapshotTimestamp === undefined) {
        this.state.snapshots[timestamp] = PRECISION_DECIMALS;
    } else {
        let nextSnapshot = this.state.snapshots[this.state.latestSnapshotTimestamp];
        let lastTime = this.state.latestSnapshotTimestamp;
        let lastCVI = (await this.fakeOracle.getCVIRoundData(this.state.latestRound)).cviValue.toNumber();

        for (let round = this.state.latestRound; round < latestCVIRound; round++) {
            const currCVI = await this.fakeOracle.getCVIRoundData(round + 1);
            const currTimestamp = currCVI.cviTimestamp.toNumber();
            const timeDiff = currTimestamp - lastTime;
            nextSnapshot = nextSnapshot.add(calculateSingleUnitFee(lastCVI, timeDiff));
            lastCVI = currCVI.cviValue.toNumber();
            lastTime = currTimestamp;
        }

        let latestCVI = await this.fakeOracle.getCVIRoundData(latestCVIRound);
        nextSnapshot = nextSnapshot.add(calculateSingleUnitFee(latestCVI.cviValue.toNumber(), timestamp - lastTime));

        this.state.snapshots[timestamp] = nextSnapshot;
    }

    this.state.latestSnapshotTimestamp = timestamp;
    this.state.latestRound = latestCVIRound;

    /*console.log('snapshots');
    for (let key of Object.keys(this.state.snapshots)) {
        console.log(key + ' - ' + this.state.snapshots[key].toString());
    }*/

    return latestTimestamp;
};

const calculateFundingFees = (currTime, account, positionUnitsAmount) => {
    const position = this.state.positions[account];
    return (this.state.snapshots[currTime.toNumber()].sub(this.state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
};

const calculateDepositAmounts = async amount => {
    const depositFees = await this.feesCalculator.depositFeePercent();

    const depositTokens = new BN(amount);
    const depositTokenFees = getFee(amount, depositFees);
    const depositTokenMinusFees = depositTokens.sub(depositTokenFees);
    const lpTokens = getTokensMinusFee(depositTokens, depositFees);
    return { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens };
};

const calculateWithdrawAmounts = async amount => {
    const withdrawFees = await this.feesCalculator.withdrawFeePercent();

    const withdrawTokens = new BN(amount);
    const withdrawTokenFees = getFee(amount, withdrawFees);
    const withdrawTokenMinusFees = withdrawTokens.sub(withdrawTokenFees);
    const burnedLPTokens = withdrawTokens.mul(this.state.lpTokensSupply).sub(new BN(1)).div(this.state.sharedPool).add(new BN(1));
    return { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens };
};

const calculateOpenPositionAmounts = async amount => {
    const openPositionFees = await this.feesCalculator.openPositionFeePercent();
    const turbulencePercent = await this.feesCalculator.turbulenceIndicatorPercent(); //TODO: Take from state
    const premiumPercent = new BN(0); //TODO: Calculate premium

    const openPositionTokens = new BN(amount);
    const openPositionTokensFees = getFee(amount, openPositionFees.add(turbulencePercent).add(premiumPercent));
    const openPositionTokensMinusFees = openPositionTokens.sub(openPositionTokensFees);

    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

    const positionUnits = openPositionTokensMinusFees.mul(MAX_CVI_VALUE).div(cviValue);

    return { openPositionTokens, openPositionTokensFees, openPositionTokensMinusFees, positionUnits };
};

const calculatePositionBalance = async positionUnits => {
    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;
    return positionUnits.mul(cviValue).div(MAX_CVI_VALUE);
};

const validateLPState = async () => {
    expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(this.state.totalFeesSent);
    expect(await this.wethPlatform.totalSupply()).to.be.bignumber.equal(this.state.lpTokensSupply);
    expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(this.state.sharedPool);

    for (let account of Object.keys(this.state.lpBalances)) {
        expect(await this.wethPlatform.balanceOf(account)).to.be.bignumber.equal(this.state.lpBalances[account]);
    }
};

const deposit = (tokens, minLPTokens, account) => {
    if (this.isETH) {
        return this.wethPlatform.depositETH(minLPTokens, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.deposit(tokens, minLPTokens, {from: account});
    }
};

const withdraw = (tokens, maxLPTokensBurn, account) => {
    if (this.isETH) {
        return this.wethPlatform.withdrawETH(tokens, maxLPTokensBurn, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.withdraw(tokens, maxLPTokensBurn, {from: account});
    }
};

const callWithdraw = (tokens, maxLPTokensBurn, account) => {
    if (this.isETH) {
        return this.wethPlatform.withdrawETH.call(tokens, maxLPTokensBurn, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.withdraw.call(tokens, maxLPTokensBurn, {from: account});
    }
};

const openPosition = (tokens, cviValue, account) => {
    if (this.isETH) {
        return this.wethPlatform.openPositionETH(cviValue, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.openPosition(tokens, cviValue, {from: account});
    }
};

const closePosition = (positionUnits, cviValue, account) => {
    if (this.isETH) {
        return this.wethPlatform.closePositionETH(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.closePosition(positionUnits, cviValue, {from: account});
    }
};

const depositAndValidate = async (depositTokensNumber, account) => {
    const { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens } = await calculateDepositAmounts(depositTokensNumber);

    let beforeBalance;
    if (!this.isETH) {
        await this.token.transfer(account, depositTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, depositTokens, {from: account});
        beforeBalance = await this.token.balanceOf(account);
    } else {
        beforeBalance = await balance.current(account, 'wei');
    }

    const tx = await deposit(depositTokens, lpTokens, account);

    const depositTimestamp = await updateSnapshots();
    await verifyDepositEvent(tx.logs[0], account, depositTokens);

    let afterBalance;
    if (this.isETH) {
        afterBalance = await balance.current(account, 'wei');
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        afterBalance = await this.token.balanceOf(account);
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens);
    }

    this.state.lpTokensSupply = this.state.lpTokensSupply.add(lpTokens);
    this.state.sharedPool = this.state.sharedPool.add(depositTokenMinusFees);
    this.state.totalFeesSent = this.state.totalFeesSent.add(depositTokenFees);

    this.state.lpBalances[account] = this.state.lpBalances[account].add(lpTokens);

    await validateLPState();

    return depositTimestamp;
};

const withdrawAndValidate = async (withdrawTokensNumber, account) => {
    const { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens } = await calculateWithdrawAmounts(withdrawTokensNumber);

    const beforeBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    const result = await callWithdraw(withdrawTokens, burnedLPTokens, account);

    expect(result[0]).to.be.bignumber.equal(burnedLPTokens);
    expect(result[1]).to.be.bignumber.equal(withdrawTokenMinusFees);

    const tx = await withdraw(withdrawTokens, burnedLPTokens, account);

    await updateSnapshots();
    await verifyWithdrawEvent(tx.logs[0], account, withdrawTokens);

    const afterBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    this.state.totalFeesSent = this.state.totalFeesSent.add(withdrawTokenFees);
    this.state.lpTokensSupply = this.state.lpTokensSupply.sub(burnedLPTokens);
    this.state.sharedPool = this.state.sharedPool.sub(withdrawTokens);

    this.state.lpBalances[account] = this.state.lpBalances[account].sub(burnedLPTokens);

    await validateLPState();

    if (this.isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(withdrawTokenMinusFees.sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(withdrawTokenMinusFees);
    }
};

const validatePosition = (actualPosition, expectedPosition) => {
    expect(actualPosition.positionUnitsAmount).to.be.bignumber.equal(expectedPosition.positionUnitsAmount);
    expect(actualPosition.creationTimestamp).to.be.bignumber.equal(expectedPosition.creationTimestamp);
    expect(actualPosition.pendingFees).to.be.bignumber.equal(expectedPosition.pendingFees);
};

const openPositionAndValidate = async (amount, account) => {
    const isMerge = this.state.positions[account] !== undefined;
    const { openPositionTokens, openPositionTokensFees, openPositionTokensMinusFees, positionUnits } = await calculateOpenPositionAmounts(amount);

    if (!this.isETH) {
        await this.token.transfer(account, openPositionTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, openPositionTokens, {from: account});
    }

    const beforeBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;
    const tx = await openPosition(openPositionTokens, cviValue, alice);
    const timestamp = await updateSnapshots();

    let finalPositionUnits = positionUnits;
    let pendingFees = new BN(0);
    if (isMerge) {
        finalPositionUnits = finalPositionUnits.add(this.state.positions[account].positionUnitsAmount);
        pendingFees = this.state.positions[account].pendingFees.add(calculateFundingFees(timestamp, account, this.state.positions[account].positionUnitsAmount));
    }

    verifyOpenPositionEvent(tx.logs[0], alice, openPositionTokens, finalPositionUnits, cviValue, openPositionTokensFees);

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, pendingFees };
    const actualPosition = await this.wethPlatform.positions(account);
    validatePosition(actualPosition, expectedPosition);

    this.state.positions[account] = expectedPosition;

    this.state.totalFeesSent = this.state.totalFeesSent.add(openPositionTokensFees);
    this.state.sharedPool = this.state.sharedPool.add(openPositionTokensMinusFees);

    await validateLPState();

    const afterBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    if (this.isETH) {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens);
    }

    return {positionUnits, timestamp};
};

const validateEmptyPosition = position => {
    expect(position.positionUnitsAmount).to.be.bignumber.equal(new BN(0));
    expect(position.creationTimestamp).to.be.bignumber.equal(new BN(0));
    expect(position.pendingFees).to.be.bignumber.equal(new BN(0));
};

const closePositionAndValidate = async (positionUnits, account) => {
    const positionBalance = await calculatePositionBalance(positionUnits);

    const beforeBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;
    //const tx = await this.wethPlatform.closePosition(positionUnits, cviValue, {from: account});
    const tx = await closePosition(positionUnits, cviValue, account);
    const timestamp = await updateSnapshots();

    const fundingFees = calculateFundingFees(timestamp, account, positionUnits);
    const positionBalanceAfterFundingFees = positionBalance.sub(fundingFees);
    const openFees = await this.feesCalculator.openPositionFeePercent();
    const closePositionTokensFees = getFee(positionBalanceAfterFundingFees, openFees);
    const totalFees = closePositionTokensFees.add(fundingFees);
    verifyClosePositionEvent(tx.logs[0], account, positionBalance, this.state.positions[account].positionUnitsAmount.sub(positionUnits), cviValue, totalFees);

    const afterBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    const currPosition = this.state.positions[account];
    currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(positionUnits);

    if (currPosition.positionUnitsAmount.toNumber() === 0) {
        const actualPosition = await this.wethPlatform.positions(account);
        validateEmptyPosition(actualPosition);
    } else {
        const actualPosition = await this.wethPlatform.positions(account);
        validatePosition(actualPosition, currPosition);
    }

    this.state.totalFeesSent = this.state.totalFeesSent.add(closePositionTokensFees);
    this.state.sharedPool = this.state.sharedPool.sub(positionBalance).add(fundingFees);

    await validateLPState();

    if (this.isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees).sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees));
    }
};

const leftTokensToWithdraw = async account => {
    const totalSupply = await this.wethPlatform.totalSupply();
    const totalBalance = await this.token.balanceOf(this.wethPlatform.address);
    const leftTokens = (await this.wethPlatform.balanceOf(account)).mul(totalBalance).div(totalSupply);

    return leftTokens;
};

const testMultipleAccountsDepositWithdraw = async (depositFee, withdrawFee) => {
    await this.feesCalculator.setDepositFee(depositFee, {from: admin});
    await this.feesCalculator.setWithdrawFee(withdrawFee, {from: admin});

    await depositAndValidate(5000, bob);
    await depositAndValidate(1000, alice);

    await time.increase(3 * 24 * 60 * 60);

    await withdrawAndValidate(1000, bob);
    await depositAndValidate(3000, carol);
    await withdrawAndValidate(500, alice);

    await time.increase(3 * 24 * 60 * 60);

    if (depositFee.toNumber() === 0 && withdrawFee.toNumber() === 0) {
        await withdrawAndValidate(500, alice);
        await withdrawAndValidate(3000, carol);
    } else {
        let leftTokens = await leftTokensToWithdraw(alice);
        await withdrawAndValidate(leftTokens, alice);

        leftTokens = await leftTokensToWithdraw(carol);
        await withdrawAndValidate(leftTokens, carol);
    }

    expect(await this.wethPlatform.balanceOf(carol)).is.bignumber.equal(new BN(0));
    expect(await this.wethPlatform.balanceOf(alice)).is.bignumber.equal(new BN(0));
};

const calculationsForBuyingPremium = async(cviValue, openTokenAmount, previousPositionUnits) => {
    let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
    let openPositionFee = openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE);
    let positionUnitsAmountWithoutPremium = (openTokenAmount.sub(openPositionFee)).div(cviValue).mul(MAX_CVI_VALUE);
    let minPositionUnitsAmount = positionUnitsAmountWithoutPremium.mul(new BN(90)).div(new BN(100));
    let totalPositionUnitsAmount =  await this.wethPlatform.totalPositionUnitsAmount();

    let tokensInSharedPoolBalance = await this.token.balanceOf(this.wethPlatform.address);
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
    this.isETH = isETH;
    this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(100000), 18, {from: admin});
    this.token = isETH ? await WETH9.new({from: admin}) :  await FakeERC20.new('DAI', 'DAI', toTokenAmount(100000), 18, {from: admin});
    this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
    this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
    this.feesCalculator = await FeesCalculator.new({from: admin});
    this.feeModel = await FeesModel.new(this.feesCalculator.address, this.fakeOracle.address, {from: admin});
    this.fakeFeesCollector = await fakeFeesCollector.new(this.token.address, {from: admin});
    this.rewards = await Rewards.new(this.cviToken.address, {from: admin});
    this.liquidation = await Liquidation.new({from: admin});

    if (isETH) {
        this.wethPlatform = await ETHPlatform.new(
            this.token.address, 'ETH-LP', 'ETH-LP', INITIAL_RATE, this.feeModel.address,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});
    } else {
        this.wethPlatform = await Platform.new(
            this.token.address, 'WETH-LP', 'WETH-LP', INITIAL_RATE, this.feeModel.address,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});
    }

    this.state = createState();

    this.rewards.setRewarder(this.wethPlatform.address, {from: admin});
    this.feesCalculator.setTurbulenceUpdator(this.feeModel.address, {from: admin});

    await this.wethPlatform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});
    await this.wethPlatform.setRewards(this.rewards.address, {from: admin});

    await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, {from: admin});
    await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, {from: admin});

    let cviValue = toCVI(5000);
    await this.fakePriceProvider.setPrice(cviValue);
};

const setPlatformTests = isETH => {
    it('reverts when deposit gives less than min LP tokens', async () => {
        const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } = await calculateDepositAmounts(5000);

        if (!this.isETH) {
            await this.token.transfer(bob, bobDepositTokens, {from: admin});
            await this.token.approve(this.wethPlatform.address, bobLPTokens, {from: bob});
        }

        await expectRevert(deposit(bobDepositTokens, bobLPTokens.add(new BN(1)), bob), 'Too few LP tokens');
    });

    if (!isETH) {
        it('reverts when depositing and not enough tokens are allowed', async() => {
            const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } =
                await calculateDepositAmounts(5000);

            await this.token.transfer(bob, bobDepositTokens, {from: admin});

            await expectRevert(deposit(bobDepositTokens, bobLPTokens, bob), 'ERC20: transfer amount exceeds allowance');
            await this.token.approve(this.wethPlatform.address, bobDepositTokens.sub(new BN(1)), {from: bob});
            await expectRevert(deposit(bobDepositTokens, bobLPTokens, bob), 'ERC20: transfer amount exceeds allowance');
            await this.token.approve(this.wethPlatform.address, bobLPTokens, {from: bob});

            await this.wethPlatform.deposit(bobDepositTokens, bobLPTokens, {from: bob});
        });
    }

    it('deposits liquidity correctly', async () => {
        await depositAndValidate(5000, bob);
        await depositAndValidate(1000, bob);
        await depositAndValidate(2000, alice);
    });

    it('withdraws all lp tokens correctly', async () => {
        const bobDepositTokensNumber = 1000;
        const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } =
            await calculateDepositAmounts(bobDepositTokensNumber);

        await this.token.transfer(bob, bobDepositTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, bobDepositTokens, {from: bob});

        await this.wethPlatform.deposit(bobDepositTokens, bobLPTokens, {from: bob});

        let bobLPTokensBalance = await this.wethPlatform.balanceOf(bob);

        await time.increase(3 * SECONDS_PER_DAY);

        await this.wethPlatform.withdrawLPTokens(bobLPTokensBalance, {from: bob});

        expect(await this.wethPlatform.balanceOf(bob)).to.be.bignumber.equal(new BN(0));
    });

    it('reverts when withdrawing locked funds', async () => {
        const depositTimestamp = await depositAndValidate(5000, bob);

        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(24 * 60 * 60)));
        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60 - 1)));
        await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked');
        await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60)));

        await withdraw(toBN(1), toTokenAmount(1000000), bob);
    });

    it('reverts when withdrawing a zero amount', async () => {
        await expectRevert(withdraw(toBN(0), toTokenAmount(1000000), bob), 'Tokens amount must be positive');
    });

    it('reverts when withdraw results in burning more than max requested LP tokens', async () => {
        await depositAndValidate(5000, bob);
        const { withdrawTokens, burnedLPTokens } = await calculateWithdrawAmounts(5000);

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(withdrawTokens, burnedLPTokens.sub(new BN(1)), bob), 'Too much LP tokens to burn');
    });

    it('reverts when withdrawing with not enough LP tokens in account balance', async () => {
        await depositAndValidate(5000, bob);
        const { withdrawTokens, burnedLPTokens } = await calculateWithdrawAmounts(5001);

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(withdrawTokens, burnedLPTokens, bob), 'Not enough LP tokens for account');
    });

    it('withdraws liquidity correctly', async () => {
        await depositAndValidate(5000, bob);

        await time.increase(3 * 24 * 60 * 60);

        await withdrawAndValidate(1000, bob);
        await withdrawAndValidate(500, bob);
        await withdrawAndValidate(2000, bob);

        const leftTokens = await leftTokensToWithdraw(bob);
        await withdrawAndValidate(leftTokens, bob);

        expect(await this.wethPlatform.balanceOf(bob)).is.bignumber.equal(new BN(0));
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

    it('allows emergency withdraw if set even when collateral is broken but keeps lock', async () => {
        await depositAndValidate(toTokenAmount(5000), bob);

        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(alice, toTokenAmount(1000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(1000), {from: alice});

        await this.wethPlatform.openPosition(toTokenAmount(1000), 20000, {from: alice});

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(this.wethPlatform.withdraw(toTokenAmount(3000), toBN(3, 40), {from: bob}), 'Collateral ratio broken');
        await this.wethPlatform.setEmergencyWithdrawAllowed(true, {from: admin});
        await this.wethPlatform.withdraw(toTokenAmount(3000), toBN(3, 40), {from: bob});

        await this.token.transfer(bob, toTokenAmount(5000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(5000), {from: bob});
        await this.wethPlatform.deposit(toTokenAmount(5000), toBN(0), {from: bob});

        await expectRevert(this.wethPlatform.withdraw(toTokenAmount(3000), toBN(3, 40), {from: bob}), 'Funds are locked');

        await time.increase(3 * 24 * 60 * 60);

        await this.wethPlatform.setEmergencyWithdrawAllowed(false, {from: admin});
        await expectRevert(this.wethPlatform.withdraw(toTokenAmount(5000), toBN(5, 40), {from: bob}), 'Collateral ratio broken');

    });

    it('allows complete shutdown of all operations by setters', async () => {
        await this.wethPlatform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await expectRevert(depositAndValidate(toTokenAmount(5000), bob), 'revert');

        await this.wethPlatform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await depositAndValidate(toTokenAmount(5000), bob);
        await this.wethPlatform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(this.wethPlatform.withdraw(toTokenAmount(1000), toBN(1, 40), {from: bob}), 'revert');
        await expectRevert(this.wethPlatform.withdrawLPTokens(toTokenAmount(1000), {from: bob}), 'revert');

        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(alice, toTokenAmount(1000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(1000), {from: alice});

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(1000), 20000, {from: alice}), 'revert');

        await this.wethPlatform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await this.wethPlatform.openPosition(toTokenAmount(1000), 20000, {from: alice});

        await time.increase(24 * 60 * 60);

        await this.wethPlatform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await expectRevert(this.wethPlatform.closePosition(toTokenAmount(1000), 5000, {from: alice}), 'revert');

        await this.wethPlatform.setLiquidation(ZERO_ADDRESS, {from: admin});
        await expectRevert(this.wethPlatform.liquidatePositions([bob], {from: carol}), 'revert');

        await this.wethPlatform.setLiquidation(this.liquidation.address, {from: admin});
        await expectRevert(this.wethPlatform.liquidatePositions([bob], {from: carol}), 'No reported position was found to be liquidatable');
    });

    it('reverts when opening a position with zero tokens', async () => {
        await expectRevert(this.wethPlatform.openPosition(0, 20000, {from: alice}), 'Tokens amount must be positive');
    });

    it('reverts when opening a position with a bad max CVI value', async () => {
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 0, {from: alice}), 'Bad max CVI value');
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 20001, {from: alice}), 'Bad max CVI value');
    });

    it('reverts when opening a position with CVI value higher than max CVI', async () => {
        await depositAndValidate(toTokenAmount(40000), bob);

        await this.token.transfer(alice, toTokenAmount(10000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(10000), {from: alice});

        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 4999, {from: alice}), 'CVI too high');

        cviValue = toCVI(6000);
        await this.fakePriceProvider.setPrice(cviValue);
        await this.wethPlatform.openPosition(toTokenAmount(5000), 6000, {from: alice});
        await this.wethPlatform.openPosition(toTokenAmount(5000), 6001, {from: alice});
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 5999, {from: alice}), 'CVI too high');
    });

    it('reverts if not enough liquidity expected after openning a position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        tx = await this.wethPlatform.withdraw(bobSecondWithdrawTokens, bobSecondBurnedLPTokens, {from: bob});
        /*
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice}), 'Not enough liquidity');
        await depositAndValidate(toTokenAmount(3000), bob);
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice}), 'Not enough liquidity');
        await depositAndValidate(toTokenAmount(10), bob);

        console.log(this.state.sharedPool.toString());

        await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});*/
    });

    it('opens a position properly', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        await depositAndValidate(20000, bob);
        await openPositionAndValidate(5000, alice);
    });

    it('merges a position properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(toTokenAmount(60000), bob);
        await openPositionAndValidate(toTokenAmount(5000), alice);

        // To avoid turbulence
        await time.increase(60 * 60);

        await this.fakePriceProvider.setPrice(toCVI(6000));
        await openPositionAndValidate(toTokenAmount(1000), alice);

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

    it('reverts when trying to close too many positional units', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(this.wethPlatform.closePosition(1, 5000, {from: alice}), 'Not enough opened position units');
        await depositAndValidate(toTokenAmount(4), bob);
        await expectRevert(this.wethPlatform.closePosition(1, 5000, {from: alice}), 'Not enough opened position units');
        const {positionUnits} = await openPositionAndValidate(toTokenAmount(1), alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(this.wethPlatform.closePosition(positionUnits.add(new BN(1)), 5000, {from: alice}), 'Not enough opened position units');
        await closePositionAndValidate(positionUnits, alice);
    });

    it('reverts when closing zero position units', async () => {
        await depositAndValidate(5000, bob);
        await openPositionAndValidate(1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(0, 5000, alice), 'Position units not positive');
    });

    it('reverts when closing a position with an invalid min CVI value', async () => {
        await depositAndValidate(5000, bob);
        const {positionUnits} = await openPositionAndValidate(1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(positionUnits, 0, alice), 'Bad min CVI value');
        await expectRevert(closePosition(positionUnits, 20001, alice), 'Bad min CVI value');

        await closePosition(positionUnits, 5000, alice);
    });

    it('reverts when closing a position while locked', async () => {
        await depositAndValidate(5000, bob);
        const {positionUnits, timestamp} = await openPositionAndValidate(1000, alice);

        await time.increaseTo(timestamp.add(new BN(23 * 60 * 60)));
        await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked');
        await time.increaseTo(timestamp.add(new BN(24 * 60 * 60 - 15)));
        await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked');

        await time.increaseTo(timestamp.add(new BN(24 * 60 * 60)));
        await closePosition(positionUnits, 5000, alice);
    });

    it('reverts when closing a position with CVI below min CVI', async () => {
        await depositAndValidate(5000, bob);
        const {positionUnits} = await openPositionAndValidate(1000, alice);

        await time.increase(24 * 60 * 60);

        await expectRevert(closePosition(positionUnits, 5001, alice), 'CVI too low');

        await this.fakePriceProvider.setPrice(toCVI(6000));

        await expectRevert(closePosition(positionUnits, 6001, alice), 'CVI too low');
        await closePosition(positionUnits, 6000, alice);
    });

    it('closes a position properly', async () => {
        await depositAndValidate(5000, bob);
        const {positionUnits} = await openPositionAndValidate(1000, alice);

        await time.increase(24 * 60 * 60);

        await closePositionAndValidate(positionUnits, alice);
    });

    it('closes part of a position properly', async () => {
        await depositAndValidate(5000, bob);
        const {positionUnits} = await openPositionAndValidate(1000, alice);

        await time.increase(24 * 60 * 60);

        await closePositionAndValidate(positionUnits.div(new BN(3)), alice);

        await time.increase(24 * 60 * 60);

        await closePositionAndValidate(positionUnits.div(new BN(2)), alice);
    });

    it('withdraws all lp tokens prevented due to collateral ratio restrictions', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});
        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let bobLPTokensBalance = await this.wethPlatform.balanceOf(bob);

        await time.increase(3 * SECONDS_PER_DAY);

        let tx = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
        let currPositionUnits = toTokenAmount(1000).mul(new BN(4)).mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(currTurbulence)).div(MAX_FEE);
        let feesAmount = toTokenAmount(1000).mul(OPEN_FEE_PERC.add(currTurbulence)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, toTokenAmount(1000), currPositionUnits, cviValueFromOracle, feesAmount);

        await expectRevert(this.wethPlatform.withdrawLPTokens(bobLPTokensBalance, {from: bob}), 'Collateral ratio broken');
    });

    it('Verify turbulence premium ', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});
        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let bobLPTokensBalance = await this.wethPlatform.balanceOf(bob);

        await time.increase( 1800 );
        await this.fakePriceProvider.setPrice(cviValue);

        await this.feeModel.updateSnapshots();

        let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();
        expect(currTurbulence).to.be.bignumber.equal(TURBULENCE_PREMIUM_PERC_STEP);

        let tx = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
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

        let tx2 = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let currPositionUnits2 = currPositionUnits.add(toTokenAmount(1000).mul(new BN(4)).mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(currTurbulence)).div(MAX_FEE));
        let newFeesAmount = toTokenAmount(1000).mul(OPEN_FEE_PERC.add(currTurbulence)).div(MAX_FEE);
        verifyOpenPositionEvent(tx2.logs[0], alice, toTokenAmount(1000), currPositionUnits2, cviValueFromOracle, newFeesAmount);
    });

    it('opens first position properly for a high collateral ratio', async () => {
        let cviValue = toCVI(4000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        let depositTokenAmount = toTokenAmount(5000);
        await this.wethPlatform.deposit(depositTokenAmount, toTokenAmount(48500), {from: bob});
        let feesTokens = depositTokenAmount.mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = depositTokenAmount.mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let openTokenAmount = toTokenAmount(1250);

        let currPositionUnits;
        let combineedBuyingPremiumPercent;
        let collateralRatio;
        let minPositionUnitsAmount;
        let previousPositionUnits = new BN(0);
        [currPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount] = await calculationsForBuyingPremium(cviValueFromOracle, openTokenAmount, previousPositionUnits);

        let tx = await this.wethPlatform.openPosition(openTokenAmount, 10000, {from: alice});
        let feesAmount = openTokenAmount.mul(OPEN_FEE_PERC.add(combineedBuyingPremiumPercent)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, openTokenAmount, currPositionUnits, cviValueFromOracle, feesAmount);

        tokensInSharedPool = tokensInSharedPool.add(openTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal( toTokenAmount(50000).sub(openTokenAmount) );
    });

    it('opens two positions properly for a high collateral ratio', async () => {
        let cviValue = toCVI(4000);
        await this.fakePriceProvider.setPrice(cviValue);
        const cviValueFromOracle = (await this.fakeOracle.getCVILatestRoundData()).cviValue;

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        let depositTokenAmount = toTokenAmount(5000);
        await this.wethPlatform.deposit(depositTokenAmount, toTokenAmount(48500), {from: bob});
        let feesTokens = depositTokenAmount.mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = depositTokenAmount.mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        let openTokenAmount = toTokenAmount(750);
        let currPositionUnits;
        let combineedBuyingPremiumPercent;
        let collateralRatio;
        let minPositionUnitsAmount;
        let previousPositionUnits = new BN(0);
        [currPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount] = await calculationsForBuyingPremium(cviValueFromOracle, openTokenAmount, previousPositionUnits);

        let tx = await this.wethPlatform.openPosition(openTokenAmount, 10000, {from: alice});
        let feesAmount = openTokenAmount.mul(OPEN_FEE_PERC.add(combineedBuyingPremiumPercent)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, openTokenAmount, currPositionUnits, cviValueFromOracle, feesAmount);
        tokensInSharedPool = tokensInSharedPool.add(openTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));

        let newOpenTokenAmount = toTokenAmount(500);
        [currPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount] = await calculationsForBuyingPremium(cviValueFromOracle, newOpenTokenAmount, currPositionUnits);

        tx = await this.wethPlatform.openPosition(newOpenTokenAmount, 10000, {from: alice});
        let newFeesAmount = newOpenTokenAmount.mul(OPEN_FEE_PERC.add(combineedBuyingPremiumPercent)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, newOpenTokenAmount, currPositionUnits, cviValueFromOracle, newFeesAmount);

        tokensInSharedPool = tokensInSharedPool.add(newOpenTokenAmount.mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(newOpenTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal( toTokenAmount(50000).sub(openTokenAmount).sub(newOpenTokenAmount) );
    });
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
