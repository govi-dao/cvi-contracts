const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');

const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');
const expect = chai.expect;

const [admin, bob] = accounts;
const TEST_AMOUNTS = [0, 500, 1000, 7500, 20000];

const RequestFeesCalculator = contract.fromArtifact('RequestFeesCalculator');

const SECONDS_PER_HOUR = 60 * 60;

const MIN_WAIT_TIME = 15 * 60;

const FINDERS_FEE_PERCENT = new BN(5000);

const MAX_TIME_DELAY_FEE = new BN(100);
const MIN_TIME_DELAY_FEE = new BN(0);

const MIN_PENALTY_FEE = new BN(300);
const MAX_PENALTY_FEE = new BN(500);
const MID_PENALTY_FEE = new BN(300);

const MIN_TIME_DELAY = SECONDS_PER_HOUR;
const MAX_TIME_DELAY = 3 * SECONDS_PER_HOUR;

const MID_PENALTY_TIME = 1 * SECONDS_PER_HOUR;
const MAX_PENALTY_TIME = 12 * SECONDS_PER_HOUR;

const MAX_PERCENTAGE = new BN(10000);

const createRequest = (requestType, tokenAmount, maxRequestFeesPercent, owner, requestTimestamp, targetTimestamp) => {
    return {requestType, tokenAmount, maxRequestFeesPercent, owner, requestTimestamp: requestTimestamp.toString(), targetTimestamp: targetTimestamp.toString()};
};

describe('RequestFeesCalcaultor', () => {
    beforeEach(async () => {
        this.requestFeesCalculator = await RequestFeesCalculator.new({from: admin});
    });

    it('calculates finders fee properly', async () => {
        for (let amount of TEST_AMOUNTS) {
            const findersFee = new BN(amount).mul(FINDERS_FEE_PERCENT).div(MAX_PERCENTAGE);
            expect(await this.requestFeesCalculator.calculateFindersFee(amount)).to.be.bignumber.equal(findersFee);
        }
    });

    it('reverts when time delay is too small', async () => {
        await expectRevert(this.requestFeesCalculator.calculateTimeDelayFee(1000, MIN_TIME_DELAY - 2), 'Time delay too small');
        await this.requestFeesCalculator.calculateTimeDelayFee(1000, MIN_TIME_DELAY);
    });

    it('reverts when time delay is too big', async () => {
        await expectRevert(this.requestFeesCalculator.calculateTimeDelayFee(1000, MAX_TIME_DELAY + 1), 'Time delay too big');
        await this.requestFeesCalculator.calculateTimeDelayFee(1000, MAX_TIME_DELAY - 1);
    });

    it('calculates time delay fee properly', async () => {
        const timeDelays = [SECONDS_PER_HOUR, 2 * SECONDS_PER_HOUR, 3 * SECONDS_PER_HOUR];

        for (let amount of TEST_AMOUNTS) {
            for (let timeDelay of timeDelays) {
                const timeFeePercentage = (new BN(timeDelay)).sub(new BN(SECONDS_PER_HOUR)).mul(MAX_TIME_DELAY_FEE.sub(MIN_TIME_DELAY_FEE)).div(new BN(2 * SECONDS_PER_HOUR));
                const timeFee = (new BN(amount)).mul(timeFeePercentage).div(MAX_PERCENTAGE);
                expect(await this.requestFeesCalculator.calculateTimeDelayFee(amount, timeDelay)).to.be.bignumber.equal(timeFee);
            }
        }
    });

    it('determines liquidity properly', async () => {
        let now = await time.latest();
        expect(await this.requestFeesCalculator.isLiquidable(createRequest(1, 1000, 500, bob, now, now.sub(new BN(MAX_PENALTY_TIME + 2))))).to.be.true;
        now = await time.latest();
        expect(await this.requestFeesCalculator.isLiquidable(createRequest(1, 1000, 500, bob, now, now.sub(new BN(MAX_PENALTY_TIME - 2))))).to.be.false;
    });

    it('gets max fee properly', async () => {
        for (let amount of TEST_AMOUNTS) {
            const result = await this.requestFeesCalculator.getMaxFees(amount);
            const actualMaxFeesPercent = result[0];
            const actualMaxFeesAmount = result[1];

            expect(actualMaxFeesPercent).to.be.bignumber.equal(MAX_PENALTY_FEE.add(MAX_TIME_DELAY_FEE));
            expect(actualMaxFeesAmount).to.be.bignumber.equal(new BN(amount).mul(actualMaxFeesPercent).div(MAX_PERCENTAGE));
        }
    });

    it('calculates time penalty fee properly until target time', async () => {
        const delay = SECONDS_PER_HOUR - MIN_WAIT_TIME;
        const timesAfterMinRequestTime = [0, 1, delay / 2, delay / 3, delay * 2 / 3];

        for (let amount of TEST_AMOUNTS) {
            for (let timeAfterRequest of timesAfterMinRequestTime) {
                const flooredTimeAfterMinRequestTime = Math.floor(timeAfterRequest);
                const now = await time.latest();
                const feePercentage = (new BN(delay - flooredTimeAfterMinRequestTime)).mul(MIN_PENALTY_FEE).div(new BN(delay));
                const fee = await this.requestFeesCalculator.calculateTimePenaltyFee(createRequest(1, amount, 500, bob, now.sub(new BN(flooredTimeAfterMinRequestTime + MIN_WAIT_TIME)), now.add(new BN(delay - flooredTimeAfterMinRequestTime))));
                expect(fee).to.be.bignumber.equal(new BN(amount).mul(feePercentage).div(MAX_PERCENTAGE));
            }
        }
    });

    it('calculates time penalty fee properly until mid time', async () => {
        const timesAfterTarget = [0, 1, MID_PENALTY_TIME / 2, MID_PENALTY_TIME / 3, MID_PENALTY_TIME * 2 / 3];
        const delay = SECONDS_PER_HOUR;

        for (let amount of TEST_AMOUNTS) {
            for (let timeAfterTarget of timesAfterTarget) {
                const flooredTimeAfterTarget = Math.floor(timeAfterTarget);
                const now = await time.latest();
                const feePercentage = (new BN(flooredTimeAfterTarget)).mul(MID_PENALTY_FEE).div(new BN(MID_PENALTY_TIME));
                const fee = await this.requestFeesCalculator.calculateTimePenaltyFee(createRequest(1, amount, 500, bob, now.sub(new BN(flooredTimeAfterTarget + delay)), now.sub(new BN(flooredTimeAfterTarget))));
                expect(fee).to.be.bignumber.equal(new BN(amount).mul(feePercentage).div(MAX_PERCENTAGE));
            }
        }
    });

    it('calculates time penalty fee properly until max time', async () => {
        const timesAfterTarget = [MID_PENALTY_TIME, MID_PENALTY_TIME + 1, (MID_PENALTY_TIME + MAX_PENALTY_TIME) / 2,
            MID_PENALTY_TIME + (MAX_PENALTY_TIME - MID_PENALTY_TIME) / 3, MID_PENALTY_TIME + (MAX_PENALTY_TIME - MID_PENALTY_TIME) * 2 / 3];
        const delay = SECONDS_PER_HOUR;

        for (let amount of TEST_AMOUNTS) {
            for (let timeAfterTarget of timesAfterTarget) {
                const flooredTimeAfterTarget = Math.floor(timeAfterTarget);
                const now = await time.latest();
                const feePercentage = (new BN(MID_PENALTY_FEE)).add((new BN(flooredTimeAfterTarget)).sub(new BN(MID_PENALTY_TIME)).mul(MAX_PENALTY_FEE.sub(new BN(MID_PENALTY_FEE))).div(new BN(MAX_PENALTY_TIME - MID_PENALTY_TIME)));
                const fee = await this.requestFeesCalculator.calculateTimePenaltyFee(createRequest(1, amount, 500, bob, now.sub(new BN(flooredTimeAfterTarget + delay)), now.sub(new BN(flooredTimeAfterTarget))));
                expect(fee).to.be.bignumber.equal(new BN(amount).mul(feePercentage).div(MAX_PERCENTAGE));
            }
        }
    });

    it('calculates time penalty fee properly after max time', async () => {
        const timesAfterTarget = [MAX_PENALTY_TIME, MAX_PENALTY_TIME + 1, MAX_PENALTY_TIME * 2];
        const delay = SECONDS_PER_HOUR;

        for (let amount of TEST_AMOUNTS) {
            for (let timeAfterTarget of timesAfterTarget) {
                const now = await time.latest();
                const fee = await this.requestFeesCalculator.calculateTimePenaltyFee(createRequest(1, amount, 500, bob, now.sub(new BN(timeAfterTarget + delay)), now.sub(new BN(timeAfterTarget))));
                expect(fee).to.be.bignumber.equal(new BN(amount).mul(MAX_PENALTY_FEE).div(MAX_PERCENTAGE));
            }
        }
    });
});
