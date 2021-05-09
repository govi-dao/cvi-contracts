const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const CVIOracle = contract.fromArtifact('CVIOracle');
const FeesModel = contract.fromArtifact('FeesModel');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const {toBN, toTokenAmount} = require('./utils/BNUtils.js');
const {toCVI, cviValue} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee, calculateNextTurbulence} = require('./utils/FeesUtils.js');

const expect = chai.expect;
const [admin, bob, alice] = accounts;

const PRECISION_DECIMALS = toBN(1, 10);

//TODO: Test turbulence can be turend off with 0 period

const validateSnapshotsUpdateSequence = async values => {
    const startTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();

    let currValue = 0;
    await this.fakePriceProvider.setPrice(toCVI(values[currValue].cvi));
    const startTime = await time.latest();
    await this.feeModel.updateSnapshots();
    let lastCVI = values[currValue].cvi;
    let timeFromLastCVI = 0;
    currValue++;

    const periods = [];

    let totalFee = new BN(0);
    while (currValue < values.length) {
        const timePassed = values[currValue].time - values[currValue - 1].time;
        timeFromLastCVI += timePassed;
        await time.increase(timePassed);

        totalFee = totalFee.add(calculateSingleUnitFee(lastCVI, timePassed));

        if (values[currValue].cvi !== undefined) {
            await this.fakePriceProvider.setPrice(toCVI(values[currValue].cvi));
            lastCVI = values[currValue].cvi;
        } else {
            await this.feeModel.updateSnapshots();
            periods.push(timeFromLastCVI);
            timeFromLastCVI = 0;
        }

        currValue++;
    }

    //console.log(periods);

    //console.log(startTurbulence.toString());
    const nextTurbulence = calculateNextTurbulence(startTurbulence, periods);
    //console.log(nextTurbulence.toString());

    await this.feeModel.updateSnapshots();

    //console.log((await this.feesCalculator.turbulenceIndicatorPercent()).toString());
    const endTime = await time.latest();

    const finalFees = totalFee.mul(toTokenAmount(1000)).div(PRECISION_DECIMALS);
    expect(await this.feeModel.calculateFundingFees(startTime, endTime, toTokenAmount(1000))).to.be.bignumber.equal(finalFees);

    expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(nextTurbulence);
};

//TODO: Test period zero in various scenarios in updateSnapshots

//TODO: Improt from usdt rewards

describe.skip('FeesModel', () => {
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
        await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {time: 60 * 60}]);
        await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {time: 60 * 60}, {cvi: 5000, time: 119 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {cvi: 5000, time: 60 * 60}, {cvi: 5000, time: 2 * 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}]);
        //await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {cvi: 12000, time: 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 50, time: 0}, {cvi: 50, time: 60 * 60}, {cvi: 50, time: 3 * 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 50, time: 0}, {cvi: 50, time: 60 * 60}, {cvi: 50, time: 3 * 60 * 60}, {cvi: 50, time: 5 * 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 50, time: 0}, {cvi: 80, time: 60 * 60}]);
        //await validateSnapshotsUpdateSequence([{cvi: 5000, time: 0}, {cvi: 8000, time: 60 * 60}, {cvi: 10000, time: 3 * 60 * 60}, {cvi: 9000, time: 5 * 60 * 60}]);
    });

    it('updates snapshots properly with multiple oracle values above limit', async () => {
    });

    it('calculateFundingFeesAddendum related tests', async () =>{
        await time.increase(3600);
        let cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);

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

        cviValue = toCVI(5000);
        await this.fakePriceProvider.setPrice(cviValue);
        await time.increase(1800);

        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(2,10), {from: admin})).to.be.bignumber.equal('31249998');
    });

    it('calculateFundingFeesAddendum related tests with price change', async () =>{
        await time.increase(100);
        let cviValue = toCVI(4000);
        await this.fakePriceProvider.setPrice(cviValue);
        await this.feeModel.updateSnapshots({from: admin}); // Restarts count

        await time.increase(360);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('833333');
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('833333');

        cviValue = toCVI(12500);
        await this.fakePriceProvider.setPrice(cviValue);

        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('833333');

        await time.increase(360);
        expect(await this.feeModel.calculateFundingFeesAddendum(toBN(1,10), {from: admin})).to.be.bignumber.equal('885416');
    });
});
