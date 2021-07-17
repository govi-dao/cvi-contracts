const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');

const FeesCalculator = contract.fromArtifact('FeesCalculator');
const CVIOracle = contract.fromArtifact('ETHVolOracle');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');

const {getContracts} = require('./utils/DeployUtils.js');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee, calculatePremiumFee, MAX_PERCENTAGE} = require('./utils/FeesUtils.js');
const { print } = require('./utils/DebugUtils');

const expect = chai.expect;
const [admin, updator, bob] = accounts;

const SECONDS_PER_HOUR = 60 * 60;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

//TODO: Test period zero in various scenarios in updateSnapshots
//TOOD: test setOracleHeartbeatPeriod, setBuyingPremiumFeeMax, setBuyingPremiumThreshold, setTurbulenceStep
//TODO: Test close fee decay new method
//TODO: Test exponent overflow in single slot calculation

const PREMIUM_FEE_TEST_RATIOS = [0.799, 0.81, 0.81, 0.94, 0.95, 0.99, 1.0, 1.01];
const PREMIUM_FEE_TEST_LAST_RATIOS = [0.7, 0.75, 0.7, 0.76, 0.7, 0.4, 0.5, 0.6];
const PREMIUM_FEE_TEST_UNITS = [1, 1000, 2000];

const MAX_CVI_VALUE = toBN(22000);

const RATIO_DECIMALS = toBN(1, 10);

const premiumFeeTests = [];

for (let i = 0; i < PREMIUM_FEE_TEST_RATIOS.length; i++) {
    for (let j = 0; j < PREMIUM_FEE_TEST_UNITS.length; j++) {
        const ratio = toBN(PREMIUM_FEE_TEST_RATIOS[i] * 1000, 7);
        premiumFeeTests.push({units: toTokenAmount(PREMIUM_FEE_TEST_UNITS[j]), ratio, lastRatio: ratio.sub(new BN(1))});
        premiumFeeTests.push({units: toTokenAmount(PREMIUM_FEE_TEST_UNITS[j]), ratio, lastRatio: toBN(PREMIUM_FEE_TEST_LAST_RATIOS[i] * 1000, 7)});
    }
}

const FUNDING_FEE_TESTS = [
    [{period: 0, cviValue: 0}],
    [{period: 86400, cviValue: 0}],
    [{period: 0, cviValue: 10000}],
    [{period: 86400, cviValue: 2000}],
    [{period: 172800, cviValue: 5500}],
    [{period: 86400, cviValue: 6000}],
    [{period: 86400, cviValue: 8000}],
    [{period: 86400, cviValue: 11000}],
    [{period: 172800, cviValue: 16000}],
    [{period: 86400, cviValue: 20000}],
    [{period: 8888, cviValue: 11700}],
    [{period: 15000, cviValue: 12100}],
    [{period: 7777, cviValue: 12100}]
];

const validateTurbulenceUpdate = async periods => {
    let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();

    await this.feesCalculator.updateTurbulenceIndicatorPercent(periods, {from: updator});

    for (let i = 0; i < periods.length; i++) {
        if (periods[i] >= SECONDS_PER_HOUR) {
            currTurbulence = currTurbulence.div(new BN(2));
            if (currTurbulence.lt(new BN(100))) {
                currTurbulence = new BN(0);
            }
        } else {
            currTurbulence = currTurbulence.add(new BN(100));
        }
    }

    if (currTurbulence.gt(new BN(1000))) {
        currTurbulence = new BN(1000);
    }

    expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(currTurbulence);
};

describe('FeesCalcaultor', () => {
    beforeEach(async () => {
        this.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
        this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, {from: admin});
        this.feesCalculator = await FeesCalculator.new(this.fakeOracle.address, MAX_CVI_VALUE, {from: admin});

        this.fakePriceProvider.setPrice(toCVI(5000), {from: admin});
    });

    it('sets oracle properly', async () => {
        expect(await this.feesCalculator.cviOracle()).to.equal(this.fakeOracle.address);
        this.feesCalculator.setOracle(ZERO_ADDRESS, {from: admin});
        expect(await this.feesCalculator.cviOracle()).to.equal(ZERO_ADDRESS);

        const currTimestamp = await time.latest();
        await expectRevert.unspecified(this.feesCalculator.updateSnapshots(currTimestamp.sub(new BN(1000)), 0, RATIO_DECIMALS, 1));
    });

    it('reverts when attempting to execute an ownable function by non admin user', async () => {
        const expectedError = 'Ownable: caller is not the owner';
        await expectRevert(this.feesCalculator.setOracle(ZERO_ADDRESS, {from: bob}), expectedError);

        //TODO: More functions
    });

    it('updates turbulence only by udpator', async () => {
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, {from: updator}), 'Not allowed');
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, {from: admin}), 'Not allowed');
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, {from: bob}), 'Not allowed');

        await expectRevert(this.feesCalculator.setTurbulenceUpdator(admin, {from: bob}), 'Ownable: caller is not the owner');

        await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, {from: bob}), 'Not allowed');
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, {from: admin}), 'Not allowed');
        await this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, {from: updator});
    });

    //TODO: Create auto-calculation with values for different cases (instead of commented test below)
    it('calculate turbulence indicator percent capped by CVI values relative difference', async () => {
        let totalHeartbeats = new BN(3);
        let newRounds = new BN(5);
        let lastCVIValue = 10000;
        let currCVIValue = 11500;

        expect(await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalHeartbeats, newRounds, lastCVIValue, currCVIValue)).to.be.bignumber.equal(new BN(200)); //2%
        currCVIValue = 10200;
        expect(await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalHeartbeats, newRounds, lastCVIValue, currCVIValue)).to.be.bignumber.equal(new BN(0));
        currCVIValue = 12500;
        totalHeartbeats = new BN(2);
        expect(await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalHeartbeats, newRounds, lastCVIValue, currCVIValue)).to.be.bignumber.equal(new BN(300));
        currCVIValue = 10500;
        expect(await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalHeartbeats, newRounds, lastCVIValue, currCVIValue)).to.be.bignumber.equal(new BN(100));
        lastCVIValue = 5000;
        currCVIValue = 5250;
        expect(await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalHeartbeats, newRounds, lastCVIValue, currCVIValue)).to.be.bignumber.equal(new BN(100));
        currCVIValue = 5000;
        lastCVIValue = 5350;
        expect(await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalHeartbeats, newRounds, lastCVIValue, currCVIValue)).to.be.bignumber.equal(new BN(100));
    });

    /*it('updates turbelence fee correctly', async () => {
        await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});
        expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(new BN(0));
        await validateTurbulenceUpdate([]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR + 1, SECONDS_PER_HOUR + 2, SECONDS_PER_HOUR + 3]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR - 1]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR, SECONDS_PER_HOUR, SECONDS_PER_HOUR]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR - 1, 1, SECONDS_PER_HOUR, 1000, SECONDS_PER_HOUR + 1]);
        await validateTurbulenceUpdate([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    });*/

    it('calculates buying premium fee correctly', async () => {
        await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});

        for (let i = 0; i < premiumFeeTests.length; i++) {
            const test = premiumFeeTests[i];
            const {fee, feePercentage} = calculatePremiumFee(test.units, test.ratio, test.lastRatio, new BN(0));
            const result = await this.feesCalculator.calculateBuyingPremiumFee(test.units, 1, test.ratio, test.lastRatio);

            expect(result[0]).to.be.bignumber.equal(fee);
            expect(result[1]).to.be.bignumber.equal(feePercentage);
        }

        await time.increase(3000);
        await this.feesCalculator.updateTurbulenceIndicatorPercent(55 * 5 * 60, 6, 50000, 60000, {from: updator}); // Increases turbulence by 1 precent

        for (let i = 0; i < premiumFeeTests.length; i++) {
            const test = premiumFeeTests[i];
            const {fee, feePercentage} = calculatePremiumFee(test.units, test.ratio, test.lastRatio, new BN(100));

            const result = await this.feesCalculator.calculateBuyingPremiumFee(test.units, 1, test.ratio, test.lastRatio);

            expect(result[0]).to.be.bignumber.equal(fee);
            expect(result[1]).to.be.bignumber.equal(feePercentage);
        }
    });

    it('sets and gets deposit fee correctly', async() => {
        expect(await this.feesCalculator.depositFeePercent()).to.be.bignumber.equal(new BN(0));
        await expectRevert(this.feesCalculator.setDepositFee(new BN(10), {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.feesCalculator.setDepositFee(MAX_PERCENTAGE, {from: admin}), 'Fee exceeds maximum');
        await this.feesCalculator.setDepositFee(new BN(10), {from: admin});
        expect(await this.feesCalculator.depositFeePercent()).to.be.bignumber.equal(new BN(10));
    });

    it('sets and gets withdraw fee correctly', async() => {
        expect(await this.feesCalculator.withdrawFeePercent()).to.be.bignumber.equal(new BN(0));
        await expectRevert(this.feesCalculator.setWithdrawFee(new BN(10), {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.feesCalculator.setWithdrawFee(MAX_PERCENTAGE, {from: admin}), 'Fee exceeds maximum');
        await this.feesCalculator.setWithdrawFee(new BN(10), {from: admin});
        expect(await this.feesCalculator.withdrawFeePercent()).to.be.bignumber.equal(new BN(10));
    });

    it('sets and gets open position fee correctly', async() => {
        expect(await this.feesCalculator.openPositionFeePercent()).to.be.bignumber.equal(new BN(15));
        await expectRevert(this.feesCalculator.setOpenPositionFee(new BN(40), {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.feesCalculator.setOpenPositionFee(MAX_PERCENTAGE, {from: admin}), 'Fee exceeds maximum');
        await this.feesCalculator.setOpenPositionFee(new BN(40), {from: admin});
        expect(await this.feesCalculator.openPositionFeePercent()).to.be.bignumber.equal(new BN(40));
    });

    it('sets and gets close position fee correctly', async() => {
        expect(await this.feesCalculator.closePositionFeePercent()).to.be.bignumber.equal(new BN(30));
        await expectRevert(this.feesCalculator.setClosePositionFee(new BN(40), {from: bob}), 'Ownable: caller is not the owner');
        await expectRevert(this.feesCalculator.setClosePositionFee(MAX_PERCENTAGE, {from: admin}), 'Fee exceeds maximum');
        await this.feesCalculator.setClosePositionFee(new BN(40), {from: admin});
        expect(await this.feesCalculator.closePositionFeePercent()).to.be.bignumber.equal(new BN(40));
    });

    it('calculates single unit funding fee properly', async () => {
        getContracts().maxCVIValue = new BN(22000);

        const allValues = [];
        let allValuesResult = new BN(0);
        for (let i = 0; i < FUNDING_FEE_TESTS.length; i++) {
            const result = calculateSingleUnitFee(FUNDING_FEE_TESTS[i][0].cviValue, FUNDING_FEE_TESTS[i][0].period);
            expect(await this.feesCalculator.calculateSingleUnitFundingFee(FUNDING_FEE_TESTS[i])).to.be.bignumber.equal(result);
            allValuesResult = allValuesResult.add(result);
            allValues.push(FUNDING_FEE_TESTS[i][0]);
        }

        expect(await this.feesCalculator.calculateSingleUnitFundingFee(allValues)).to.be.bignumber.equal(allValuesResult);
    });
});
