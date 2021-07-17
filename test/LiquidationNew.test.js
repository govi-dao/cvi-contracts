const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence} = require('./utils/FeesUtils.js');
const { print } = require('./utils/DebugUtils');

const Platform = contract.fromArtifact('Platform');
const ETHPlatform = contract.fromArtifact('ETHPlatform');
const CVIOracle = contract.fromArtifact('CVIOracle');
const Rewards = contract.fromArtifact('Rewards');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const fakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const Liquidation = contract.fromArtifact('Liquidation');

const expect = chai.expect;
const [admin, bob, alice, carol] = accounts;
const accountsUsed = [admin, bob, alice, carol];

const OPEN_FEE_PERC = new BN(30);
const CLOSE_FEE_PERC = new BN(30);
const DEPOSIT_FEE_PERC = new BN(0); //new BN(30);
const WITHDRAW_FEE_PERC = new BN(0); //new BN(30);
const TURBULENCE_PREMIUM_PERC_STEP = new BN(100);
const MAX_BUYING_PREMIUM_PERC = new BN(1000);
const MAX_FEE = new BN(10000);
const MAX_FUNDING_FEE = new BN(1000000);
const MAX_CVI_VALUE = new BN(20000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const LIQUIDATION_MIN_THRESHOLD = toBN(50);
const LIQUIDATION_MIN_REWARD_AMOUNT = toBN(5);
const LIQUIDATION_MAX_REWARD_AMOUNT  = toBN(30);
const LIQUIDATION_MAX_FEE_PERCENTAGE = toBN(1000);

const INITIAL_RATE = toBN(1, 12);
const PRECISION_DECIMALS = toBN(1, 10);

const GAS_PRICE = toBN(1, 10);

const HEARTBEAT = new BN(55 * 60);

const getBNFee = (bigNumber, fee) => {
    return bigNumber.mul(fee).div(MAX_FEE);
};

const getFee = (amount, fee) => {
    return getBNFee(toBN(amount), fee);
};

const verifyOpenPositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    expect(event.event).to.equal('OpenPosition');
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

const verifyLiquidatePositionEvent = (event, positionAddress, currentPositionBalance, isBalancePositive, positionUnitsAmount) => {
    expect(event.event).to.equal('LiquidatePosition');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.positionAddress).to.equal(positionAddress);
    expect(event.args.currentPositionBalance).to.be.bignumber.equal(currentPositionBalance);
    expect(event.args.isBalancePositive).to.equal(isBalancePositive);
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
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
        turbulence: new BN(0),
        lpBalances
    };
};

const validateLPState = async () => {
    const feesBalance = this.isETH ? await balance.current(this.fakeFeesCollector.address, 'wei') :
        await this.fakeFeesCollector.getProfit();
    expect(feesBalance).to.be.bignumber.equal(this.state.totalFeesSent);
    expect(await this.wethPlatform.totalSupply()).to.be.bignumber.equal(this.state.lpTokensSupply);

    const contractBalance = this.isETH ? await balance.current(this.wethPlatform.address, 'wei') :
        await this.token.balanceOf(this.wethPlatform.address);

    expect(contractBalance).to.be.bignumber.equal(this.state.sharedPool);

    expect(await this.wethPlatform.totalPositionUnitsAmount()).to.be.bignumber.equal(this.state.totalPositionUnits);
    expect(await this.wethPlatform.totalFundingFeesAmount()).to.be.bignumber.equal(this.state.totalFundingFees);

    for (let account of Object.keys(this.state.lpBalances)) {
        expect(await this.wethPlatform.balanceOf(account)).to.be.bignumber.equal(this.state.lpBalances[account]);
    }

    expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(this.state.turbulence);
};

const updateSnapshots = async () => {
    const latestTimestamp = await time.latest();
    const timestamp = latestTimestamp.toNumber();
    const latestCVIRound = (await this.fakeOracle.getCVILatestRoundData()).cviRoundId.toNumber();

    if (this.state.latestSnapshotTimestamp === undefined) {
        this.state.snapshots[timestamp] = PRECISION_DECIMALS;
    } else {
        let nextSnapshot = this.state.snapshots[this.state.latestSnapshotTimestamp];
        const lastTime = this.state.latestSnapshotTimestamp;
        const lastCVIRound = await this.fakeOracle.getCVIRoundData(this.state.latestRound);
        const lastCVI = lastCVIRound.cviValue.toNumber();
        const lastTimestamp = lastCVIRound.cviTimestamp.toNumber();
        let fundingFeesPerUnit;

        if (latestCVIRound === this.state.latestRound) {
            fundingFeesPerUnit = calculateSingleUnitFee(lastCVI, timestamp - lastTime);
            nextSnapshot = nextSnapshot.add(fundingFeesPerUnit);
        } else {
            const currCVI = await this.fakeOracle.getCVIRoundData(latestCVIRound);
            const currTimestamp = currCVI.cviTimestamp.toNumber();
            const currCVIValue = currCVI.cviValue.toNumber();

            fundingFeesPerUnit = calculateSingleUnitFee(lastCVI, currTimestamp - lastTime).add(
                calculateSingleUnitFee(currCVIValue, timestamp - currTimestamp));
            nextSnapshot = nextSnapshot.add(fundingFeesPerUnit);

            this.state.turbulence = calculateNextAverageTurbulence(this.state.turbulence, new BN(currTimestamp - lastTimestamp), HEARTBEAT, latestCVIRound - this.state.latestRound);
        }

        this.state.totalFundingFees = this.state.totalFundingFees.add(fundingFeesPerUnit.mul(this.state.totalPositionUnits).div(PRECISION_DECIMALS));
        this.state.snapshots[timestamp] = nextSnapshot;
    }

    this.state.latestSnapshotTimestamp = timestamp;
    this.state.latestRound = latestCVIRound;

    expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(this.state.turbulence);

    return latestTimestamp;
};

const calculateFundingFees = (currTime, account, positionUnitsAmount) => {
    const position = this.state.positions[account];
    return (this.state.snapshots[currTime.toNumber()].sub(this.state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
};

const calculateBalance = async () => {
    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;
    return this.state.sharedPool.sub(this.state.totalPositionUnits.mul(cviValue).div(MAX_CVI_VALUE)).add(this.state.totalFundingFees);
};

const calculateLPTokens = async tokens => {
    const balance = await calculateBalance();

    if (balance.eq(new BN(0)) || this.state.lpTokensSupply.eq(new BN(0))) {
        return tokens.mul(INITIAL_RATE);
    }

    return tokens.mul(this.state.lpTokensSupply).div(balance);
};

const calculateDepositAmounts = async amount => {
    const depositFees = await this.feesCalculator.depositFeePercent();

    const depositTokens = new BN(amount);
    const depositTokenFees = getFee(amount, depositFees);
    const depositTokenMinusFees = depositTokens.sub(depositTokenFees);
    const lpTokens = await calculateLPTokens(depositTokenMinusFees);
    return { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens };
};

const calculateOpenPositionAmounts = async amount => {
    const openPositionFees = await this.feesCalculator.openPositionFeePercent();
    const turbulencePercent = await this.feesCalculator.turbulenceIndicatorPercent();
    const premiumPercent = new BN(0);

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

const deposit = (tokens, minLPTokens, account) => {
    if (this.isETH) {
        return this.wethPlatform.depositETH(minLPTokens, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.deposit(tokens, minLPTokens, {from: account});
    }
};

const openPosition = (tokens, cviValue, account, maxBuyingPremiumPercent = 10000, leverageOpen = 1) => {
    if (this.isETH) {
        return this.wethPlatform.openPositionETH(cviValue, maxBuyingPremiumPercent, leverageOpen, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.openPosition(tokens, cviValue, maxBuyingPremiumPercent, leverageOpen, {from: account});
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

    //console.log('DEPOSIT: ' + tx.receipt.gasUsed.toString());

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

const validatePosition = (actualPosition, expectedPosition) => {
    expect(actualPosition.positionUnitsAmount).to.be.bignumber.equal(expectedPosition.positionUnitsAmount);
    expect(actualPosition.creationTimestamp).to.be.bignumber.equal(expectedPosition.creationTimestamp);
    //expect(actualPosition.pendingFees).to.be.bignumber.equal(expectedPosition.pendingFees);
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

    //console.log('OPEN: ' + tx.receipt.gasUsed.toString());

    let finalPositionUnits = positionUnits;
    let additionalPositionUnits = positionUnits;
    if (isMerge) {
        const fundingFees = calculateFundingFees(timestamp, account, this.state.positions[account].positionUnitsAmount);
        const positionBalance = this.state.positions[account].positionUnitsAmount.mul(cviValue).div(MAX_CVI_VALUE).sub(fundingFees).add(openPositionTokensMinusFees);
        finalPositionUnits = positionBalance.mul(MAX_CVI_VALUE).div(cviValue);
        additionalPositionUnits = finalPositionUnits.sub(this.state.positions[account].positionUnitsAmount);

        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
    }

    verifyOpenPositionEvent(tx.logs[0], alice, openPositionTokens, additionalPositionUnits, cviValue, openPositionTokensFees);

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp };
    const actualPosition = await this.wethPlatform.positions(account);
    validatePosition(actualPosition, expectedPosition);

    this.state.positions[account] = expectedPosition;

    this.state.totalPositionUnits = this.state.totalPositionUnits.add(additionalPositionUnits);
    this.state.totalFeesSent = this.state.totalFeesSent.add(openPositionTokensFees);
    this.state.sharedPool = this.state.sharedPool.add(openPositionTokensMinusFees);

    await validateLPState();

    const afterBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    if (this.isETH) {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens.add((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens);
    }

    return {positionUnits: additionalPositionUnits, timestamp};
};

const calculateContractPositionBalance = async account => {
    const result = await this.wethPlatform.calculatePositionBalance(account);
    print(result);

    return result;
};

const getTotals = async () => {
    const totalPositionUnitsAmount =  await this.wethPlatform.totalPositionUnitsAmount();
    const totalFundingFeesAmount =  await this.wethPlatform.totalFundingFeesAmount();
    const totalLeveragedTokensAmount =  await this.wethPlatform.totalLeveragedTokensAmount();

    print('totalPositionUnitsAmount = ', totalPositionUnitsAmount.toString(), ' totalFundingFeesAmount = ', totalFundingFeesAmount.toString(),
            ' totalLeveragedTokensAmount = ', totalLeveragedTokensAmount.toString());

    return [totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount];
};

const getLiquidationReward = async (positionBalance, isPositive, positionUnitsAmount, openCVIValue = 5000) => {
    let isToBeLiquidated = await this.liquidation.isLiquidationCandidate(positionBalance, isPositive, positionUnitsAmount, 5000, 1, {from: admin});
    if (!isToBeLiquidated) {
        return toBN(0);
    }

    const balance = positionUnitsAmount.mul(new BN(openCVIValue)).div(MAX_CVI_VALUE);

    if (!isPositive || toBN(positionBalance) < balance.mul(LIQUIDATION_MIN_REWARD_AMOUNT).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) {
        return toBN(balance.mul(LIQUIDATION_MIN_REWARD_AMOUNT).div(LIQUIDATION_MAX_FEE_PERCENTAGE));
    }

    if (isPositive && toBN(positionBalance).gte(balance.mul(LIQUIDATION_MIN_REWARD_AMOUNT).div(LIQUIDATION_MAX_FEE_PERCENTAGE) )
        && toBN(positionBalance).lte( toBN(balance).mul(LIQUIDATION_MAX_REWARD_AMOUNT).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) ) {
            return toBN(positionBalance);
    }

    return balance.mul(LIQUIDATION_MAX_REWARD_AMOUNT).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
};

const liquidateAndValidate = async account => {
    let expectedFinderFeeAmount = new BN(0);

    const { currentPositionBalance, isPositive, positionUnitsAmount, leverage, fundingFees, marginDebt} = await calculateContractPositionBalance(account);

    const isToBeLiquidated = await this.liquidation.isLiquidationCandidate(currentPositionBalance, isPositive, positionUnitsAmount, 5000, 1, {from: admin});

    if (isToBeLiquidated) {
        const tx = await this.wethPlatform.liquidatePositions([alice], {from: admin});
        await verifyLiquidatePositionEvent(tx.logs[0], account, currentPositionBalance, isPositive, positionUnitsAmount);

        const expectedPosition = { positionUnitsAmount: toBN(0), creationTimestamp: toBN(0) };
        const actualPosition = await this.wethPlatform.positions(account);
        validatePosition(actualPosition, expectedPosition);

        await expectRevert(this.wethPlatform.calculatePositionBalance(account, {from: admin}), 'No position for given address');
        const currPosition = this.state.positions[account];
        currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(positionUnitsAmount);
        expect( toBN(currPosition.positionUnitsAmount.toNumber())).to.be.bignumber.equal(toBN(0));

        this.state.totalPositionUnits = this.state.totalPositionUnits.sub(positionUnitsAmount);
        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
        this.state.positions[account] = expectedPosition;

        expectedFinderFeeAmount = toBN(await getLiquidationReward(currentPositionBalance, isPositive, positionUnitsAmount));
        const finderFeeAmount = await this.liquidation.getLiquidationReward(currentPositionBalance, isPositive, positionUnitsAmount, 5000, 1, {from: admin});
        expect(expectedFinderFeeAmount).to.be.bignumber.equal(finderFeeAmount);

        this.state.sharedPool = this.state.sharedPool.sub(expectedFinderFeeAmount);
    } else {
        await expectRevert(this.wethPlatform.liquidatePositions([alice], {from: admin}), 'No liquidatable position');
    }

    await validateLPState();
    return expectedFinderFeeAmount;
};


const beforeEachPlatform = async isETH => {
    this.isETH = isETH;
    this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(100000), 18, {from: admin});

    if (!isETH) {
        this.token = await FakeERC20.new('DAI', 'DAI', toTokenAmount(100000), 18, {from: admin});
    }

    this.tokenAddress = isETH ? ZERO_ADDRESS : this.token.address;
    this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
    this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
    this.feesCalculator = await FeesCalculator.new({from: admin});
    this.fakeFeesCollector = await fakeFeesCollector.new(this.tokenAddress, {from: admin});
    this.rewards = await Rewards.new(this.cviToken.address, {from: admin});
    this.liquidation = await Liquidation.new({from: admin});

    if (isETH) {
        this.wethPlatform = await ETHPlatform.new(
            'ETH-LP', 'ETH-LP', INITIAL_RATE,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});
    } else {
        this.wethPlatform = await Platform.new(
            this.tokenAddress, 'WETH-LP', 'WETH-LP', INITIAL_RATE,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});
    }

    this.state = createState();

    this.rewards.setRewarder(this.wethPlatform.address, {from: admin});
    this.feesCalculator.setTurbulenceUpdator(this.wethPlatform.address, {from: admin});

    await this.wethPlatform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});

    await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, {from: admin});
    await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, {from: admin});

    let cviValue = toCVI(5000);
    await this.fakePriceProvider.setPrice(cviValue);
};

const setPlatformTests = isETH => {
    it('opens a position calculate time until liquidation', async () => {
        let cviValue = toCVI(5000);

        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(50000, bob);

        let txAlice = await openPosition(1000, 5000, alice);
        const {daysBeforeLiquidationAlice, liquidationThresholdAlice} = await calculateDaysBeforeLiquidation(alice);

        await time.increase(86400 * (daysBeforeLiquidationAlice) );
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsAmountTwo} = resultAliceTwo;
        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsAmountTwo, 5000, 1, {from: admin})).to.be.false;

        const { daysBeforeLiquidation } = await calculateDaysBeforeLiquidation(alice, new BN(5000));

        await time.increase(SECONDS_PER_DAY.mul(daysBeforeLiquidation));
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        const timestamp = await updateSnapshots();

        const resultAliceThree = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceThree, 1: isPositiveThree, 2: positionUnitsAmountThree} = resultAliceThree;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceThree, isPositiveThree, positionUnitsAmountThree, 5000, 1, {from: admin})).to.be.true;
    });

    it('Calculate time until liquidation, higher for more leveraged positions', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(50000, bob);

        await this.wethPlatform.setMaxAllowedLeverage(5 ,{from: admin});
        let txAlice = await openPosition(1000, 5000, alice, 10000, 1);
        let txBob = await openPosition(250, 5000, bob, 10000, 4);
        let txCarol = await openPosition(500, 5000, carol, 10000, 2);

        const {daysBeforeLiquidation: daysBeforeLiquidationAlice} = await calculateDaysBeforeLiquidation(alice);
        const {daysBeforeLiquidation: daysBeforeLiquidationBob} = await calculateDaysBeforeLiquidation(bob);
        const {daysBeforeLiquidation: daysBeforeLiquidationCarol} = await calculateDaysBeforeLiquidation(carol);

        expect(daysBeforeLiquidationBob).to.be.bignumber.lte(daysBeforeLiquidationAlice);
        expect(daysBeforeLiquidationCarol).to.be.bignumber.lte(daysBeforeLiquidationAlice);
        expect(daysBeforeLiquidationBob).to.be.bignumber.lte(daysBeforeLiquidationCarol);
    });

    it('Sanity checks with liquidateAndValidate', async() => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(10000, bob);

        let {positionUnits: positionUnitsAlice} = await openPositionAndValidate(1000, alice);

        const { daysBeforeLiquidation } = await calculateDaysBeforeLiquidation(alice, new BN(5000));
        await time.increase(SECONDS_PER_DAY.mul(daysBeforeLiquidation));
        await updateSnapshots();

        let { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsAmount, 3: leverageOne, 4: fundingFeesOne, 5: marginDebtOne} = await calculateContractPositionBalance(alice);
        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsAmount, 5000, 1, {from: admin})).to.be.true;
        let finderFeeAmountResult = await liquidateAndValidate(alice);
        expect(finderFeeAmountResult).to.be.bignumber.gt(toBN(0));
    });

    it('Check for totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount with non leveraged position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(50000, bob);
        await this.wethPlatform.setMaxAllowedLeverage(5 ,{from: admin});

        let [totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount] = await getTotals();

        let tokenAmount1 = 1000;
        let factor1 = 1;
        let txAlice = await openPosition(tokenAmount1, 5000, alice, 10000, factor1);
        let [totalPositionUnitsAmount2, totalFundingFeesAmount2, totalLeveragedTokensAmount2] = await getTotals();

        let { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsAmount, 3: leverageOne, 4: fundingFeesOne, 5: marginDebtOne} = await calculateContractPositionBalance(alice);

        expect(new BN(factor1)).to.be.bignumber.equal(leverageOne);
        expect(currentPositionBalanceOne).to.be.bignumber.equal(new BN(tokenAmount1 * (1 - factor1 * OPEN_FEE_PERC / MAX_FEE)));
        expect(totalPositionUnitsAmount2).to.be.bignumber.equal(totalPositionUnitsAmount + positionUnitsAmount);
        expect(totalFundingFeesAmount2).to.be.bignumber.equal(totalFundingFeesAmount + fundingFeesOne);
        expect(new BN(totalLeveragedTokensAmount2 - totalLeveragedTokensAmount)).to.be.bignumber.equal(new BN(tokenAmount1 * factor1 * (1 - OPEN_FEE_PERC / MAX_FEE)));


        let numDays = 4;
        await time.increase(86400 * numDays );
        await this.fakePriceProvider.setPrice(cviValue);
        let tokenAmount2 = 1000;
        const txDeposit = await deposit(tokenAmount2, 0, bob);

        let [totalPositionUnitsAmount3, totalFundingFeesAmount3, totalLeveragedTokensAmount3] = await getTotals();
        let { 0: currentPositionBalance2, 1: isPositive2, 2: positionUnitsAmount2, 3: leverage2, 4: fundingFees2, 5: marginDebt2} = await calculateContractPositionBalance(alice);

        expect(new BN(totalFundingFeesAmount3 - totalFundingFeesAmount2)).to.be.bignumber.equal(new BN(totalFundingFeesAmount + fundingFees2));
        let fundingFeesAdition = new BN(totalPositionUnitsAmount3 * numDays * (50 / 200) / 10  );
        // console.log('fundingFeesAdition = ', fundingFeesAdition.toString());
        expect(new BN(totalFundingFeesAmount3 - totalFundingFeesAmount2)).to.be.bignumber.equal(fundingFeesAdition);
    });

    it('Check for totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount a leveraged position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(50000, bob);
        await this.wethPlatform.setMaxAllowedLeverage(5 ,{from: admin});

        let [totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount] = await getTotals();

        let tokenAmount1 = 500;
        let factor1 = 2;
        let txAlice = await openPosition(tokenAmount1, 5000, alice, 10000, factor1);
        let [totalPositionUnitsAmount2, totalFundingFeesAmount2, totalLeveragedTokensAmount2] = await getTotals();

        let { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsAmount, 3: leverageOne, 4: fundingFeesOne, 5: marginDebtOne} = await calculateContractPositionBalance(alice);

        expect(new BN(factor1)).to.be.bignumber.equal(leverageOne);
        expect(currentPositionBalanceOne).to.be.bignumber.equal(new BN(tokenAmount1 * (1 - factor1 * OPEN_FEE_PERC / MAX_FEE)));
        expect(totalPositionUnitsAmount2).to.be.bignumber.equal(totalPositionUnitsAmount + positionUnitsAmount);
        expect(totalFundingFeesAmount2).to.be.bignumber.equal(totalFundingFeesAmount + fundingFeesOne);
        expect(new BN(totalLeveragedTokensAmount2.sub(totalLeveragedTokensAmount))).to.be.bignumber.equal(new BN(tokenAmount1 * (1 - factor1 * OPEN_FEE_PERC / MAX_FEE) * factor1));

        let numDays = 4;
        await time.increase(86400 * numDays );
        await this.fakePriceProvider.setPrice(cviValue);
        let tokenAmount2 = 1000;
        const txDeposit = await deposit(tokenAmount2, 0, bob);

        let [totalPositionUnitsAmount3, totalFundingFeesAmount3, totalLeveragedTokensAmount3] = await getTotals();
        let { 0: currentPositionBalance2, 1: isPositive2, 2: positionUnitsAmount2, 3: leverage2, 4: fundingFees2, 5: marginDebt2} = await calculateContractPositionBalance(alice);

        expect(new BN(totalFundingFeesAmount3 - totalFundingFeesAmount2)).to.be.bignumber.equal(new BN(totalFundingFeesAmount + fundingFees2));
        let fundingFeesAdition = new BN(totalPositionUnitsAmount3 * numDays * (50 / 200) / 10  );
        expect(new BN(totalFundingFeesAmount3 - totalFundingFeesAmount2)).to.be.bignumber.equal(fundingFeesAdition);
    });

    it('Check for totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount a merged non leveraged position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(500000, bob);
        await this.wethPlatform.setMaxAllowedLeverage(5 ,{from: admin});

        let [totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount] = await getTotals();

        let tokenAmount1a = 1000;
        let factor1a = 1;
        let tokenAmount1b = 1000;
        let factor1b = 1;
        let tokenAmount1c = 2000;
        let factor1c = 1;
        let tokenAmount1aa = (new BN(tokenAmount1a)) - (new BN(factor1a * tokenAmount1a)) * (new BN( OPEN_FEE_PERC)) / (new BN(MAX_FEE));
        let tokenAmount2bb = (new BN(tokenAmount1b)) - (new BN(factor1b * tokenAmount1b)) * (new BN( OPEN_FEE_PERC)) / (new BN(MAX_FEE));
        let tokenAmount3cc = (new BN(tokenAmount1c)) - (new BN(factor1c * tokenAmount1c)) * (new BN( OPEN_FEE_PERC)) / (new BN(MAX_FEE));
        // console.log('token Amounts = ', tokenAmount1aa.toString(), ' ',tokenAmount2bb.toString(), ' ', tokenAmount3cc.toString(), ' ');

        let tokenAmountCombined = new BN(tokenAmount1aa + tokenAmount2bb + tokenAmount3cc);

        let combinedLeveraged = new BN(new BN(tokenAmountCombined) * (new BN(factor1c)));

        // console.log('combinedLeveraged = ', combinedLeveraged.toString());
        // console.log('tokenAmountCombined = ', tokenAmountCombined.toString());
        let preOpenTime = await time.latest();

        await openPosition(tokenAmount1a, 5000, alice, 10000, factor1a);
        await openPosition(tokenAmount1b, 5000, alice, 10000, factor1b);
        let txAlice = await openPosition(tokenAmount1c, 5000, alice, 10000, factor1c);
        let postOpenTime = await time.latest();

        let [totalPositionUnitsAmount2, totalFundingFeesAmount2, totalLeveragedTokensAmount2] = await getTotals();
        let postTotalsTime = await time.latest();
        // console.log('Times:', preOpenTime.toString(), postOpenTime.toString(), postTotalsTime.toString());
        let { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsAmount, 3: leverageOne, 4: fundingFeesOne, 5: marginDebtOne} = await calculateContractPositionBalance(alice);

        expect(new BN(factor1c)).to.be.bignumber.equal(leverageOne);
        expect(new BN(totalLeveragedTokensAmount2 - totalLeveragedTokensAmount)).to.be.bignumber.equal(combinedLeveraged);

        expect(currentPositionBalanceOne).to.be.bignumber.equal(new BN(tokenAmountCombined));
        expect(totalPositionUnitsAmount2).to.be.bignumber.equal(totalPositionUnitsAmount + positionUnitsAmount);
        expect(totalFundingFeesAmount2).to.be.bignumber.equal(totalFundingFeesAmount + fundingFeesOne);

        // let numDays = 4;
        // await time.increase(86400 * numDays );
        // await this.fakePriceProvider.setPrice(cviValue);
        // let tokenAmount6 = 1000;
        // const txDeposit = await deposit(tokenAmount6, 0, bob);

        // let [totalPositionUnitsAmount3, totalFundingFeesAmount3, totalLeveragedTokensAmount3] = await getTotals();
        // let { 0: currentPositionBalance2, 1: isPositive2, 2: positionUnitsAmount2, 3: leverage2, 4: fundingFees2, 5: marginDebt2} = await calculateContractPositionBalance(alice);

        // expect(new BN(totalFundingFeesAmount3 - totalFundingFeesAmount2)).to.be.bignumber.equal(new BN(totalFundingFeesAmount + fundingFees2));
        // let fundingFeesAdition = new BN(totalPositionUnitsAmount3 * numDays * (50 / 200) / 10  );
        // // console.log('fundingFeesAdition = ', fundingFeesAdition.toString());
        // expect(new BN(totalFundingFeesAmount3 - totalFundingFeesAmount2)).to.be.bignumber.equal(fundingFeesAdition);
    });

    it('Check for totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount a merged leveraged position', async () => {
        console.log((await this.wethPlatform.totalLeveragedTokensAmount()).toString());
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(500000, bob);
        console.log((await this.wethPlatform.totalLeveragedTokensAmount()).toString());
        await this.wethPlatform.setMaxAllowedLeverage(5 ,{from: admin});

        let [totalPositionUnitsAmount, totalFundingFeesAmount, totalLeveragedTokensAmount] = await getTotals();

        let tokenAmount1a = 1000;
        let factor1a = 2;
        let tokenAmount1b = 1000;
        let factor1b = 2;
        let tokenAmount1c = 1000;
        let factor1c = 1;
        let tokenAmount1aa = (new BN(tokenAmount1a)) - (new BN(factor1a * tokenAmount1a)) * (new BN( OPEN_FEE_PERC)) / (new BN(MAX_FEE));
        let tokenAmount2bb = (new BN(tokenAmount1b)) - (new BN(factor1b * tokenAmount1b)) * (new BN( OPEN_FEE_PERC)) / (new BN(MAX_FEE));
        let tokenAmount3cc = (new BN(tokenAmount1c)) - (new BN(factor1c * tokenAmount1c)) * (new BN( OPEN_FEE_PERC)) / (new BN(MAX_FEE));
        // console.log('token Amounts = ', tokenAmount1aa.toString(), ' ',tokenAmount2bb.toString(), ' ', tokenAmount3cc.toString(), ' ');

        let tokenAmountCombined = new BN(tokenAmount1aa + tokenAmount2bb + tokenAmount3cc);

        let combinedLeveraged = new BN(new BN(tokenAmountCombined) * (new BN(factor1c)));

        // console.log('combinedLeveraged = ', combinedLeveraged.toString());
        // console.log('tokenAmountCombined = ', tokenAmountCombined.toString());
        let preOpenTime = await time.latest();

        console.log((await this.wethPlatform.totalLeveragedTokensAmount()).toString());
        await openPosition(tokenAmount1a, 5000, alice, 10000, factor1a);
        console.log((await this.wethPlatform.totalLeveragedTokensAmount()).toString());
        await openPosition(tokenAmount1b, 5000, alice, 10000, factor1b);
        console.log((await this.wethPlatform.totalLeveragedTokensAmount()).toString());
        let txAlice = await openPosition(tokenAmount1c, 5000, alice, 10000, factor1c);
        console.log((await this.wethPlatform.totalLeveragedTokensAmount()).toString());
        let postOpenTime = await time.latest();

        let [totalPositionUnitsAmount2, totalFundingFeesAmount2, totalLeveragedTokensAmount2] = await getTotals();
        let postTotalsTime = await time.latest();
        // console.log('Times:', preOpenTime.toString(), postOpenTime.toString(), postTotalsTime.toString());
        let { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsAmount, 3: leverageOne, 4: fundingFeesOne, 5: marginDebtOne} = await calculateContractPositionBalance(alice);

        expect(new BN(factor1c)).to.be.bignumber.equal(leverageOne);

        expect(currentPositionBalanceOne).to.be.bignumber.equal(new BN(tokenAmountCombined));
        expect(totalPositionUnitsAmount2).to.be.bignumber.equal(totalPositionUnitsAmount + positionUnitsAmount);
        expect(totalFundingFeesAmount2).to.be.bignumber.equal(totalFundingFeesAmount + fundingFeesOne);

        expect(new BN(totalLeveragedTokensAmount2 - totalLeveragedTokensAmount)).to.be.bignumber.equal(combinedLeveraged);

    it('opens a position until liquidation one at a time', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await depositAndValidate(50000, bob);
        await expectRevert(openPosition(50000, 5000, alice), 'Not enough liquidity');


        let txAlice = await openPosition(1000, 5000, alice);
        let txAdmin = await openPosition(10, 5000, bob);

        // let bobBalanceOne = (await this.token.balanceOf(bob)).toString();
        const resultBobOne = await calculateContractPositionBalance(bob);

        const { 0: currentPositionBalanceBobOne, 1: isPositiveBobOne, 2: positionUnitsAmountBobOne} = resultBobOne;

        const bobBalanceOne = await calculatePositionBalance(positionUnitsAmountBobOne);
        // console.log('bobBalanceOne = ', bobBalanceOne.toString());

        await time.increase(86400);
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        await updateSnapshots();

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, 5000, 1, {from: admin})).to.be.false;

        const {daysBeforeLiquidation} = await calculateDaysBeforeLiquidation(alice);

        await time.increase(SECONDS_PER_DAY.mul(daysBeforeLiquidation));
        await updateSnapshots();

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { currentPositionBalance: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, 5000, 1, {from: admin})).to.be.true;
        let tx2 = await this.wethPlatform.getLiquidableAddresses([alice, bob], {from: admin});
        // console.log('tx2 = ', tx2.toString());

        let tx3 = await this.wethPlatform.liquidatePositions([alice], {from: admin});

        expect(tx3.logs[0].event).to.be.equal('LiquidatePosition');

        const resultBobTwo = await calculateContractPositionBalance(bob);
        const { 0: currentPositionBalanceBobTwo, 1: isPositiveBobTwo, 2: positionUnitsAmountBobTwo} = resultBobTwo;

        const bobBalanceTwo = await calculatePositionBalance(positionUnitsAmountBobTwo);
        // console.log('bobBalanceTwo = ', bobBalanceTwo.toString());

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');

        let tx3b = await this.wethPlatform.liquidatePositions([bob],{from: bob});
        await expectRevert(this.wethPlatform.calculatePositionBalance(bob, {from: alice}), 'No position for given address');
    });

    it('opens multiple positions, positions multiple liquidations together', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        await depositAndValidate(50000, bob);

        // await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');
        await expectRevert(openPosition(50000, 5000, alice), 'Not enough liquidity');

        // let txAlice = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let txAlice = await openPosition(1000, 5000, alice);
        // let txAdmin = await this.wethPlatform.openPosition(toTokenAmount(10), 5000, {from: bob});
        let txAdmin = await openPosition(10, 5000, bob);

        // let bobBalanceOne = (await this.token.balanceOf(bob)).toString();
        const resultBobOne = await this.wethPlatform.calculatePositionBalance(bob);
        const { 0: currentPositionBalanceBobOne, 1: isPositiveBobOne, 2: positionUnitsAmountBobOne} = resultBobOne;
        const bobBalanceOne = await calculatePositionBalance(positionUnitsAmountBobOne);
        // console.log('bobBalanceOne = ', bobBalanceOne.toString());

        await time.increase(86400);
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        await updateSnapshots();

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, 5000, 1, {from: admin})).to.be.false;

        const {daysBeforeLiquidation} = await calculateDaysBeforeLiquidation(alice);

        await time.increase(SECONDS_PER_DAY.mul(daysBeforeLiquidation));
        await updateSnapshots();

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, 5000, 1, {from: admin})).to.be.true;
        let tx2 = await this.wethPlatform.getLiquidableAddresses([alice, bob], {from: admin});
        // console.log('tx2 = ', tx2.toString());

        // let tx3 = await this.wethPlatform.liquidatePositions(tx2, {from: admin});
        let tx3 = await this.wethPlatform.liquidatePositions(tx2, {from: admin});

        expect(tx3.logs[0].event).to.be.equal('LiquidatePosition');

        // let bobBalanceTwo = (await this.token.balanceOf(bob)).toString();
        // const resultBobTwo = await this.wethPlatform.calculatePositionBalance(bob);
        await expectRevert(this.wethPlatform.calculatePositionBalance(bob, {from: alice}), 'No position for given address');
        // const { 0: currentPositionBalanceBobTwo, 1: isPositiveBobTwo, 2: positionUnitsAmountBobTwo} = resultBobTwo;
        // const bobBalanceTwo = await calculatePositionBalance(positionUnitsAmountBobTwo);
        // console.log('bobBalanceTwo = ', bobBalanceTwo.toString());

        // expect(bobBalanceTwo).to.be.bignumber.equal(currentPositionBalanceTwo.add(new BN(bobBalanceOne)));

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');

        // let tx3b = await this.wethPlatform.liquidatePositions([bob],{from: bob});
        await expectRevert(this.wethPlatform.liquidatePositions([bob], {from: bob}), 'No liquidatable position');
        await expectRevert(this.wethPlatform.calculatePositionBalance(bob, {from: alice}), 'No position for given address');
    });

    it('liquidates on close', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(50000, bob);
        await openPositionAndValidate(1000, alice);

        await time.increase(86400);

        //await this.fakePriceProvider.setPrice(toCVI(5000));

        const {daysBeforeLiquidation} = await calculateDaysBeforeLiquidation(alice);
        await liquidateAndValidate(alice);

        await time.increase(86400 * daysBeforeLiquidation);

        await this.wethPlatform.getLiquidableAddresses([alice, bob], {from: admin});
        await this.wethPlatform.closePosition(250, 5000, {from: alice});

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');
    });
};

describe.skip('ETHPlatformLiquidation', () => {
    beforeEach(async () => {
        await beforeEachPlatform(true);
    });

    setPlatformTests(true);
});

