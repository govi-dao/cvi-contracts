const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const {toCVI, cviValue} = require('./utils/BNUtils.js');
const chai = require('chai');
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
const [admin, bob, alice, calie] = accounts;

const DECIMALS = 18;
const OPEN_FEE_PERC = new BN(30);
const CLOSE_FEE_PERC = new BN(30);
const DEPOSIT_FEE_PERC = new BN(30);
const WITHDRAW_FEE_PERC = new BN(30);
const MAX_FEE = new BN(10000);
const MAX_FUNDING_FEE = new BN(1000000);

const SECONDS_PER_DAY = new BN(60 * 60 * 24);

const REWARDS_FACTOR = 1000;
const MAX_REWARDS_FACTOR = 100000000;

const LIQUIDATION_MIN_THRESHOLD = 50;
const LIQUIDATION_MIN_REWARD_AMOUNT = 5;
const LIQUIDATION_MAX_REWARD_AMOUNT  = 30;
const LIQUIDATION_MAX_FEE_PERCENTAGE = 1000;

const toBN = (amount, magnitude = 0) => {
    const mag = (new BN(10)).pow(new BN(magnitude));
    return new BN(amount).mul(mag);
};

const toTokenAmount = amount => {
    return toBN(amount, DECIMALS);
};

describe('Liquidation', () => {
    beforeEach(async () => {
        this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(100000), 18, {from: admin});
        this.token = await FakeERC20.new('Wrapped Ether', 'WETH', toTokenAmount(200000), 18, {from: admin});
        this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
        this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
        this.feesCalculator = await FeesCalculator.new({from: admin});
        this.feeModel = await FeesModel.new(this.feesCalculator.address, this.fakeOracle.address, {from: admin});
        this.fakeFeesCollector = await fakeFeesCollector.new(this.token.address, {from: admin});
        this.rewards = await Rewards.new(this.cviToken.address, {from: admin});
        this.liquidation = await Liquidation.new({from: admin});

        this.wethPlatform = await Platform.new(
            this.token.address, 'WETH-LP', 'WETH-LP', INITIAL_RATE, this.feeModel.address,
            this.feesCalculator.address, this.fakeOracle.address, this.liquidation.address, {from: admin});

        this.rewards.setRewarder(this.wethPlatform.address, {from: admin});
        this.feesCalculator.setTurbulenceUpdator(this.feeModel.address, {from: admin});

        await this.wethPlatform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});
        await this.wethPlatform.setRewards(this.rewards.address, {from: admin});

        await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, {from: admin});
        await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, {from: admin});
    });

    it('isLiquidationCandidate and getLiquidationReward related checks', async () => {
        let positionBalance = new BN(90);
        let isPositive = true;
        let positionUnitsAmount = new BN(2000);
        let result = (new BN(positionUnitsAmount)).mul(new BN(LIQUIDATION_MAX_REWARD_AMOUNT)).div(new BN(LIQUIDATION_MAX_FEE_PERCENTAGE));

        expect(await this.liquidation.isLiquidationCandidate(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.true;
        expect(await this.liquidation.getLiquidationReward(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.bignumber.equal(result);

        positionBalance = new BN(90);
        isPositive = false;
        positionUnitsAmount = new BN(2000);
        result = (new BN(positionUnitsAmount)).mul(new BN(LIQUIDATION_MIN_REWARD_AMOUNT)).div(new BN(LIQUIDATION_MAX_FEE_PERCENTAGE));

        expect(await this.liquidation.isLiquidationCandidate(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.true;
        expect(await this.liquidation.getLiquidationReward(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.bignumber.equal(result);

        positionBalance = new BN(9);
        isPositive = true;
        positionUnitsAmount = new BN(2000);
        result = (new BN(positionUnitsAmount)).mul(new BN(LIQUIDATION_MIN_REWARD_AMOUNT)).div(new BN(LIQUIDATION_MAX_FEE_PERCENTAGE));

        expect(await this.liquidation.isLiquidationCandidate(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.true;
        expect(await this.liquidation.getLiquidationReward(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.bignumber.equal(result);

        positionBalance = new BN(200);
        isPositive = true;
        positionUnitsAmount = new BN(2000);

        expect(await this.liquidation.isLiquidationCandidate(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.false;
        expect(await this.liquidation.getLiquidationReward(positionBalance, isPositive, positionUnitsAmount, {from: admin})).to.be.bignumber.equal(new BN(0));
    });

    it('opens a position calculate time until until liquidation', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(bob, toTokenAmount(60000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(60000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});

        let txAlice = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsAmount} = resultAliceOne;

        let daysBeforeLiquidation = new BN(0);
        let liquidationThreshold = new BN(0);
        if (isPositiveOne) {
            let singlePositionUnitDailyFee = new BN(await this.feesCalculator.calculateSingleUnitFundingFee([{period: 86400, cviValue: 5000}]));
            let dailyFundingFee = (new BN(positionUnitsAmount)).mul(singlePositionUnitDailyFee).div(toBN(1,10));
            liquidationThreshold = (new BN(positionUnitsAmount)).mul(new BN(LIQUIDATION_MIN_THRESHOLD)).div(new BN(LIQUIDATION_MAX_FEE_PERCENTAGE));
            daysBeforeLiquidation = (new BN(currentPositionBalanceOne)).sub(new BN(liquidationThreshold)).div(new BN(dailyFundingFee));
        }

        await time.increase(86400 * (daysBeforeLiquidation -1) );
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsAmountTwo} = resultAliceTwo;
        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsAmountTwo, {from: admin})).to.be.false;

        await time.increase(86400);
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceThree = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceThree, 1: isPositiveThree, 2: positionUnitsAmountThree} = resultAliceThree;
        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceThree, isPositiveThree, positionUnitsAmountThree, {from: admin})).to.be.true;
    });

    it('opens a position until liquidation one at a time', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);


        await this.token.transfer(bob, toTokenAmount(60000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(60000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');

        let txAlice = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let txAdmin = await this.wethPlatform.openPosition(toTokenAmount(10), 5000, {from: bob});

        let bobBalanceOne = (await this.token.balanceOf(bob)).toString();

        await time.increase(86400);
        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, {from: admin})).to.be.false;

        await time.increase(86400*8);

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, {from: admin})).to.be.true;
        let tx2 = await this.wethPlatform.getLiquidableAddresses({from: admin});

        let tx3 = await this.wethPlatform.liquidatePositions([alice],{from: bob});

        expect(tx3.logs[0].event).to.be.equal('LiquidatePosition');

        let bobBalanceTwo = (await this.token.balanceOf(bob)).toString();

        expect(bobBalanceTwo).to.be.bignumber.equal(currentPositionBalanceTwo.add(new BN(bobBalanceOne)));

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');

        let tx3b = await this.wethPlatform.liquidatePositions([bob],{from: bob});
        await expectRevert(this.wethPlatform.calculatePositionBalance(bob, {from: alice}), 'No position for given address');
    });

    it('opens multiple positions, partial positions multiple liquidations together', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(bob, toTokenAmount(60000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(60000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.token.transfer(calie, toTokenAmount(500), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(500), {from: calie});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');

        let txAlice = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let txAdmin = await this.wethPlatform.openPosition(toTokenAmount(10), 5000, {from: bob});

        await time.increase(86400);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, {from: admin})).to.be.false;

        await time.increase(86400*8);
        let txCalie = await this.wethPlatform.openPosition(toTokenAmount(10), 5000, {from: calie});
        const resultCalieOne = await this.wethPlatform.calculatePositionBalance(calie);
        const { 0: currentPositionBalanceOneCal, 1: isPositiveOneCal, 2: positionUnitsOneCal} = resultCalieOne; 

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, {from: admin})).to.be.true;
        let tx2 = await this.wethPlatform.getLiquidableAddresses({from: admin});

        let tx3 = await this.wethPlatform.liquidatePositions(tx2,{from: bob});
        expect(tx3.logs[0].event).to.be.equal('LiquidatePosition');

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');

        await expectRevert( this.wethPlatform.liquidatePositions(tx2,{from: bob} ), 'No reported position was found to be liquidatable');
        await expectRevert(this.wethPlatform.calculatePositionBalance(bob, {from: alice}), 'No position for given address');

        const resultCalieTwo = await this.wethPlatform.calculatePositionBalance(calie); 
        const { 0: currentPositionBalanceTwoCal, 1: isPositiveTwoCal, 2: positionUnitsTwoCal} = resultCalieTwo; 
        expect( new BN(positionUnitsTwoCal) ).is.to.be.bignumber.equal(new BN(positionUnitsOneCal));
     });

    it('opens multiple positions, all positions liquidations together', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(bob, toTokenAmount(60000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(60000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');

        let txAlice = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});
        let txAdmin = await this.wethPlatform.openPosition(toTokenAmount(10), 5000, {from: bob});

        await time.increase(86400);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, {from: admin})).to.be.false;

        await time.increase(86400*8);

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, {from: admin})).to.be.true;
        let tx2 = await this.wethPlatform.getLiquidableAddresses({from: admin});

        let tx3 = await this.wethPlatform.liquidatePositions(tx2,{from: bob});
        expect(tx3.logs[0].event).to.be.equal('LiquidatePosition');

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');

        await expectRevert( this.wethPlatform.liquidatePositions(tx2,{from: bob} ), 'No reported position was found to be liquidatable');
        await expectRevert(this.wethPlatform.calculatePositionBalance(bob, {from: alice}), 'No position for given address');
    });

    it('opens a position until expected liquidation during close position', async () => {
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

        await this.token.transfer(bob, toTokenAmount(60000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(60000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');

        let txAlice = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});

        await time.increase(86400);
        await this.fakePriceProvider.setPrice(cviValue);

        const resultAliceOne = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, {from: admin})).to.be.false;

        await time.increase(86400 * 9);

        const resultAliceTwo = await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, {from: admin})).to.be.true;
        let tx2 = await this.wethPlatform.getLiquidableAddresses({from: admin});

        await this.wethPlatform.closePosition(toTokenAmount(1), 5000, {from: alice});

        await expectRevert(this.wethPlatform.calculatePositionBalance(alice, {from: alice}), 'No position for given address');
    });

});
