const {expectRevert, time, BN, balance} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence} = require('./utils/FeesUtils.js');
const { print } = require('./utils/DebugUtils');

const Platform = contract.fromArtifact('PlatformV2');
const ETHPlatform = contract.fromArtifact('ETHPlatform');
const CVIOracle = contract.fromArtifact('CVIOracleV3');
const Rewards = contract.fromArtifact('Rewards');
const FeesCalculator = contract.fromArtifact('FeesCalculatorV3');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const fakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const Liquidation = contract.fromArtifact('Liquidation');

const StakingRewards = contract.fromArtifact('USDTLPStakingRewards');

const expect = chai.expect;
const [admin, bob, alice, carol, dave] = accounts;
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

let INITIAL_RATE = toBN(1, 12);
const ETH_INITIAL_RATE = toBN(1, 3);
const SECOND_INITIAL_RATE = toBN(1, 18);
const SECOND_ETH_INITIAL_RATE = toBN(1, 10);
const PRECISION_DECIMALS = toBN(1, 10);

const GAS_PRICE = toBN(1, 10);

const HEARTBEAT = new BN(55 * 60);

const getBNFee = (bigNumber, fee) => {
    return bigNumber.mul(fee).div(MAX_FEE);
};

const getBNMinusFee = (bigNumber, fee) => {
    return bigNumber.mul(MAX_FEE.sub(fee)).div(MAX_FEE);
};

const getFee = (amount, fee) => {
    return getBNFee(toBN(amount), fee);
};

const verifyPositionEvent = (event, eventName, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    expect(event.event).to.equal(eventName);
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.account).to.equal(sender);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(feesAmount);
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
    expect(event.args.cviValue).to.be.bignumber.equal(new BN(cviValue));
};

const verifyOpenPositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    verifyPositionEvent(event, 'OpenPosition', sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount);
};

const verifyClosePositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount) => {
    verifyPositionEvent(event, 'ClosePosition', sender, tokenAmount, positionUnitsAmount, cviValue, feesAmount);
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
        turbulence: new BN(0),
        lpBalances
    };
};

const calculateBalance = async () => {
    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;
    return this.state.sharedPool.sub(this.state.totalPositionUnits.mul(cviValue).div(MAX_CVI_VALUE)).add(this.state.totalFundingFees);
};

const validateLPState = async () => {
    const feesBalance = this.isETH ? await balance.current(this.fakeFeesCollector.address, 'wei') :
        await this.fakeFeesCollector.getProfit();
    expect(feesBalance).to.be.bignumber.equal(this.state.totalFeesSent);
    expect(await this.wethPlatform.totalSupply()).to.be.bignumber.equal(this.state.lpTokensSupply);

    const contractBalance = this.isETH ? await balance.current(this.wethPlatform.address, 'wei') :
        await this.token.balanceOf(this.wethPlatform.address);

    expect(contractBalance).to.be.bignumber.equal(this.state.sharedPool);

    const totalLeveragedTokens = await this.wethPlatform.totalLeveragedTokensAmount();
    expect(totalLeveragedTokens).to.be.bignumber.equal(this.state.sharedPool);

    expect(await this.wethPlatform.totalPositionUnitsAmount()).to.be.bignumber.equal(this.state.totalPositionUnits);
    expect(await this.wethPlatform.totalFundingFeesAmount()).to.be.bignumber.equal(this.state.totalFundingFees);

    for (let account of Object.keys(this.state.lpBalances)) {
        expect(await this.wethPlatform.balanceOf(account)).to.be.bignumber.equal(this.state.lpBalances[account]);
    }

    expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(this.state.turbulence);

    const totalBalance = await calculateBalance();
    expect(await this.wethPlatform.totalBalance()).to.be.bignumber.equal(totalBalance);
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

    return latestTimestamp;
};

const calculateFundingFees = (currTime, account, positionUnitsAmount) => {
    const position = this.state.positions[account];
    return (this.state.snapshots[currTime.toNumber()].sub(this.state.snapshots[position.creationTimestamp.toNumber()]).mul(positionUnitsAmount).div(PRECISION_DECIMALS));
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

const calculateWithdrawAmounts = async amount => {
    const withdrawFees = await this.feesCalculator.withdrawFeePercent();

    const withdrawTokens = new BN(amount);
    const withdrawTokenFees = getFee(amount, withdrawFees);
    const withdrawTokenMinusFees = withdrawTokens.sub(withdrawTokenFees);

    const burnedLPTokens = withdrawTokens.mul(this.state.lpTokensSupply).sub(new BN(1)).div(await calculateBalance()).add(new BN(1));

    return { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens };
};

const calculateTokensByBurntLPTokensAmount = async burnAmount => {
    return burnAmount.mul(await calculateBalance()).div(this.state.lpTokensSupply);
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

const deposit = (tokens, minLPTokens, account) => {
    if (this.isETH) {
        return this.wethPlatform.depositETH(minLPTokens, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.deposit(tokens, minLPTokens, {from: account});
    }
};

const withdraw = (tokens, maxLPTokensBurn, account) => {
    if (this.isETH) {
        return this.wethPlatform.withdraw(tokens, maxLPTokensBurn, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.withdraw(tokens, maxLPTokensBurn, {from: account});
    }
};

const withdrawLPTokens = (lpTokens, account) => {
    if (this.isETH) {
        return this.wethPlatform.withdrawLPTokens(lpTokens, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.withdrawLPTokens(lpTokens, {from: account});
    }
};

const callWithdraw = (tokens, maxLPTokensBurn, account) => {
    if (this.isETH) {
        return this.wethPlatform.withdraw.call(tokens, maxLPTokensBurn, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.withdraw.call(tokens, maxLPTokensBurn, {from: account});
    }
};

const openPosition = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
    if (this.isETH) {
        return this.wethPlatform.openPositionETH(cviValue, maxBuyingPremiumPercent, leverage, {value: tokens, from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.openPosition(tokens, cviValue, maxBuyingPremiumPercent, leverage, {from: account});
    }
};

const closePosition = (positionUnits, cviValue, account) => {
    if (this.isETH) {
        return this.wethPlatform.closePosition(positionUnits, cviValue, {from: account, gasPrice: GAS_PRICE});
    } else {
        return this.wethPlatform.closePosition(positionUnits, cviValue, {from: account});
    }
};

const depositAndValidate = async (depositTokensNumber, account) => {
    const { depositTokens, depositTokenFees, depositTokenMinusFees } = await calculateDepositAmounts(depositTokensNumber);

    let beforeBalance;
    if (!this.isETH) {
        await this.token.transfer(account, depositTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, depositTokens, {from: account});
        beforeBalance = await this.token.balanceOf(account);
    } else {
        beforeBalance = await balance.current(account, 'wei');
    }

    const tx = await deposit(depositTokens, new BN(0), account);

    print('DEPOSIT: ' + tx.receipt.gasUsed.toString());

    const depositTimestamp = await updateSnapshots();
    const { lpTokens } = await calculateDepositAmounts(depositTokensNumber);
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

const withdrawAndValidate = async (withdrawTokensNumber, account, lpTokens) => {
    let { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens } = await calculateWithdrawAmounts(withdrawTokensNumber);

    if (lpTokens !== undefined) {
        burnedLPTokens = lpTokens;
        withdrawTokens = await calculateTokensByBurntLPTokensAmount(burnedLPTokens);
        const results = await calculateWithdrawAmounts(withdrawTokens);

        withdrawTokenFees = results.withdrawTokenFees;
        withdrawTokenMinusFees = results.withdrawTokenMinusFees;
    }

    const beforeBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    const result = await callWithdraw(withdrawTokens, burnedLPTokens, account);

    const tx = lpTokens === undefined ? await withdraw(withdrawTokens, burnedLPTokens, account) :
        await withdrawLPTokens(burnedLPTokens, account);
    const timestamp = await updateSnapshots();

    if (lpTokens === undefined) {
        const results = await calculateWithdrawAmounts(withdrawTokens);

        burnedLPTokens = results.burnedLPTokens;
        withdrawTokenMinusFees = results.withdrawTokenMinusFees;
        withdrawTokenFees = results.withdrawTokenFees;
    }

    expect(result[0]).to.be.bignumber.equal(burnedLPTokens);
    expect(result[1]).to.be.bignumber.equal(withdrawTokenMinusFees);

    await verifyWithdrawEvent(tx.logs[0], account, withdrawTokens);

    print('WITHDRAW: ' + tx.receipt.gasUsed.toString());

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

    return timestamp;
};

const validatePosition = (actualPosition, expectedPosition) => {
    expect(actualPosition.positionUnitsAmount).to.be.bignumber.equal(expectedPosition.positionUnitsAmount);
    expect(actualPosition.leverage).to.be.bignumber.equal(expectedPosition.leverage);
    expect(actualPosition.openCVIValue).to.be.bignumber.equal(expectedPosition.openCVIValue);
    expect(actualPosition.creationTimestamp).to.be.bignumber.equal(expectedPosition.creationTimestamp);
    expect(actualPosition.originalCreationTimestamp).to.be.bignumber.equal(expectedPosition.originalCreationTimestamp);
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
    const tx = await openPosition(openPositionTokens, cviValue, account);

    print('OPEN: ' + tx.receipt.gasUsed.toString());

    const timestamp = await updateSnapshots();

    let finalPositionUnits = positionUnits;
    if (isMerge) {
        const fundingFees = calculateFundingFees(timestamp, account, this.state.positions[account].positionUnitsAmount);
        const positionBalance = this.state.positions[account].positionUnitsAmount.mul(cviValue).div(MAX_CVI_VALUE).sub(fundingFees).add(openPositionTokensMinusFees);
        finalPositionUnits = positionBalance.mul(MAX_CVI_VALUE).div(cviValue);

        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
        this.state.totalPositionUnits = this.state.totalPositionUnits.sub(this.state.positions[account].positionUnitsAmount);
    }

    verifyOpenPositionEvent(tx.logs[0], account, openPositionTokens, finalPositionUnits, cviValue, openPositionTokensFees);

    const expectedPosition = { positionUnitsAmount: finalPositionUnits, creationTimestamp: timestamp, openCVIValue: cviValue, leverage: new BN(1), originalCreationTimestamp: isMerge ? this.state.positions[account].originalCreationTimestamp : timestamp };
    const actualPosition = await this.wethPlatform.positions(account);
    validatePosition(actualPosition, expectedPosition);

    this.state.totalPositionUnits = this.state.totalPositionUnits.add(finalPositionUnits);
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

    return {positionUnits: finalPositionUnits, timestamp};
};

const validateEmptyPosition = position => {
    expect(position.positionUnitsAmount).to.be.bignumber.equal(new BN(0));
    expect(position.creationTimestamp).to.be.bignumber.equal(new BN(0));
};

const closePositionAndValidate = async (positionUnits, account) => {
    const positionBalance = await calculatePositionBalance(positionUnits);

    const beforeBalance = this.isETH ? await balance.current(account, 'wei') : await this.token.balanceOf(account);

    const cviValue = (await this.fakeOracle.getCVILatestRoundData()).cviValue;
    const tx = await closePosition(positionUnits, cviValue, account);
    const timestamp = await updateSnapshots();

    print('CLOSE: ' + tx.receipt.gasUsed.toString());

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

    this.state.totalPositionUnits = this.state.totalPositionUnits.sub(positionUnits);
    if (this.state.totalFundingFees.sub(fundingFees).lt(new BN(0))) {
        this.state.totalFundingFees = new BN(0);
    } else {
        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees);
    }

    this.state.totalFeesSent = this.state.totalFeesSent.add(closePositionTokensFees);
    this.state.sharedPool = this.state.sharedPool.sub(positionBalance).add(fundingFees);

    await validateLPState();

    if (this.isETH) {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees).sub((new BN(tx.receipt.gasUsed)).mul(GAS_PRICE)));
    } else {
        expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(positionBalance.sub(totalFees));
    }

    return timestamp;
};

const leftTokensToWithdraw = async account => {
    const totalSupply = await this.wethPlatform.totalSupply();

    const totalBalance = this.isETH ? await balance.current(this.wethPlatform.address, 'wei') :
        await this.token.balanceOf(this.wethPlatform.address);

    const leftTokens = (await this.wethPlatform.balanceOf(account)).mul(totalBalance).div(totalSupply);

    return leftTokens;
};

const testMultipleAccountsDepositWithdraw = async (depositFee, withdrawFee, testEndBalance = true) => {
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

    if (testEndBalance) {
        expect(await this.wethPlatform.balanceOf(carol)).is.bignumber.equal(new BN(0));
        expect(await this.wethPlatform.balanceOf(alice)).is.bignumber.equal(new BN(0));
    }
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

const deployPlatform = async isETH => {
    if (isETH) {
        this.wethPlatform = await ETHPlatform.new(
            'ETH-LP', 'ETH-LP', INITIAL_RATE,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});
    } else {
        this.wethPlatform = await Platform.new(
            this.tokenAddress, 'WETH-LP', 'WETH-LP', INITIAL_RATE,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});
    }
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
    this.fakeFeesCollector = await FakeFeesCollector.new(this.tokenAddress, {from: admin});
    this.rewards = await Rewards.new(this.cviToken.address, {from: admin});
    this.liquidation = await Liquidation.new({from: admin});

    if (isETH) {
        INITIAL_RATE = ETH_INITIAL_RATE;
    }

    await deployPlatform(isETH);

    this.state = createState();

    await this.rewards.setRewarder(this.wethPlatform.address, {from: admin});
    await this.feesCalculator.setTurbulenceUpdator(this.wethPlatform.address, {from: admin});

    await this.wethPlatform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});

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

    if (isETH) {
        it('reverts when calling deposit and openPosition instead of depositETH and openPositionETH', async() => {
            await expectRevert(this.wethPlatform.deposit(toBN(1000, 18), new BN(0)), 'Use depositETH');
            await expectRevert(this.wethPlatform.openPosition(toBN(1000, 18), MAX_CVI_VALUE, MAX_FEE, new BN(1)), 'Use openPositionETH');
        });
    }

    it('deposits liquidity correctly', async () => {
        await depositAndValidate(5000, bob);
        await depositAndValidate(1000, bob);
        await depositAndValidate(2000, alice);
    });

    it('withdraws all lp tokens correctly', async () => {
        await depositAndValidate(1000, bob);
        await time.increase(3 * SECONDS_PER_DAY);

        const bobLPTokensBalance = await this.wethPlatform.balanceOf(bob);
        await withdrawAndValidate(0, bob, bobLPTokensBalance);

        expect(await this.wethPlatform.balanceOf(bob)).to.be.bignumber.equal(new BN(0));
    });

    it('reverts when withdrawing locked funds', async () => {
        const depositTimestamp = await depositAndValidate(5000, bob);

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

    it('handles multiple accounts deposit and withdraw correctly with a different initial rate', async () => {
        if (isETH) {
            INITIAL_RATE = SECOND_ETH_INITIAL_RATE;
        } else {
            INITIAL_RATE = SECOND_INITIAL_RATE;
        }

        await deployPlatform(this.isETH);
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
        const timestamp = await depositAndValidate(1000, bob);
        const lpTokensNum = await this.wethPlatform.balanceOf(bob);

        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), bob), 'Funds are locked');

        await time.increaseTo(timestamp.add(new BN(SECONDS_PER_DAY)));
        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), bob), 'Funds are locked');

        await this.wethPlatform.transfer(alice, lpTokensNum, {from: bob});

        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), alice), 'Funds are locked');

        await time.increaseTo(timestamp.add(new BN(3 * SECONDS_PER_DAY - 2)));
        await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), alice), 'Funds are locked');

        await time.increaseTo(timestamp.add(new BN(3 * SECONDS_PER_DAY)));
        await withdraw(new BN(1), toTokenAmount(1000000), alice);
    });

    it('lock time is not passed when staking/unstaking to staking contract address specified', async () => {
        if (!this.isETH) {
            await this.token.transfer(bob, 2000, {from: admin});
            await this.token.approve(this.wethPlatform.address, 2000, {from: bob});

            await this.token.transfer(alice, 1000, {from: admin});
            await this.token.approve(this.wethPlatform.address, 1000, {from: alice});
        }

        const staking = await StakingRewards.new(admin, admin, this.cviToken.address, this.wethPlatform.address);

        await deposit(1000, 0, bob);
        const timestamp = await time.latest();
        const lpTokensNum = await this.wethPlatform.balanceOf(bob);

        expect(await this.wethPlatform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp);

        await time.increase(60);

        await this.wethPlatform.approve(staking.address, lpTokensNum, {from: bob});
        await staking.stake(lpTokensNum, {from: bob});
        expect(await this.wethPlatform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp);

        await time.increase(60);

        await deposit(1000, 0, alice);
        const timestamp2 = await time.latest();
        const lpTokensNum2 = await this.wethPlatform.balanceOf(alice);
        expect(await this.wethPlatform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp);

        await time.increase(60);

        await this.wethPlatform.approve(staking.address, lpTokensNum2, {from: alice});
        await staking.stake(lpTokensNum2, {from: alice});
        expect(await this.wethPlatform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);

        await time.increase(60);

        await staking.withdraw(lpTokensNum, {from: bob});
        expect(await this.wethPlatform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp2);

        await this.wethPlatform.setStakingContractAddress(staking.address, {from: admin});
        await time.increase(60);

        await deposit(1000, 0, bob);
        const timestamp3 = await time.latest();
        const lpTokensNum3 = await this.wethPlatform.balanceOf(bob);
        expect(await this.wethPlatform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3);

        await time.increase(60);

        this.wethPlatform.approve(staking.address, lpTokensNum3, {from: bob});
        await staking.stake(lpTokensNum3, {from: bob});
        expect(await this.wethPlatform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);
        expect(await this.wethPlatform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3);

        await time.increase(60);

        await staking.withdraw(lpTokensNum3, {from: bob});

        expect(await this.wethPlatform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2);
        expect(await this.wethPlatform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3);
    });

    it('prevents transfer of locked tokens if recipient sets so', async () => {
        const timestamp = await depositAndValidate(1000, bob);
        const lpTokensNum = await this.wethPlatform.balanceOf(bob);

        if (!this.isETH) {
            await this.token.transfer(bob, 1000, {from: admin});
            await this.token.approve(this.wethPlatform.address, 1000, {from: bob});

            await this.token.transfer(alice, 1000, {from: admin});
            await this.token.approve(this.wethPlatform.address, 1000, {from: alice});
        }

        await time.increaseTo(timestamp.add(new BN(2 * SECONDS_PER_DAY)));

        expect(await this.wethPlatform.revertLockedTransfered(bob)).to.be.false;
        expect(await this.wethPlatform.revertLockedTransfered(alice)).to.be.false;

        await this.wethPlatform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob});
        await this.wethPlatform.setRevertLockedTransfers(true, {from: bob});
        expect(await this.wethPlatform.revertLockedTransfered(bob)).to.be.true;

        await time.increase(1);
        await deposit(10, 0, bob);

        await this.wethPlatform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob});
        await this.wethPlatform.setRevertLockedTransfers(true, {from: alice});
        expect(await this.wethPlatform.revertLockedTransfered(alice)).to.be.true;

        await time.increase(1);
        await deposit(10, 0, bob);

        await expectRevert(this.wethPlatform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob}), 'Recipient refuses locked tokens');
        await this.wethPlatform.setRevertLockedTransfers(false, {from: alice});

        await time.increase(1);
        await deposit(10, 0, alice);

        await this.wethPlatform.transfer(alice, lpTokensNum.div(new BN(4)), {from: bob});
        await expectRevert(this.wethPlatform.transfer(bob, lpTokensNum.div(new BN(4)), {from: alice}), 'Recipient refuses locked tokens');
    });

    it('allows emergency withdraw if set even when collateral is broken but keeps lock', async () => {
        await depositAndValidate(5000, bob);
        //await this.fakePriceProvider.setPrice(toCVI(5000));

        await openPositionAndValidate(1000, alice);

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdrawAndValidate(3000, bob), 'Collateral ratio broken');
        await this.wethPlatform.setEmergencyWithdrawAllowed(true, {from: admin});
        await withdrawAndValidate(3000, bob);

        await depositAndValidate(5000, bob);

        await expectRevert(withdrawAndValidate(3000, bob), 'Funds are locked');

        await time.increase(3 * 24 * 60 * 60);

        await this.wethPlatform.setEmergencyWithdrawAllowed(false, {from: admin});
        await expectRevert(withdrawAndValidate(5000, bob), 'Collateral ratio broken');

    });

    it('allows complete shutdown of all operations by setters', async () => {
        await this.wethPlatform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await expectRevert(depositAndValidate(5000, bob), 'revert');

        await this.wethPlatform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await depositAndValidate(5000, bob);
        await this.wethPlatform.setFeesCalculator(ZERO_ADDRESS, {from: admin});

        await time.increase(3 * 24 * 60 * 60);

        await expectRevert(withdraw(1000, toBN(1, 40), bob), 'revert');
        await expectRevert(withdrawLPTokens(1000, bob), 'revert');

        await this.fakePriceProvider.setPrice(toCVI(5000));

        await expectRevert(openPositionAndValidate(1000, alice), 'revert');

        await this.wethPlatform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await openPositionAndValidate(1000, alice);

        await time.increase(24 * 60 * 60);

        await this.wethPlatform.setFeesCalculator(ZERO_ADDRESS, {from: admin});
        await expectRevert(closePosition(1000, 5000, alice), 'revert');

        await this.wethPlatform.setLiquidation(ZERO_ADDRESS, {from: admin});
        await expectRevert(this.wethPlatform.liquidatePositions([bob], {from: carol}), 'revert');

        await this.wethPlatform.setFeesCalculator(this.feesCalculator.address, {from: admin});
        await this.wethPlatform.setLiquidation(this.liquidation.address, {from: admin});

        await expectRevert(this.wethPlatform.liquidatePositions([bob], {from: carol}), 'No liquidatable position');
    });

    it('reverts when opening a position with zero tokens', async () => {
        await expectRevert(openPosition(0, 20000, alice), 'Tokens amount must be positive');
    });


    it('reverts when opening a position with a bad max CVI value', async () => {
        await expectRevert(openPosition(5000, 0, alice), 'Bad max CVI value');
        await expectRevert(openPosition(5000, 20001, alice), 'Bad max CVI value');
    });

    it('reverts when opening a position with CVI value higher than max CVI', async () => {
        await depositAndValidate(40000, bob);

        if (!this.isETH) {
            await this.token.transfer(alice, 10000, {from: admin});
            await this.token.approve(this.wethPlatform.address, 10000, {from: alice});
        }

        await this.fakePriceProvider.setPrice(toCVI(5000));
        await expectRevert(openPosition(5000, 4999, alice), 'CVI too high');

        await this.fakePriceProvider.setPrice(toCVI(6000));
        await openPosition(5000, 6000, alice);
        await openPosition(5000, 6001, alice);
        await expectRevert(openPosition(5000, 5999, alice), 'CVI too high');
    });

    it('reverts when opening a position with buying premium percentage higher than max', async () => {
        await depositAndValidate(40000, bob);

        if (!this.isETH) {
            await this.token.transfer(alice, 10000, {from: admin});
            await this.token.approve(this.wethPlatform.address, 10000, {from: alice});
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
        await depositAndValidate(1, bob);

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
            await depositAndValidate(4000, bob);
            await openPositionAndValidate(1000, alice);

            const overflowReason = this.isETH ? 'SafeMath: subtraction overflow': 'Too much position units';
            await expectRevert(openPosition(toBN(374, 48).sub(new BN(1000).div(new BN(4))), 5000, alice), overflowReason);
            await expectRevert(openPosition(toBN(120, 48).sub(new BN(1000).div(new BN(4))), 5000, alice), overflowReason);
        });
    }

    it.skip('reverts if not enough liquidity expected after openning a position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

    });

    it('reaches low enough gas values for deposit/withdraw actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 60);
        print('first deposit ever');
        await depositAndValidate(4000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(24 * 60);

        print('second deposit');
        await depositAndValidate(2000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));

        await time.increase(3 * 24 * 60 * 60);

        print('partial withdraw');
        await withdrawAndValidate(2000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(24 * 60);

        print('full withdraw');
        await withdrawAndValidate(4000, bob);
    });

    it('reaches low enough gas values for open/close actions', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        print('first deposit ever');
        await time.increase(24 * 60 * 60);
        await depositAndValidate(40000, bob);

        await time.increase(24 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        await time.increase(60 * 60);

        print('first open ever');
        const {positionUnits: positionUnits1} = await openPositionAndValidate(5000, alice);

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(60 * 60);

        print('open merge');
        const {positionUnits: positionUnits2} = await openPositionAndValidate(3000, alice);

        let positionUnits = positionUnits2;

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(60 * 60);

        print('partial close');
        await time.increase(3 * 24 * 60 * 60);
        await closePositionAndValidate(positionUnits.div(new BN(2)), alice);
        positionUnits = positionUnits.sub(positionUnits.div(new BN(2)));
        print('entire close');
        await time.increase(24 * 60 * 60);
        await closePositionAndValidate(positionUnits, alice);

        print('partial withdraw');
        await time.increase(3 * 24 * 60 * 60);
        await withdrawAndValidate(10000, bob);
        print('second deposit');
        await time.increase(24 * 60 * 60);
        await depositAndValidate(10000, bob);
        print('full withdraw');
        await time.increase(3 * 24 * 60 * 60);

        const tokensLeft = this.isETH ? await balance.current(this.wethPlatform.address, 'wei') :
            await this.token.balanceOf(this.wethPlatform.address);
        await withdrawAndValidate(tokensLeft, bob);
    });

    it('opens a position properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 24 * 60);
        await depositAndValidate(20000, bob);
        await time.increase(24 * 24 * 60);
        await openPositionAndValidate(5000, alice);
    });

    it('opens a position properly with no rewards', async () => {
        await this.wethPlatform.setRewards(ZERO_ADDRESS, {from: admin});

        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(24 * 24 * 60);
        await depositAndValidate(20000, bob);
        await time.increase(24 * 24 * 60);
        await openPositionAndValidate(5000, alice);
    });

    it('merges a position properly', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await depositAndValidate(60000, bob);
        await openPositionAndValidate(5000, alice);

        // To avoid turbulence
        await time.increase(60 * 60);

        await this.fakePriceProvider.setPrice(toCVI(6000));
        await openPositionAndValidate(1000, alice);

        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));

        await openPositionAndValidate(1000, alice);

    });

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

        await time.increaseTo(timestamp.add(new BN(5 * 60 * 60)));
        await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked');
        await time.increaseTo(timestamp.add(new BN(6 * 60 * 60 - 15)));
        await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked');

        await time.increaseTo(timestamp.add(new BN(6 * 60 * 60)));
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

    it('updates total funding fee back to zero instead of overflowing when rounding, if poision units updates to zero', async () => {
        await depositAndValidate(5000, bob);

        const {positionUnits} = await openPositionAndValidate(1000, alice);
        await time.increase(24 * 60 * 60);

        // Total funding fees grow here
        await depositAndValidate(1000, bob);
        await time.increase(24 * 60 * 60);

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(positionUnits, alice);
    });

    it('updates total funding fee back to zero instead of overflowing when rounding on merge, if poision units updates to zero', async () => {
        await this.fakePriceProvider.setPrice(toCVI(10000));
        await depositAndValidate(5000, bob);

        await openPositionAndValidate(1000, alice);
        await time.increase(2 * 24 * 60 * 60);

        // Total funding fees grow here
        const {positionUnits} = await openPositionAndValidate(5, alice);
        await time.increase(24 * 60 * 60);

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(positionUnits, alice);
    });

    it.skip('updates total funding fee back to zero instead of one when rounding, if position units updates to zero', async () => {
        await depositAndValidate(1000, bob);

        const {positionUnits} = await openPositionAndValidate(201, alice);
        await time.increase(96 * 59 * 59);

        // Total funding fees grow here
        await depositAndValidate(1001, bob);
        await time.increase(96 * 59 * 60);

        // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
        await closePositionAndValidate(positionUnits, alice);
    });

    it('deletes last snapshot only if it was not an open position snapshot', async () => {
        const timestamp1 = await depositAndValidate(2000, bob);
        expect(await this.wethPlatform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(3 * 24 * 60 * 60);

        const timestamp2 = await withdrawAndValidate(1000, bob);
        expect(await this.wethPlatform.cviSnapshots(timestamp1)).to.be.bignumber.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {positionUnits, timestamp: timestamp3} = await openPositionAndValidate(100, alice);
        expect(await this.wethPlatform.cviSnapshots(timestamp2)).to.be.bignumber.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(24 * 60 * 60);

        const timestamp4 = await closePositionAndValidate(positionUnits, alice);
        expect(await this.wethPlatform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const timestamp5 = await depositAndValidate(2000, bob);
        expect(await this.wethPlatform.cviSnapshots(timestamp4)).to.be.bignumber.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp5)).to.be.bignumber.not.equal(new BN(0));
    });

    it('does not delete snapshot if an open occured on its block', async () => {
        const timestamp1 = await depositAndValidate(2000, bob);
        const {timestamp: timestamp2} = await openPositionAndValidate(100, alice);

        if (timestamp1 === timestamp2) {
            expect(await this.wethPlatform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.wethPlatform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(3 * 24 * 60 * 60);

        const {timestamp: timestamp4} = await openPositionAndValidate(100, alice);
        const timestamp3 = await withdrawAndValidate(1000, bob);

        if (timestamp3 === timestamp4) {
            expect(await this.wethPlatform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.wethPlatform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0));

        await time.increase(1);

        const {timestamp: timestamp5} = await openPositionAndValidate(10, alice);
        const timestamp6 = await depositAndValidate(1, bob);

        if (timestamp5 === timestamp6) {
            expect(await this.wethPlatform.cviSnapshots(timestamp6)).to.be.bignumber.not.equal(new BN(0));
        }

        expect(await this.wethPlatform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0));
        expect(await this.wethPlatform.cviSnapshots(timestamp5)).to.be.bignumber.not.equal(new BN(0));
    });

    it('runs multiple actions on same blocks properly', async () => {
        await depositAndValidate(2000, bob);
        await depositAndValidate(1000, alice);
        await depositAndValidate(3000, carol);

        await time.increase(3 * 24 * 60 * 60);

        await withdrawAndValidate(100, bob);
        const {positionUnits} = await openPositionAndValidate(200, alice);
        await depositAndValidate(3000, carol);

        await time.increase(3 * 24 * 60 * 60);

        await closePositionAndValidate(positionUnits, alice);
        await withdrawAndValidate(3000, carol);
        await depositAndValidate(3000, carol);
    });

    it('runs deposit/withdraw actions properly with many positions opened', async () => {
        await depositAndValidate(30000, bob);

        await time.increase(60);

        await openPositionAndValidate(200, bob);
        await time.increase(1);
        await openPositionAndValidate(200, alice);
        await time.increase(1);
        await openPositionAndValidate(200, carol);

        await time.increase(1);

        await testMultipleAccountsDepositWithdraw(new BN(0), new BN(0), false);
    });

    it('reverts when liquidating non-existing position', async () => {
        await expectRevert(this.wethPlatform.liquidatePositions([alice], {from: dave}), 'No liquidatable position');
        await expectRevert(this.wethPlatform.liquidatePositions([bob, carol], {from: dave}), 'No liquidatable position');
        await expectRevert(this.wethPlatform.liquidatePositions([alice, bob, carol, dave], {from: dave}), 'No liquidatable position');
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

