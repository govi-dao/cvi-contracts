const { BN } = require('@openzeppelin/test-helpers');

const RATIO_DECIMALS = 1e10;
const RATIO_DECIMALS_BN = new BN(RATIO_DECIMALS);
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

const calculateSingleUnitFee = (cviValue, period) => {
    const coefficients = [100000, 114869, 131950, 151571, 174110];

    if (cviValue === 0 || period === 0) {
        return new BN(0);
    }

    const intCVIValue = Math.floor(cviValue / 100);

    let fundingFeeRate = null;
    if (intCVIValue <= 55) {
        fundingFeeRate = new BN(100000);
    } else if (intCVIValue >= 110) {
        fundingFeeRate = new BN(2000);
    } else {
        const coefficient = new BN(coefficients[(intCVIValue - 55) % 5]);
        fundingFeeRate = RATIO_DECIMALS_BN.div(new BN(2).pow(new BN(intCVIValue).sub(new BN(55)).div(new BN(5)))).div(coefficient).add(new BN(2000));
    }

    return (new BN(cviValue)).mul(RATIO_DECIMALS_BN).mul(fundingFeeRate).mul(new BN(period)).div(new BN(SECONDS_PER_DAY)).div(new BN(20000)).div(new BN(1000000));
};

const calculateNextTurbulence = (currTurbulence, periods) => {
	let nextTurbulence = currTurbulence;
    for (let i = 0; i < periods.length; i++) {
        if (periods[i] >= SECONDS_PER_HOUR) {
            nextTurbulence = currTurbulence.div(new BN(2));
        } else {
            nextTurbulence = currTurbulence.add(new BN(100));
        }
    }

    if (nextTurbulence.gt(new BN(1000))) {
        nextTurbulence = new BN(1000);
    }

    return nextTurbulence;
};

exports.calculateSingleUnitFee = calculateSingleUnitFee;
exports.calculateNextTurbulence = calculateNextTurbulence;
