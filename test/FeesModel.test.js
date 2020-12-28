const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const CVIOracle = contract.fromArtifact('CVIOracle');
const FeesModel = contract.fromArtifact('FeesModel');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const {toBN, toTokenAmount} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee} = require('./utils/FeesUtils.js');

const expect = chai.expect;
const [admin, bob, alice] = accounts;

const PRECISION_DECIMALS = toBN(1, 10);

const validateSnapshotsUpdateSequence = async values => {
    let currValue = 0;
    await this.fakePriceProvider.setPrice(values[currValue].cvi * 10000);
    const startTime = await time.latest();
    await this.feeModel.updateSnapshots();
    currValue++;

    let totalFee = new BN(0);
    while (currValue < values.length) {
        const timePassed = values[currValue].time - values[currValue - 1].time;
        await time.increase(timePassed);
        await this.fakePriceProvider.setPrice(values[currValue].cvi * 10000);
        totalFee = totalFee.add(calculateSingleUnitFee(values[currValue - 1].cvi, timePassed));
        currValue++;
    }

    await this.feeModel.updateSnapshots();
    const endTime = await time.latest();

    const finalFees = totalFee.mul(toTokenAmount(1000)).div(PRECISION_DECIMALS);
    expect(await this.feeModel.calculateFundingFees(startTime, endTime, toTokenAmount(1000))).to.be.bignumber.equal(finalFees);
};

describe('FeesModel', () => {
    beforeEach(async () => {
        this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
        this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
        this.feesCalculator = await FeesCalculator.new({from: admin});
        this.feeModel = await FeesModel.new(this.feesCalculator.address, this.fakeOracle.address, {from: admin});

        this.feesCalculator.setTurbulenceUpdator(this.feeModel.address, {from: admin});
    });

    it('skips updating same block', async () => {

    });

    it('updates snapshots properly when no new oracle value is set', async () => {

    });

    it('updates snapshots properly with a single new oracle value', async () => {
    });

    it('updates snapshots properly with multiple oracle values but below limit', async () => {
        await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {cvi: 5000, time: 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 50, time: 0}, {cvi: 50, time: 60 * 60}, {cvi: 50, time: 3 * 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 50, time: 0}, {cvi: 50, time: 60 * 60}, {cvi: 50, time: 3 * 60 * 60}, {cvi: 50, time: 5 * 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 50, time: 0}, {cvi: 80, time: 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {cvi: 8000, time: 60 * 60}, {cvi: 10000, time: 3 * 60 * 60}, {cvi: 9000, time: 5 * 60 * 60}]);
    });

    it('updates snapshots properly with multiple oracle values above limit', async () => {
    });

    it('calculateFundingFeesAddendum related tests', async () =>{
        await time.increase(3600);
        await this.fakePriceProvider.setPrice(50 * 1000000);
        await this.feeModel.updateSnapshots({from: admin}); // Restarts count

        await time.increase(3600);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('20833332');

        await time.increase(3600);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('41666666');

        await time.increase(3600);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('62500000');

        await this.feeModel.updateSnapshots({from: admin}); // Restarts count

        await time.increase(3600 * 3);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('62500000');

        await this.feeModel.updateSnapshots({from: admin}); // Restarts count

        await time.increase(3600);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('20833332');
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('20833332');

        await this.fakePriceProvider.setPrice(50 * 1000000);
        await time.increase(1800);

        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('31249998');
    });

    it('calculateFundingFeesAddendum related tests with price change', async () =>{
        await time.increase(100);
        await this.fakePriceProvider.setPrice(40 * 1000000);
        await this.feeModel.updateSnapshots({from: admin}); // Restarts count

        await time.increase(360);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('833333');
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('833333');

        await this.fakePriceProvider.setPrice(125 * 1000000);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('833333');

        await time.increase(360);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('885416');
    });
});
