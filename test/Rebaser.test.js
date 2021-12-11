const { expectRevert, time } = require('@openzeppelin/test-helpers');

const { toBN } = require('./utils/BNUtils.js');
const { getAccounts, ZERO_ADDRESS } = require('./utils/DeployUtils.js');
const chai = require('chai');
const expect = chai.expect;

const FakeVolatilityToken = artifacts.require('FakeVolatilityToken');
const FakeUniswapV2Pair = artifacts.require('FakeUniswapV2Pair');
const Rebaser = artifacts.require('Rebaser');

const SECONDS_IN_DAY = 86400;
const MOCK_BYTES32 = '0x7465737400000000000000000000000000000000000000000000000000000000';

let admin, bob, alice, carol, dave;

const setAccounts = async () => {
    [admin, bob, alice, carol, dave] = await getAccounts();
};

const beforeEachToken = async () => {
  this.fakeVolToken = await FakeVolatilityToken.new({ from: admin });
  this.fakeVolToken.initialize('CVI-USDC', 'CVI-USDC', { from: admin });

  this.fakeUniswapV2PairA = await FakeUniswapV2Pair.new({ from: admin });
  this.fakeUniswapV2PairB = await FakeUniswapV2Pair.new({ from: admin });

  this.rebaser = await Rebaser.new(
    this.fakeVolToken.address,
    [this.fakeUniswapV2PairA.address, this.fakeUniswapV2PairB.address],
    { from: admin }
  );

  await this.fakeVolToken.setRebaser(this.rebaser.address, { from: admin });
};

const moveTimeToTimeWindow = async () => {
  const now = toBN(Math.floor(Date.now() / 1000));
  const lastUpkeepTime = await this.rebaser.lastUpkeepTime();
  const upkeepInterval = await this.rebaser.upkeepInterval();
  const upkeepTimeWindow = await this.rebaser.upkeepTimeWindow();
  const onInterval = now.gte(lastUpkeepTime) && now.lte(lastUpkeepTime.add(upkeepTimeWindow));

  if (!onInterval) {
    await time.increaseTo(lastUpkeepTime.add(upkeepInterval));
  }
};

describe('Rebaser', () => {
  beforeEach(async () => {
    await setAccounts();
    await beforeEachToken();
  });

  it('validates default values after initialization', async () => {
    const lastUpkeepTime = await this.rebaser.lastUpkeepTime();
    const thisDay12UTC = toBN(Math.floor(Date.now() / SECONDS_IN_DAY / 1000) * SECONDS_IN_DAY);

    expect(lastUpkeepTime.eq(thisDay12UTC));
  });

  it('reverts when attempting to execute an ownable function by non admin user', async () => {
    const expectedError = 'Ownable: caller is not the owner';

    const newFakeVolToken = await FakeVolatilityToken.new({ from: admin });
    await newFakeVolToken.initialize('CVI-USDC', 'CVI-USDC', { from: admin });
    await newFakeVolToken.setRebaser(this.rebaser.address, { from: admin });
    
    await expectRevert(this.rebaser.setVolatilityToken(newFakeVolToken.address, {from: bob}), expectedError)
    await expectRevert(this.rebaser.setUniswapPairs([], {from: alice}), expectedError);
    await expectRevert(this.rebaser.setUpkeepInterval(40000, {from: dave}), expectedError);
    await expectRevert(this.rebaser.setUpkeepTimeWindow(1000, {from: carol}), expectedError);
    await expectRevert(this.rebaser.setEnableWhitelist(false, {from: bob}), expectedError);
    await expectRevert(this.rebaser.setRebaserAddress(newFakeVolToken.address, true, {from: alice}), expectedError);
});

  it('reverts in rebase if rebaser address is not whitelisted', async () => {
    await this.rebaser.setRebaserAddress(bob, false, { from: admin });
    await expectRevert(this.rebaser.rebase({ from: bob }), 'Whitelisted addresses only');
  });

  it('reverts in rebase if vol token address is zero address', async () => {
    const rebaser = await Rebaser.new(
      ZERO_ADDRESS,
      [this.fakeUniswapV2PairA.address, this.fakeUniswapV2PairB.address],
      { from: admin }
    );

    await rebaser.setRebaserAddress(bob, true, { from: admin });
    await expectRevert(rebaser.rebase({ from: bob }), 'Set volatility token');
  });

  it('reverts in rebase if vol token does not set rebaser contract as rebaser', async () => {
    await moveTimeToTimeWindow();

    await this.fakeVolToken.setRebaser(bob, { from: admin });
    expect(await this.fakeVolToken.rebaser()).to.equal(bob);

    await this.rebaser.setRebaserAddress(bob, true, { from: admin });
    await expectRevert(this.rebaser.rebase({ from: bob }), 'Not allowed');
  });

  it('validates setVolatilityToken', async () => {
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });

    const newFakeVolToken = await FakeVolatilityToken.new({ from: admin });
    await newFakeVolToken.initialize('CVI-USDC', 'CVI-USDC', { from: admin });
    await newFakeVolToken.setRebaser(this.rebaser.address, { from: admin });

    expect(await newFakeVolToken.rebased()).to.be.false;

    const prevFakeVolToken = await this.rebaser.volatilityToken();
    await this.rebaser.setVolatilityToken(newFakeVolToken.address, { from: admin });
    expect(prevFakeVolToken).not.equal(await this.rebaser.volatilityToken());

    await this.rebaser.rebase({ from: bob });
    expect(await newFakeVolToken.rebased()).to.be.true;
  });

  it('validates setUniswapPairs', async () => {
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });

    let newFakeUniswapV2PairA = await FakeUniswapV2Pair.new({ from: admin });
    let newFakeUniswapV2PairB = await FakeUniswapV2Pair.new({ from: admin });

    expect(await newFakeUniswapV2PairA.synced()).to.be.false;
    expect(await newFakeUniswapV2PairB.synced()).to.be.false;

    await this.rebaser.setUniswapPairs([], { from: admin });
    await this.rebaser.rebase({ from: bob });
    expect(await newFakeUniswapV2PairA.synced()).to.be.false;
    expect(await newFakeUniswapV2PairB.synced()).to.be.false;

    newFakeUniswapV2PairA = await FakeUniswapV2Pair.new({ from: admin });
    newFakeUniswapV2PairB = await FakeUniswapV2Pair.new({ from: admin });

    await this.rebaser.setUniswapPairs([newFakeUniswapV2PairA.address], { from: admin });
    await this.rebaser.rebase({ from: bob });
    expect(await newFakeUniswapV2PairA.synced()).to.be.true;
    expect(await newFakeUniswapV2PairB.synced()).to.be.false;

    newFakeUniswapV2PairA = await FakeUniswapV2Pair.new({ from: admin });
    newFakeUniswapV2PairB = await FakeUniswapV2Pair.new({ from: admin });

    await this.rebaser.setUniswapPairs([newFakeUniswapV2PairA.address, newFakeUniswapV2PairB.address], { from: admin });
    await this.rebaser.rebase({ from: bob });

    expect(await newFakeUniswapV2PairA.synced()).to.be.true;
    expect(await newFakeUniswapV2PairB.synced()).to.be.true;
  });

  it('validates setRebaserAddress', async () => {
    expect(await this.fakeVolToken.rebased()).to.be.false;
    expect(await this.fakeUniswapV2PairA.synced()).to.be.false;
    expect(await this.fakeUniswapV2PairB.synced()).to.be.false;

    await this.rebaser.setRebaserAddress(bob, false, { from: admin });
    expect(await this.rebaser.rebasers(bob)).to.be.false;
    await expectRevert(this.rebaser.rebase({ from: bob }), 'Whitelisted addresses only');
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });
    expect(await this.rebaser.rebasers(bob)).to.be.true;
    await this.rebaser.rebase({ from: bob });

    expect(await this.fakeVolToken.rebased()).to.be.true;
    expect(await this.fakeUniswapV2PairA.synced()).to.be.true;
    expect(await this.fakeUniswapV2PairB.synced()).to.be.true;

    expect(await this.rebaser.rebasers(alice)).to.be.false;
    await this.rebaser.setRebaserAddress(alice, true, { from: admin });
    expect(await this.rebaser.rebasers(alice)).to.be.true;
    await this.rebaser.rebase({ from: alice });
  });

  it('validates setUpkeepInterval', async () => {
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });
    await moveTimeToTimeWindow();
    const checkUpkeepResult = await this.rebaser.checkUpkeep(MOCK_BYTES32, { from: bob });
    expect(checkUpkeepResult.upkeepNeeded).to.be.true;

    const prevUpkeepInterval = await this.rebaser.upkeepInterval();
    await this.rebaser.setUpkeepInterval(86400 * 10, { from: admin });
    const newUpkeepInterval = await this.rebaser.upkeepInterval();
    expect(newUpkeepInterval).not.equal(prevUpkeepInterval);

    const checkUpkeepResultAgain = await this.rebaser.checkUpkeep(MOCK_BYTES32, { from: bob });
    expect(checkUpkeepResultAgain.upkeepNeeded).to.be.false;
  });

  it('validates setUpkeepTimeWindow', async () => {
    const prevUpkeepTimeWindow = await this.rebaser.upkeepTimeWindow();
    await this.rebaser.setUpkeepTimeWindow(0, { from: admin });
    const newUpkeepTimeWindow = await this.rebaser.upkeepTimeWindow();
    expect(newUpkeepTimeWindow).not.equal(prevUpkeepTimeWindow);

    await this.rebaser.setRebaserAddress(bob, true, { from: admin });
    await moveTimeToTimeWindow();
    await time.increase(1);
    await expectRevert(this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob }), 'Bad time window');
  });

  it('validates setEnableWhitelist', async () => {
    const prevEnableWhitelist = await this.rebaser.enableWhitelist();
    await this.rebaser.setEnableWhitelist(false, { from: admin });
    const newEnableWhitelist = await this.rebaser.enableWhitelist();
    expect(newEnableWhitelist).not.equal(prevEnableWhitelist);
    await this.rebaser.setEnableWhitelist(true, { from: admin });

    await this.rebaser.setRebaserAddress(bob, false, { from: admin });
    await moveTimeToTimeWindow();
    await expectRevert(this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob }), 'Whitelisted addresses only');

    await this.rebaser.setRebaserAddress(bob, true, { from: admin });
    await this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob });
  });

  it('performs rebase if condition is met', async () => {
    await moveTimeToTimeWindow();

    await this.rebaser.setRebaserAddress(bob, true, { from: admin });

    expect(await this.fakeVolToken.rebased()).to.be.false;
    expect(await this.fakeUniswapV2PairA.synced()).to.be.false;
    expect(await this.fakeUniswapV2PairB.synced()).to.be.false;
    await this.rebaser.rebase({ from: bob });
    expect(await this.fakeVolToken.rebased()).to.be.true;
    expect(await this.fakeUniswapV2PairA.synced()).to.be.true;
    expect(await this.fakeUniswapV2PairB.synced()).to.be.true;
  });

  it('returns upkeepNeeded in checkUpkeep as false if condition is not met', async () => {
    await moveTimeToTimeWindow();
    const upkeepTimeWindow = await this.rebaser.upkeepTimeWindow();
    await time.increase(upkeepTimeWindow.add(upkeepTimeWindow));
    const checkUpkeepResult = await this.rebaser.checkUpkeep(MOCK_BYTES32, { from: bob });
    expect(checkUpkeepResult.upkeepNeeded).to.be.false;
  });

  it('reverts in performUpkeep if rebaser address is not whitelisted', async () => {
    await this.rebaser.setRebaserAddress(bob, false, { from: admin });
    await expectRevert(this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob }), 'Whitelisted addresses only');
  });

  it('reverts in performUpkeep if running before next time window', async () => {
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });
    const upkeepTimeWindow = await this.rebaser.upkeepTimeWindow();
    await moveTimeToTimeWindow();
    await time.increase(upkeepTimeWindow.add(upkeepTimeWindow));
    await expectRevert(this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob }), 'Bad time window');
  });

  it('reverts in performUpkeep if running after next time window', async () => {
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });

    const nextDay = toBN(Math.floor(Date.now() / 1000) + SECONDS_IN_DAY);
    const lastUpkeepTime = await this.rebaser.lastUpkeepTime();
    const upkeepTimeWindow = await this.rebaser.upkeepTimeWindow();
    const nextUpkeepTime = lastUpkeepTime.add(toBN(SECONDS_IN_DAY));
    const onNextInterval = nextDay.gte(nextUpkeepTime) && nextDay.lte(nextUpkeepTime.add(upkeepTimeWindow));

    await time.increase(SECONDS_IN_DAY);

    if (onNextInterval) {
      await time.increase(upkeepTimeWindow.mul(2));
    }

    await expectRevert(this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob }), 'Bad time window');
  });

  it('performs performUpkeep if conditions are met', async () => {
    await moveTimeToTimeWindow();

    await this.rebaser.setRebaserAddress(bob, true, { from: admin });

    expect(await this.fakeVolToken.rebased()).to.be.false;
    expect(await this.fakeUniswapV2PairA.synced()).to.be.false;
    expect(await this.fakeUniswapV2PairB.synced()).to.be.false;
    await this.rebaser.performUpkeep(MOCK_BYTES32, { from: bob });
    expect(await this.fakeVolToken.rebased()).to.be.true;
    expect(await this.fakeUniswapV2PairA.synced()).to.be.true;
    expect(await this.fakeUniswapV2PairB.synced()).to.be.true;
  });

  it('returns upkeepNeeded in checkUpkeep as true even if lastUpkeepTime was not updated in a couple of days', async () => {
    await moveTimeToTimeWindow();
    await this.rebaser.setRebaserAddress(bob, true, { from: admin });

    const lastUpkeepTime = await this.rebaser.lastUpkeepTime();
    const upkeepInterval = await this.rebaser.upkeepInterval();

    await time.increaseTo(lastUpkeepTime.add(upkeepInterval).add(upkeepInterval).add(upkeepInterval));

    const checkUpkeepResult = await this.rebaser.checkUpkeep(MOCK_BYTES32, { from: bob });
    expect(checkUpkeepResult.upkeepNeeded).to.be.true;
  });
});
