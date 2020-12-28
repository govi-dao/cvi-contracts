const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const {toBN, toTokenAmount} = require('./utils/BNUtils.js');

const Platform = contract.fromArtifact('Platform');
const CVIOracle = contract.fromArtifact('CVIOracle');
const Rewards = contract.fromArtifact('Rewards');
const FeesModel = contract.fromArtifact('FeesModel');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const fakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const Liquidation = contract.fromArtifact('Liquidation');

const expect = chai.expect;
const [admin, bob, alice] = accounts;

const OPEN_FEE_PERC = new BN(30);
const CLOSE_FEE_PERC = new BN(30);
const DEPOSIT_FEE_PERC = new BN(30);
const WITHDRAW_FEE_PERC = new BN(30);
const MAX_FEE = new BN(10000);
const MAX_FUNDING_FEE = new BN(1000000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const verifyOpenPositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue) => {
    expect(event.event).to.equal('OpenPosition');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.account).to.equal(sender);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE));
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
    expect(event.args.cviValue).to.be.bignumber.equal(new BN(cviValue));
};

const verifyClosePositionEvent = (event, sender, tokenAmount, positionUnitsAmount, cviValue) => {
    expect(event.event).to.equal('ClosePosition');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.account).to.equal(sender);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(CLOSE_FEE_PERC).div(MAX_FEE));
    expect(event.args.positionUnitsAmount).to.be.bignumber.equal(positionUnitsAmount);
    expect(event.args.cviValue).to.be.bignumber.equal(new BN(cviValue));
};

const verifyDepositEvent = (event, sender, tokenAmount) => {
    expect(event.event).to.equal('Deposit');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(DEPOSIT_FEE_PERC).div(MAX_FEE));
    expect(event.args.account).to.equal(sender);
};

const verifyWithdrawEvent = (event, sender, tokenAmount) => {
    expect(event.event).to.equal('Withdraw');
    expect(event.address).to.equal(this.wethPlatform.address);
    expect(event.args.tokenAmount).to.be.bignumber.equal(tokenAmount);
    expect(event.args.feeAmount).to.be.bignumber.equal(tokenAmount.mul(WITHDRAW_FEE_PERC).div(MAX_FEE));
    expect(event.args.account).to.equal(sender);
};

const getBNFee = (bigNumber, fee) => {
    return bigNumber.mul(fee).div(MAX_FEE);
};

const getBNMinusFee = (bigNumber, fee) => {
    return bigNumber.mul(MAX_FEE.sub(fee)).div(MAX_FEE);
};

const getFee = (amount, fee) => {
    return getBNFee(toBN(amount), fee);
};

const getMinusFee = (amount, fee) => {
    return getBNMinusFee(toBN(amount), fee);
};

const getTokensFee = (tokenAmount, fee) => {
    return getBNFee(toTokenAmount(tokenAmount), fee);
};

const getTokensMinusFee = (tokenAmount, fee) => {
    return getBNMinusFee(toTokenAmount(tokenAmount), fee);
};

const calculateDepositAmounts = amount => {
    const depositTokens = new BN(amount);
    const depositTokenFees = getFee(amount, DEPOSIT_FEE_PERC);
    const depositTokenMinusFees = depositTokens.sub(depositTokenFees);
    const lpTokens = getTokensMinusFee(amount, DEPOSIT_FEE_PERC);
    return { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens };
};

const calculateWithdrawAmounts = (amount, totalSupply, totalBalance) => {
    const withdrawTokens = new BN(amount);
    const withdrawTokenFees = getFee(amount, WITHDRAW_FEE_PERC);
    const withdrawTokenMinusFees = withdrawTokens.sub(withdrawTokenFees);
    const burnedLPTokens = withdrawTokens.mul(totalSupply).sub(new BN(1)).div(totalBalance).add(new BN(1));
    return { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens };
};

const validateAfterDeposit = async ({ feesTokens, totalLPTokensSupply, totalSharedPoolTokens, bobTokens, aliceTokens }) => {
    expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
    expect(await this.wethPlatform.totalSupply()).to.be.bignumber.equal(totalLPTokensSupply);
    expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(totalSharedPoolTokens);
    expect(await this.wethPlatform.balanceOf(bob)).to.be.bignumber.equal(bobTokens);
    expect(await this.wethPlatform.balanceOf(alice)).to.be.bignumber.equal(aliceTokens);
};

describe('Platform', () => {
    beforeEach(async () => {

        this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(100000), 18, {from: admin});
        this.token = await FakeERC20.new('Wrapped Ether', 'WETH', toTokenAmount(100000), 18, {from: admin});
        this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
        this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
        this.feesCalculator = await FeesCalculator.new({from: admin});
        this.feeModel = await FeesModel.new(this.feesCalculator.address, this.fakeOracle.address, {from: admin});
        this.fakeFeesCollector = await fakeFeesCollector.new(this.token.address, {from: admin});
        this.rewards = await Rewards.new(this.cviToken.address, {from: admin});
        this.liquidation = await Liquidation.new({from: admin});

        this.wethPlatform = await Platform.new(
            this.token.address, 'WETH-LP', 'WETH-LP', this.feeModel.address,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});

        this.rewards.setRewarder(this.wethPlatform.address, {from: admin});
        this.feesCalculator.setTurbulenceUpdator(this.feeModel.address, {from: admin});

        await this.wethPlatform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});
        await this.wethPlatform.setRewards(this.rewards.address, {from: admin});

        await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, {from: admin});
        await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, {from: admin});
    });

    it('deposits liquidity correctly', async () => {
        const bobDepositTokensNumber = 5000;
        const { depositTokens: bobDepositTokens, depositTokenFees: bobDepositTokenFees,
                depositTokenMinusFees: bobDepositTokensMinusFees, lpTokens: bobLPTokens } =
            calculateDepositAmounts(bobDepositTokensNumber);

        await this.token.transfer(bob, bobDepositTokens, {from: admin});
        expect(await this.token.balanceOf(bob)).to.be.bignumber.equal(bobDepositTokens);

        await expectRevert(this.wethPlatform.deposit(bobDepositTokens, toTokenAmount(bobDepositTokensNumber), {from: bob}), 'Too few LP tokens');
        await expectRevert(this.wethPlatform.deposit(bobDepositTokens, bobLPTokens, {from: bob}), 'ERC20: transfer amount exceeds allowance');
        await this.token.approve(this.wethPlatform.address, bobDepositTokens.sub(new BN(1)), {from: bob});
        await expectRevert(this.wethPlatform.deposit(bobDepositTokens, bobLPTokens, {from: bob}), 'ERC20: transfer amount exceeds allowance');
        await this.token.approve(this.wethPlatform.address, bobDepositTokensNumber, {from: bob});

        let tx = await this.wethPlatform.deposit(bobDepositTokens, bobLPTokens, {from: bob});
        verifyDepositEvent(tx.logs[0], bob, bobDepositTokens);

        let feesTokens = bobDepositTokenFees;
        let totalLPTokensSupply = bobLPTokens;
        let totalSharedPoolTokens = bobDepositTokensMinusFees;

        await validateAfterDeposit({ feesTokens, totalLPTokensSupply, totalSharedPoolTokens,
            bobTokens: bobLPTokens, aliceTokens: new BN(0)});

        const bobSecondDepositTokensNumber = 1000;
        const { depositTokens: bobSecondDepositTokens, depositTokenFees: bobSecondDepositTokenFees,
                depositTokenMinusFees: bobSecondDepositTokensMinusFees, lpTokens: bobSecondLPTokens } =
            calculateDepositAmounts(bobSecondDepositTokensNumber);

        await this.token.transfer(bob, bobSecondDepositTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, bobSecondDepositTokens, {from: bob});

        tx = await this.wethPlatform.deposit(bobSecondDepositTokens, bobSecondLPTokens, {from: bob});
        verifyDepositEvent(tx.logs[0], bob, bobSecondDepositTokens);

        feesTokens = feesTokens.add(bobSecondDepositTokenFees);
        totalLPTokensSupply = totalLPTokensSupply.add(bobSecondLPTokens);
        totalSharedPoolTokens = totalSharedPoolTokens.add(bobSecondDepositTokensMinusFees);

        await validateAfterDeposit({ feesTokens, totalLPTokensSupply, totalSharedPoolTokens,
            bobTokens: bobLPTokens.add(bobSecondLPTokens), aliceTokens: new BN(0)});

        const aliceDepositTokensNumber = 2000;
        const { depositTokens: aliceDepositTokens, depositTokenFees: aliceDepositTokenFees,
                depositTokenMinusFees: aliceDepositTokensMinusFees, lpTokens: aliceLPTokens } =
            calculateDepositAmounts(aliceDepositTokensNumber);

        await this.token.transfer(alice, aliceDepositTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, aliceDepositTokens, {from: alice});

        tx = await this.wethPlatform.deposit(aliceDepositTokens, aliceLPTokens, {from: alice});
        verifyDepositEvent(tx.logs[0], alice, aliceDepositTokens);

        feesTokens = feesTokens.add(aliceDepositTokenFees);
        totalLPTokensSupply = totalLPTokensSupply.add(aliceLPTokens);
        totalSharedPoolTokens = totalSharedPoolTokens.add(aliceDepositTokensMinusFees);

        await validateAfterDeposit({ feesTokens, totalLPTokensSupply, totalSharedPoolTokens,
            bobTokens: bobLPTokens.add(bobSecondLPTokens), aliceTokens: aliceLPTokens});
    });

    it('withdraws liquidity correctly', async () => {
        const bobDepositTokensNumber = 5000;
        const { depositTokens: bobDepositTokens, depositTokenFees: bobDepositTokenFees,
                depositTokenMinusFees: bobDepositTokensMinusFees, lpTokens: bobLPTokens } =
            calculateDepositAmounts(bobDepositTokensNumber);

        let totalSupply = bobLPTokens;
        let feesTokens = bobDepositTokenFees;
        let totalLPTokensSupply = bobLPTokens;
        let totalSharedPoolTokens = bobDepositTokensMinusFees;

        await this.token.transfer(bob, bobDepositTokens, {from: admin});
        await this.token.approve(this.wethPlatform.address, bobDepositTokens, {from: bob});

        await this.wethPlatform.deposit(bobDepositTokens, bobLPTokens, {from: bob});

        const bobWithdrawTokensNumber = 1000;
        const { withdrawTokens: bobWithdrawTokens, withdrawTokenFees: bobWithdrawTokenFees,
                withdrawTokenMinusFees: bobWithdrawTokenMinusFees, burnedLPTokens: bobBurnedLPTokens } =
            calculateWithdrawAmounts(bobWithdrawTokensNumber, totalSupply, totalSharedPoolTokens);

        await expectRevert(this.wethPlatform.withdraw(toBN(0), toTokenAmount(1000000), {from: bob}), 'Tokens amount must be positive');

        await expectRevert(this.wethPlatform.withdraw(toBN(1), toTokenAmount(1000000), {from: bob}), 'Funds are locked');
        await time.increase(24 * 60 * 60);
        await expectRevert(this.wethPlatform.withdraw(toBN(1), toTokenAmount(1000000), {from: bob}), 'Funds are locked');
        await time.increase(2 * 24 * 60 * 60 - 15);
        await expectRevert(this.wethPlatform.withdraw(toBN(1), toTokenAmount(1000000), {from: bob}), 'Funds are locked');
        await time.increase(15);

        await expectRevert(this.wethPlatform.withdraw(bobWithdrawTokens, bobBurnedLPTokens.sub(new BN(1)), {from: bob}), 'Too much LP tokens to burn');
        await expectRevert(this.wethPlatform.withdraw(bobDepositTokens.add(new BN(1)), toTokenAmount(1000000), {from: bob}), 'Not enough LP tokens for account');

        let tx = await this.wethPlatform.withdraw(bobWithdrawTokens, bobBurnedLPTokens, {from: bob});
        verifyWithdrawEvent(tx.logs[0], bob, bobWithdrawTokens);

        feesTokens = feesTokens.add(bobWithdrawTokenFees);
        totalLPTokensSupply = totalLPTokensSupply.sub(bobBurnedLPTokens);
        totalSharedPoolTokens = totalSharedPoolTokens.sub(bobWithdrawTokens);
        totalSupply = totalSupply.sub(bobBurnedLPTokens);

        await validateAfterDeposit({ feesTokens, totalLPTokensSupply, totalSharedPoolTokens,
            bobTokens: bobLPTokens.sub(bobBurnedLPTokens), aliceTokens: new BN(0)});

        const { withdrawTokens: bobSecondWithdrawTokens, withdrawTokenFees: bobSecondWithdrawTokenFees,
                withdrawTokenMinusFees: bobSecondWithdrawTokenMinusFees, burnedLPTokens: bobSecondBurnedLPTokens } =
            calculateWithdrawAmounts(bobWithdrawTokensNumber, totalSupply, totalSharedPoolTokens);

        tx = await this.wethPlatform.withdraw(bobSecondWithdrawTokens, bobSecondBurnedLPTokens, {from: bob});
        verifyWithdrawEvent(tx.logs[0], bob, bobSecondWithdrawTokens);

        feesTokens = feesTokens.add(bobSecondWithdrawTokenFees);
        totalLPTokensSupply = totalLPTokensSupply.sub(bobSecondBurnedLPTokens);
        totalSharedPoolTokens = totalSharedPoolTokens.sub(bobSecondWithdrawTokens);

        await validateAfterDeposit({ feesTokens, totalLPTokensSupply, totalSharedPoolTokens,
            bobTokens: bobLPTokens.sub(bobBurnedLPTokens).sub(bobSecondBurnedLPTokens), aliceTokens: new BN(0)});
    });

    it('opens a position properly', async () => {
        await this.fakePriceProvider.setPrice(50 * 1000000);

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await expectRevert(this.wethPlatform.openPosition(0, 20000, {from: alice}), 'Tokens amount must be positive');
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 0, {from: alice}), 'Bad max CVI value');
        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 20001, {from: alice}), 'Bad max CVI value');

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 4900, {from: alice}), 'CVI too high');

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(5000), 5000, {from: alice}), 'Not enough liquidity');

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});
        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');

        let tx = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let currPositionUnits = toTokenAmount(1000).mul(new BN(4)).mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE);
        verifyOpenPositionEvent(tx.logs[0], alice, toTokenAmount(1000), currPositionUnits, 5000);

        tokensInSharedPool = tokensInSharedPool.add(toTokenAmount(1000).mul(new BN(MAX_FEE - OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(toTokenAmount(1000).mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal(toTokenAmount(50000 - 1000));

        await this.fakePriceProvider.setPrice(100 * 1000000);

        // Merge position
        tx = await this.wethPlatform.openPosition(toTokenAmount(1000), 10000, {from: alice});
        currPositionUnits = currPositionUnits.add(toTokenAmount(1000).mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE).mul(new BN(2)));
        verifyOpenPositionEvent(tx.logs[0], alice, toTokenAmount(1000), currPositionUnits, 10000);

        tokensInSharedPool = tokensInSharedPool.add(toTokenAmount(1000).mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(toTokenAmount(1000).mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal(toTokenAmount(50000 - 1000 - 1000));

    });

    it('closes a position properly', async() => {
        await this.fakePriceProvider.setPrice(50 * 1000000);

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        let tx = await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});

        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        await expectRevert(this.wethPlatform.closePosition(1, 5000, {from: alice}), 'Not enough opened position units');

        tx = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        const openPositionTime = await time.latest();
        const openPositionTimestamp = openPositionTime.toNumber();
        const positionUnits = toTokenAmount(1000).mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE).mul(new BN(4));

        tokensInSharedPool = tokensInSharedPool.add(toTokenAmount(1000).mul(MAX_FEE.sub(OPEN_FEE_PERC)).div(MAX_FEE));
        feesTokens = feesTokens.add(toTokenAmount(1000).mul(OPEN_FEE_PERC).div(MAX_FEE));

        expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal(toTokenAmount(50000 - 1000));

        await expectRevert(this.wethPlatform.closePosition(positionUnits.add(new BN(1)), 5000, {from: alice}), 'Not enough opened position units');

        await expectRevert(this.wethPlatform.closePosition(0, 5000, {from: alice}), 'Position units not positive');
        await expectRevert(this.wethPlatform.closePosition(positionUnits, 0, {from: alice}), 'Bad min CVI value');
        await expectRevert(this.wethPlatform.closePosition(positionUnits, 20001, {from: alice}), 'Bad min CVI value');

        await expectRevert(this.wethPlatform.closePosition(positionUnits, 5000, {from: alice}), 'Position locked');
        await time.increaseTo(openPositionTimestamp + 23 * 60 * 60);
        await expectRevert(this.wethPlatform.closePosition(positionUnits, 5000, {from: alice}), 'Position locked');
        await time.increaseTo(openPositionTimestamp + 24 * 60 * 60 - 15);
        await expectRevert(this.wethPlatform.closePosition(positionUnits, 5000, {from: alice}), 'Position locked');
        await time.increaseTo(openPositionTimestamp + 25 * 60 * 60);

        await expectRevert(this.wethPlatform.closePosition(positionUnits, 5001, {from: alice}), 'CVI too low');

        tx = await this.wethPlatform.closePosition(positionUnits, 5000, {from: alice});
        const closePositionTime = await time.latest();

        const precisionDecimals = (new BN(10)).pow(new BN(10));
        const startSnapshot = (new BN(10)).pow(new BN(10));
        const endSnapshot = startSnapshot.add(new BN(5000).mul(precisionDecimals).mul(new BN(100000)).mul(closePositionTime.sub(openPositionTime)).div(SECONDS_PER_DAY).div(new BN(20000)).div(MAX_FUNDING_FEE));

        let fundingFees = endSnapshot.sub(startSnapshot).mul(positionUnits).div(precisionDecimals);

        let tokensReceivedBeforeFees = positionUnits.div(new BN(4)).sub(fundingFees);
        let closeFee = tokensReceivedBeforeFees.mul(CLOSE_FEE_PERC).div(MAX_FEE);
        let tokensReceived = tokensReceivedBeforeFees.sub(closeFee);

        tokensInSharedPool = tokensInSharedPool.sub(tokensReceivedBeforeFees);
        feesTokens = feesTokens.add(closeFee);

        verifyClosePositionEvent(tx.logs[0], alice, tokensReceivedBeforeFees, new BN(0), 5000);

        expect(await this.token.balanceOf(this.wethPlatform.address)).to.be.bignumber.equal(tokensInSharedPool);
        expect(await this.fakeFeesCollector.getProfit()).to.be.bignumber.equal(feesTokens);
        expect(await this.token.balanceOf(alice)).to.be.bignumber.equal(toTokenAmount(50000 - 1000).add(tokensReceived));
    });
});
