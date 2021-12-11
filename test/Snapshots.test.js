const {time, BN, expectRevert} = require('@openzeppelin/test-helpers');

const chai = require('chai');

const {toBN, toCVI} = require('./utils/BNUtils.js');
const {deployFullPlatform, getContracts, getAccounts, setOracle, ZERO_ADDRESS} = require('./utils/DeployUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence} = require('./utils/FeesUtils.js');

const expect = chai.expect;

const FakePriceProvider = artifacts.require('FakePriceProvider');
const ETHVolOracle = artifacts.require('ETHVolOracle');

const PRECISION_DECIMALS = toBN(1, 10);
const HEART_BEAT_SECONDS = 55 * 60;

let admin;

const setAccounts = async () => {
    [admin] = await getAccounts();
};

let firstSnapshot;
let latestSnapshotUpdateTime;

const createSnapshot = async isETH => {
    if (this.isETH) {
        return this.platform.depositETH(new BN(0), {value: new BN(1), from: admin});
    } else {
        return this.platform.deposit(new BN(1), new BN(0), {from: admin});
    }
}

const updateSnapshots = async () => {
    await createSnapshot();

    const timestamp = await time.latest();

    if(!firstSnapshot) {
        const firstSnapshotTime = timestamp;
        firstSnapshot = await this.platform.cviSnapshots(firstSnapshotTime);
    }

    latestSnapshotUpdateTime = timestamp;

    return timestamp;
};

const validateTurbulence = async (roundPeriods, lastPeriod) => {
    const startTime = await updateSnapshots();
    const turbulence = await this.feesCalculator.turbulenceIndicatorPercent();

    let currCVI = 6000;
    const lastCVI = 6000;
    let latestCVI = currCVI;
    for (let period of roundPeriods) {
        if (period !== 0) {
            await time.increase(period);
        }

        await this.fakePriceProvider.setPrice(toCVI(currCVI));
        latestCVI = currCVI;

        currCVI += 1000;
    }

    if (lastPeriod !== 0) {
        await time.increase(lastPeriod);
    }

    const latestTime = await updateSnapshots();
    const updatedTurbulence = await this.feesCalculator.turbulenceIndicatorPercent();

    const timeDiff = latestTime.sub(startTime);
    expect(updatedTurbulence).to.be.bignumber.equal(calculateNextAverageTurbulence(turbulence, timeDiff, HEART_BEAT_SECONDS, roundPeriods.length, new BN(lastCVI), new BN(latestCVI)));
};

const increaseTurbulence = async increases => {
    const roundPeriods = [];
    for (let i = 0; i < increases; i++) {
        roundPeriods.push(1 * 60);
    }

    await validateTurbulence(roundPeriods, 0);
};

const getLatestSnapshot = async () => {
    const snapshot = await this.platform.cviSnapshots(latestSnapshotUpdateTime);
    return snapshot;
};

const beforeEachSnapshots = async isETH => {
    await setAccounts();
    await deployFullPlatform(isETH);

    this.isETH = isETH;
    this.token = getContracts().token;
    this.fakePriceProvider = getContracts().fakePriceProvider;
    this.fakeOracle =getContracts().fakeOracle;
    this.feesCalculator = getContracts().feesCalculator;
    this.fakeFeesCollector = getContracts().fakeFeesCollector;
    this.liquidation = getContracts().liquidation;
    this.platform = getContracts().platform;

    if (!this.isETH) {
        await this.token.approve(this.platform.address, new BN(1000), {from: admin});
    }
};

const setSnapshotTests = () => {
    it('sets first snapshot to precision decimals', async () => {
        await updateSnapshots();
        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS);
    });

    it('calculates correct snapshot when no new oracle round exists', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        const startTime = await updateSnapshots();
        await time.increase(60 * 60);
        const endTime = await updateSnapshots();

        const singleUnitFee = calculateSingleUnitFee(5000, endTime.sub(startTime).toNumber());

        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS.add(singleUnitFee));
    });

    it('calculates correct snapshot between oracle time and timestamp is nearly identical to latest oracle round', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        const startTime = await updateSnapshots();
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        const middleTime = await time.latest();
        const endTime = await updateSnapshots();

        const singleUnitFee = calculateSingleUnitFee(5000, middleTime.sub(startTime).toNumber()).add(
            calculateSingleUnitFee(6000, endTime.sub(middleTime).toNumber()));

        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS.add(singleUnitFee));
    });

    it('calculates correct snapshot between oracle time and timestamp is after latest oracle round', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        const startTime = await updateSnapshots();
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        const endTime1 = await time.latest();
        await time.increase(2 * 60 * 60);
        const endTime2 = await updateSnapshots();

        const singleUnitFee = calculateSingleUnitFee(5000, endTime1.sub(startTime).toNumber());
        const singleUnitFee2 = calculateSingleUnitFee(6000, endTime2.sub(endTime1).toNumber());

        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS.add(singleUnitFee.add(singleUnitFee2)));
    });

    it('calculates correct snapshot between non-oracle time and timestamp identical to latest oracle round', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(3 * 60 * 60);
        const startTime = await updateSnapshots();
        await time.increase(3 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        const middleTime = await time.latest();
        const endTime = await updateSnapshots();

        const singleUnitFee = calculateSingleUnitFee(5000, middleTime.sub(startTime).toNumber());
        const singleUnitFee2 = calculateSingleUnitFee(6000, endTime.sub(middleTime).toNumber());

        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS.add(singleUnitFee.add(singleUnitFee2)));
    });

    it('calculates correct snapshot between non-oracle time and timestamp is after latest oracle round', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(3 * 60 * 60);
        const startTime = await updateSnapshots();
        await time.increase(3 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        const middleTime = await time.latest();
        await time.increase(2 * 60 * 60);
        const endTime = await updateSnapshots();

        const singleUnitFee = calculateSingleUnitFee(5000, middleTime.sub(startTime).toNumber());
        const singleUnitFee2 = calculateSingleUnitFee(6000, endTime.sub(middleTime).toNumber());

        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS.add(singleUnitFee.add(singleUnitFee2)));
    });

    it('disregards middle oracle rounds when calculating next snapshot', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000));
        await time.increase(3 * 60 * 60);
        const startTime = await updateSnapshots();
        await this.fakePriceProvider.setPrice(toCVI(7000));
        await time.increase(2 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(8000));
        await time.increase(3 * 60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(6000));
        const middleTime = await time.latest();
        await time.increase(2 * 60 * 60);
        const endTime = await updateSnapshots();

        const singleUnitFee = calculateSingleUnitFee(5000, middleTime.sub(startTime).toNumber());
        const singleUnitFee2 = calculateSingleUnitFee(6000, endTime.sub(middleTime).toNumber());

        expect(await getLatestSnapshot()).to.be.bignumber.equal(PRECISION_DECIMALS.add(singleUnitFee.add(singleUnitFee2)));
    });

    it('keeps turbuelence at zero when decaying', async () => {
        await validateTurbulence([60 * 60, 30 * 60, 3 * 60 * 60], 15 * 60);
    });

    it('updates turbulence properly when more hours passed than new rounds', async () => {
        await increaseTurbulence(10);
        await validateTurbulence([60 * 60, 30 * 60, 3 * 60 * 60], 15 * 60);
    });

    it('updates turbulence properly when new rounds are the same as hours passed', async () => {
        await increaseTurbulence(10);
        await validateTurbulence([60 * 60, 30 * 60, 120 * 60]);
    });

    it('updates turbulence properly when hours passed are less than new rounds', async () => {
        await increaseTurbulence(5);
        await validateTurbulence([60 * 60, 30 * 60, 30 * 60]);
    });

    it('caps turbulence to maximum proeprly', async () => {
        await increaseTurbulence(11);
    });

    it('zeroes turbulence if decays below minimum', async () => {
        await increaseTurbulence(3);
        await validateTurbulence([60 * 60, 60 * 60, 60 * 60]);
    });

    it('moves turbulences to end of time span', async () => {
        await increaseTurbulence(3);
        await validateTurbulence([10 * 60, 10 * 60, 10 * 60, 60 * 60]);
    });

    it('increases turbulence with minimum periods', async () => {
        await validateTurbulence([0, 0, 0]);
    });

    it('reverts when oracle round id is smaller than latest round id', async () => {
        await updateSnapshots();
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5100));
        await updateSnapshots();
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5200));
        await updateSnapshots();
        await time.increase(60 * 60);
        await this.fakePriceProvider.setPrice(toCVI(5300));

        const badRoundFakePriceProvider = await FakePriceProvider.new(toCVI(5000), {from: admin});
        await badRoundFakePriceProvider.setPrice(toCVI(5000));
        const badRoundOracle = await ETHVolOracle.new(badRoundFakePriceProvider.address, ZERO_ADDRESS, {from: admin});
        await setOracle(badRoundOracle.address, {from: admin});
        await this.feesCalculator.setOracle(badRoundOracle.address, {from: admin});

        await expectRevert(updateSnapshots(), 'Bad round id');
    });
};


describe('Snapshots ETH', () => {
    beforeEach(async () => {
        await beforeEachSnapshots(true);
    });

    setSnapshotTests(true);
});

describe('Snapshots', () => {
    beforeEach(async () => {
        await beforeEachSnapshots(false);
    });

    setSnapshotTests(false);
});
