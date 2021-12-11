const {expectRevert, BN} = require('@openzeppelin/test-helpers');

const chai = require('chai');

const { getAccounts } = require('./utils/DeployUtils.js');
const { LEVERAGE_TO_THRESHOLD, LEVERAGE_TO_MAX, 
    LIQUIDATION_MIN_REWARD_PERCENTAGE, LIQUIDATION_MAX_FEE_PERCENTAGE } = require('./utils/PlatformUtils.js');

const Liquidation = artifacts.require('Liquidation');

const expect = chai.expect;

const CVI_MAX_VALUE = new BN(22000);

const MAX_LEVERAGE = 8;
const LEVERAGES = [new BN(1)];

for (let i = 0; i < MAX_LEVERAGE; i++) {
    LEVERAGES[i] = new BN(i + 1);
}

const OPEN_CVI_VALUES = [new BN(5000), new BN(10000), new BN(15000), new BN(20000)];

let admin, alice;

const setAccounts = async () => {
    [admin, alice] = await getAccounts();
};

const calculateBalanceByPU = (positionUnits, openCVIValue, threshold, leverage = new BN(1)) => {
    const originalBalance = positionUnits.mul(openCVIValue).div(CVI_MAX_VALUE).sub(positionUnits.mul(openCVIValue).div(CVI_MAX_VALUE).mul(leverage.sub(new BN(1))).div(leverage));
    return originalBalance.mul(threshold).div(LIQUIDATION_MAX_FEE_PERCENTAGE);
};

const testLiquidationReward = async (thresholds, minRewardThreshold, maxRewards) => {
    const positionUnits = new BN(20000);

    for (let i = 0; i < MAX_LEVERAGE; i++) {
        const leverage = LEVERAGES[i];
        for (let openCVIValue of OPEN_CVI_VALUES) {
            const threshold = calculateBalanceByPU(positionUnits, openCVIValue, thresholds[i], leverage);
            const minReward = calculateBalanceByPU(positionUnits, openCVIValue, minRewardThreshold, leverage);
            const maxReward = calculateBalanceByPU(positionUnits, openCVIValue, maxRewards[i], leverage);

            // Negative amount
            expect(await this.liquidation.getLiquidationReward(threshold, false, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
            expect(await this.liquidation.getLiquidationReward(threshold.add(new BN(1)), false, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
            expect(await this.liquidation.getLiquidationReward(new BN(0), false, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
            expect(await this.liquidation.getLiquidationReward(threshold.sub(new BN(1)), false, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);

            // Positive, less than minimum
            expect(await this.liquidation.getLiquidationReward(minReward.sub(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
            expect(await this.liquidation.getLiquidationReward(minReward.div(new BN(2)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
            expect(await this.liquidation.getLiquidationReward(new BN(1), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);

            // Between minimum and maximum
            if (minReward.eq(maxReward) && !threshold.eq(maxReward)) {
                expect(await this.liquidation.getLiquidationReward(minReward, true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
            } else {

                if (!minReward.eq(threshold)) {
                    expect(await this.liquidation.getLiquidationReward(minReward, true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward);
                    expect(await this.liquidation.getLiquidationReward(minReward.add(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward.add(new BN(1)));
                }

                expect(await this.liquidation.getLiquidationReward(maxReward.sub(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(minReward.eq(maxReward) ? maxReward : maxReward.sub(new BN(1)));

                if (!threshold.eq(maxReward)) {
                    expect(await this.liquidation.getLiquidationReward(maxReward, true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(maxReward);
                }
            }

            // Between maximum and threshold
            if (!threshold.eq(maxReward)) {
                expect(await this.liquidation.getLiquidationReward(maxReward.add(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(maxReward);
                expect(await this.liquidation.getLiquidationReward(threshold.sub(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(maxReward);
            }
        }
    }
};

describe('Liquidation', () => {
    beforeEach(async () => {
        await setAccounts();
        this.liquidation = await Liquidation.new(CVI_MAX_VALUE, {from: admin});
    });

    it('detects liquidation properly', async () => {
        const positionUnits = new BN(20000);

        for (let i = 0; i < MAX_LEVERAGE; i++) {
            const leverage = LEVERAGES[i];
            for (let openCVIValue of OPEN_CVI_VALUES) {
                const balance = calculateBalanceByPU(positionUnits, openCVIValue, LEVERAGE_TO_THRESHOLD[i], leverage);

                // Note: checking only adding/subtracting 1 from balance as balance itself can be true/flase due to rounding issues

                expect(await this.liquidation.isLiquidationCandidate(balance.add(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.false;
                expect(await this.liquidation.isLiquidationCandidate(balance.sub(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.true;

                expect(await this.liquidation.isLiquidationCandidate(balance.add(new BN(1)), false, positionUnits, openCVIValue, leverage)).to.be.true;
                expect(await this.liquidation.isLiquidationCandidate(balance.sub(new BN(1)), false, positionUnits, openCVIValue, leverage)).to.be.true;
            }
        }
    });

    it('calculates liquidation reward properly', async () => {
        await testLiquidationReward(LEVERAGE_TO_THRESHOLD, LIQUIDATION_MIN_REWARD_PERCENTAGE, LEVERAGE_TO_MAX);
    });

    it('returns zero reward if no liquidation', async () => {
        const positionUnits = new BN(20000);

        for (let i = 0; i < MAX_LEVERAGE; i++) {
            const leverage = LEVERAGES[i];
            for (let openCVIValue of OPEN_CVI_VALUES) {
                const threshold = calculateBalanceByPU(positionUnits, openCVIValue, LEVERAGE_TO_THRESHOLD[i], leverage);

                expect(await this.liquidation.getLiquidationReward(threshold.add(new BN(1)), true, positionUnits, openCVIValue, leverage)).to.be.bignumber.equal(new BN(0));
            }
        }
    });

    it('sets min liquidation threshold properly', async () => {
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            expect(await this.liquidation.liquidationMinThresholdPercents(i)).to.be.bignumber.equal(LEVERAGE_TO_THRESHOLD[i]);
        }

        const newThresholds = LEVERAGE_TO_THRESHOLD.map(x => x.mul(new BN(2)));
        await this.liquidation.setMinLiquidationThresholdPercents(newThresholds, {from: admin});

        for (let i = 0; i < MAX_LEVERAGE; i++) {
            expect(await this.liquidation.liquidationMinThresholdPercents(i)).to.be.bignumber.equal(newThresholds[i]);
        }

        await testLiquidationReward(newThresholds, LIQUIDATION_MIN_REWARD_PERCENTAGE, LEVERAGE_TO_MAX);
    });

    it('sets min liquidation reward properly', async () => {
        expect(await this.liquidation.liquidationMinRewardPercent()).to.be.bignumber.equal(LIQUIDATION_MIN_REWARD_PERCENTAGE);

        await this.liquidation.setMinLiquidationRewardPercent(LIQUIDATION_MIN_REWARD_PERCENTAGE.div(new BN(2)), {from: admin});
        expect(await this.liquidation.liquidationMinRewardPercent()).to.be.bignumber.equal(LIQUIDATION_MIN_REWARD_PERCENTAGE.div(new BN(2)));
        await testLiquidationReward(LEVERAGE_TO_THRESHOLD, LIQUIDATION_MIN_REWARD_PERCENTAGE.div(new BN(2)), LEVERAGE_TO_MAX);
    });

    it('sets max liquidation reward properly', async () => {
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            expect(await this.liquidation.liquidationMaxRewardPercents(i)).to.be.bignumber.equal(LEVERAGE_TO_MAX[i]);
        }

        const newMaxRewards = LEVERAGE_TO_MAX.map(x => x.sub(new BN(10)));
        await this.liquidation.setMaxLiquidationRewardPercents(newMaxRewards, {from: admin});

        for (let i = 0; i < MAX_LEVERAGE; i++) {
            expect(await this.liquidation.liquidationMaxRewardPercents(i)).to.be.bignumber.equal(newMaxRewards[i]);
        }

        await testLiquidationReward(LEVERAGE_TO_THRESHOLD, LIQUIDATION_MIN_REWARD_PERCENTAGE, newMaxRewards);
    });

    it('reverts when setting liquidation threshold to less than max (but not equal)', async () => {
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            const newThresholds = LEVERAGE_TO_MAX.map(x => x.add(new BN(10)));
            newThresholds[i] = LEVERAGE_TO_MAX[i].sub(new BN(1));
            await expectRevert(this.liquidation.setMinLiquidationThresholdPercents(newThresholds, {from: admin}), 'Threshold less than some max');
        }

        await this.liquidation.setMinLiquidationThresholdPercents(LEVERAGE_TO_MAX, {from: admin});
    });

    it('reverts when setting liquidation max to less than min (but not equal)', async () => {
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            const newMaxRewards = [...LEVERAGE_TO_MAX];
            newMaxRewards[i] = LIQUIDATION_MIN_REWARD_PERCENTAGE.sub(new BN(1));
            await expectRevert(this.liquidation.setMaxLiquidationRewardPercents(newMaxRewards, {from: admin}), 'Some max less than min');
        }

        const allMinRewards = [];
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            allMinRewards.push(LIQUIDATION_MIN_REWARD_PERCENTAGE);
        }
        await this.liquidation.setMaxLiquidationRewardPercents(allMinRewards, {from: admin});
    });

    it('reverts when setting liquidation max to more than threshold (but not equal)', async () => {
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            const newMaxRewards = [...LEVERAGE_TO_MAX];
            newMaxRewards[i] = LEVERAGE_TO_THRESHOLD[i].add(new BN(1));
            await expectRevert(this.liquidation.setMaxLiquidationRewardPercents(newMaxRewards, {from: admin}), 'Some max greater than threshold');
        }

        await this.liquidation.setMaxLiquidationRewardPercents(LEVERAGE_TO_THRESHOLD, {from: admin});
    });

    it('reverts when setting liquidation min to more than max (but not equal)', async () => {
        await expectRevert(this.liquidation.setMinLiquidationRewardPercent(LEVERAGE_TO_MAX[0].add(new BN(1)), {from: admin}), 'Min greater than some max');
        await this.liquidation.setMinLiquidationRewardPercent(LEVERAGE_TO_MAX[0], {from: admin});
    });

    it('calculates liquidation reward properly with liquidation min equals liquidation max', async () => {
        const newMaxRewards = [];
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            newMaxRewards.push(LIQUIDATION_MIN_REWARD_PERCENTAGE);
        }

        await this.liquidation.setMaxLiquidationRewardPercents(newMaxRewards, {from: admin});

        await testLiquidationReward(LEVERAGE_TO_THRESHOLD, LIQUIDATION_MIN_REWARD_PERCENTAGE, newMaxRewards);
    });

    it('calculates liquidation reward properly with liquidation max equals liquidation threshold', async () => {
        const newMaxRewards = [];
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            newMaxRewards.push(LEVERAGE_TO_THRESHOLD[i]);
        }

        await this.liquidation.setMaxLiquidationRewardPercents(newMaxRewards, {from: admin});

        await testLiquidationReward(LEVERAGE_TO_THRESHOLD, LIQUIDATION_MIN_REWARD_PERCENTAGE, newMaxRewards);
    });

    it('calculates liquidation reward properly with liquidation min, max, and threshold are all equal', async () => {
        const newMaxRewards = [];
        for (let i = 0; i < MAX_LEVERAGE; i++) {
            newMaxRewards.push(LIQUIDATION_MIN_REWARD_PERCENTAGE);
        }

        await this.liquidation.setMaxLiquidationRewardPercents(newMaxRewards, {from: admin});
        await this.liquidation.setMinLiquidationThresholdPercents(newMaxRewards, {from: admin});

        await testLiquidationReward(newMaxRewards, LIQUIDATION_MIN_REWARD_PERCENTAGE, newMaxRewards);
    });

    it('reverts when not called by owner', async () => {
        await expectRevert(this.liquidation.setMinLiquidationRewardPercent(LIQUIDATION_MIN_REWARD_PERCENTAGE, {from: alice}), 'Ownable: caller is not the owner');
        await expectRevert(this.liquidation.setMaxLiquidationRewardPercents(LEVERAGE_TO_MAX, {from: alice}), 'Ownable: caller is not the owner');
        await expectRevert(this.liquidation.setMinLiquidationThresholdPercents(LEVERAGE_TO_THRESHOLD, {from: alice}), 'Ownable: caller is not the owner');
    });
});
