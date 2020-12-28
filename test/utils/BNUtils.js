const { BN } = require('@openzeppelin/test-helpers');

const DECIMALS = 18;

const toBN = (amount, magnitude = 0) => {
    const mag = (new BN(10)).pow(new BN(magnitude));
    return new BN(amount).mul(mag);
};

const toTokenAmount = amount => {
    return toBN(amount, DECIMALS);
};

exports.toBN = toBN;
exports.toTokenAmount = toTokenAmount;

