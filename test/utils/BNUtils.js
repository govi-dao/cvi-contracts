const { BN } = require('@openzeppelin/test-helpers');

const DECIMALS = 18;
const CVI_DECIMALS = 16;

const toBN = (amount, magnitude = 0) => {
    const mag = (new BN(10)).pow(new BN(magnitude));
    return new BN(amount).mul(mag);
};

const toTokenAmount = amount => {
    return toBN(amount, DECIMALS);
};

const toUSDT = amount => {
	return toBN(amount, 6);
};

const toCVI = cviValue => {
    return toBN(cviValue, CVI_DECIMALS);
};

exports.toBN = toBN;
exports.toTokenAmount = toTokenAmount;
exports.toCVI = toCVI;
exports.toUSDT = toUSDT;
