const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const {toBN, toTokenAmount} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee} = require('./utils/FeesUtils.js');

const expect = chai.expect;
const [admin, updator, bob] = accounts;

const RATIO_DECIMALS = 1e10;
const RATIO_DECIMALS_BN = new BN(RATIO_DECIMALS);
const MAX_PERCENTAGE = new BN(10000);
const MAX_PREMIUM_FEE = new BN(1000);

const SECONDS_PER_HOUR = 60 * 60;

//TODO: Test period zero in various scenarios in updateSnapshots
//TOOD: test setOracleHeartbeatPeriod, setBuyingPremiumFeeMax, setBuyingPremiumThreshold, setTurbulenceStep
//TODO: Test close fee decay new method
//TODO: Test exponent overflow in single slot calculation

const PREMIUM_FEE_TEST_RATIOS = [0.799, 0.8, 0.8, 0.94, 0.95, 0.99, 1.0, 1.01];
const PREMIUM_FEE_TEST_UNITS = [1, 1000, 2000];

const premiumFeeTests = [];

for (let i = 0; i < PREMIUM_FEE_TEST_RATIOS.length; i++) {
    for (let j = 0; j < PREMIUM_FEE_TEST_UNITS.length; j++) {
        premiumFeeTests.push({units: toTokenAmount(PREMIUM_FEE_TEST_UNITS[j]), ratio: PREMIUM_FEE_TEST_RATIOS[i]});
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

const ratioToBN = ratio => {
    return new BN(ratio * RATIO_DECIMALS);
};

const calculatePremiumFee = (units, ratio, trubulence) => {
    const ratioBN = ratioToBN(ratio);

    let fee = new BN(0);

    if (ratioBN.gte(ratioToBN(1.0))) {
        fee = MAX_PREMIUM_FEE;
    } else if (ratioBN.gte(ratioToBN(0.8))) {
        const complementRatio = RATIO_DECIMALS_BN.sub(ratioBN);
        fee = RATIO_DECIMALS_BN.mul(RATIO_DECIMALS_BN).div(complementRatio).div(complementRatio);
    }

    fee = fee.add(trubulence);
    if (fee.gt(MAX_PREMIUM_FEE)) {
        fee = MAX_PREMIUM_FEE;
    }

    return {fee: fee.mul(units).div(MAX_PERCENTAGE), ratio: ratioBN};
};

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
        this.feesCalculator = await FeesCalculator.new({from: admin});
    });

    it('updates turbulence only by udpator', async () => {
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent([], {from: updator}), 'Not allowed');
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent([], {from: admin}), 'Not allowed');
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent([], {from: bob}), 'Not allowed');

        await expectRevert(this.feesCalculator.setTurbulenceUpdator(admin, {from: bob}), 'Ownable: caller is not the owner');

        await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent([], {from: bob}), 'Not allowed');
        await expectRevert(this.feesCalculator.updateTurbulenceIndicatorPercent([], {from: admin}), 'Not allowed');
        await this.feesCalculator.updateTurbulenceIndicatorPercent([], {from: updator});
    });

    it('updates turbelence fee correctly', async () => {
        await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});
        expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(new BN(0));
        await validateTurbulenceUpdate([]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR + 1, SECONDS_PER_HOUR + 2, SECONDS_PER_HOUR + 3]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR - 1]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR, SECONDS_PER_HOUR, SECONDS_PER_HOUR]);
        await validateTurbulenceUpdate([SECONDS_PER_HOUR - 1, 1, SECONDS_PER_HOUR, 1000, SECONDS_PER_HOUR + 1]);
        await validateTurbulenceUpdate([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    });

    it('calculates buying premium fee correctly', async () => {
        await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});

        for (let i = 0; i < premiumFeeTests.length; i++) {
            const test = premiumFeeTests[i];
            const {fee, ratio} = calculatePremiumFee(test.units, test.ratio, new BN(0));
            expect(await this.feesCalculator.calculateBuyingPremiumFee(test.units, ratio)).to.be.bignumber.equal(fee);
        }

        await time.increase(3000);
        await this.feesCalculator.updateTurbulenceIndicatorPercent([3000], {from: updator}); // Increases turbulence by 1 precent

        for (let i = 0; i < premiumFeeTests.length; i++) {
            const test = premiumFeeTests[i];
            const {fee, ratio} = calculatePremiumFee(test.units, test.ratio, new BN(100));
            expect(await this.feesCalculator.calculateBuyingPremiumFee(test.units, ratio)).to.be.bignumber.equal(fee);
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
        expect(await this.feesCalculator.openPositionFeePercent()).to.be.bignumber.equal(new BN(30));
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
