const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
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
const [admin, bob, alice] = accounts;

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
        this.feesCalculator.setTurbulenceUpdator(this.wethPlatform.address, {from: admin});

        await this.wethPlatform.setFeesCollector(this.fakeFeesCollector.address, {from: admin});
        await this.wethPlatform.setRewards(this.rewards.address, {from: admin});

        await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, {from: admin});
        await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, {from: admin});
    });

    it('opens a position until liquidation', async () => {
        await this.fakePriceProvider.setPrice(50 * 1000000);

        await this.token.transfer(bob, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: bob});

        await this.token.transfer(alice, toTokenAmount(50000), {from: admin});
        await this.token.approve(this.wethPlatform.address, toTokenAmount(50000), {from: alice});

        await this.wethPlatform.deposit(toTokenAmount(50000), toTokenAmount(48500), {from: bob});
        let feesTokens = toTokenAmount(50000).mul(DEPOSIT_FEE_PERC).div(MAX_FEE);
        let tokensInSharedPool = toTokenAmount(50000).mul(MAX_FEE.sub(DEPOSIT_FEE_PERC)).div(MAX_FEE);

        await expectRevert(this.wethPlatform.openPosition(toTokenAmount(50000), 5000, {from: alice}), 'Not enough liquidity');

        let tx = await this.wethPlatform.openPosition(toTokenAmount(1000), 5000, {from: alice});

        await time.increase(86400);
        await this.fakePriceProvider.setPrice(50 * 1000000);

        const resultAliceOne= await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceOne, 1: isPositiveOne, 2: positionUnitsOne} = resultAliceOne;
        //console.log(currentPositionBalanceOne.toString(), isPositiveOne, positionUnitsOne.toString());

        //await this.liquidation.isLiquidationCandidateAddress(alice, {from: admin});
        let toLiquidate = await this.liquidation.isLiquidationCandidate('897300000000000000000', true, '3988000000000000000000', {from: admin});
        //console.log('toLiquidate alice ' + toLiquidate);

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceOne, isPositiveOne, positionUnitsOne, {from: admin})).to.be.false;
        //expect(await this.liquidation.isLiquidationCandidateAddress(alice)).to.be.false;

        await time.increase(86400*8);

        const resultAliceTwo= await this.wethPlatform.calculatePositionBalance(alice);
        const { 0: currentPositionBalanceTwo, 1: isPositiveTwo, 2: positionUnitsTwo} = resultAliceTwo;
        //console.log(currentPositionBalanceTwo.toString(), isPositiveTwo, positionUnitsTwo.toString());

        expect(await this.liquidation.isLiquidationCandidate(currentPositionBalanceTwo, isPositiveTwo, positionUnitsTwo, {from: admin})).to.be.true;
        //expect(await this.liquidation.isLiquidationCandidateAddress(alice)).to.be.true;

        let tx2 = await this.wethPlatform.getLiquidableAddresses({from: admin});
        console.log(tx2);

    });
});
