const { time, BN, expectRevert, expectEvent } = require('@openzeppelin/test-helpers');
const { getAccounts } = require('./utils/DeployUtils.js');

const chai = require('chai');

const FakeERC20 = artifacts.require('FakeERC20');
const FakeExchange = artifacts.require('FakeExchange');
const PlatformMigrator = artifacts.require('PlatformMigrator');

const { toTokenAmount } = require('./utils/BNUtils.js');
const { toCVI } = require('./utils/BNUtils.js');
const { deployFullPlatform, getContracts, setContracts, ZERO_ADDRESS } = require('./utils/DeployUtils.js');
const {
  createState,
  updateSnapshots,
  depositAndValidate,
  calculateWithdrawAmounts,
  calculateTokensByBurntLPTokensAmount,
  calculateDepositAmounts,
  openPositionAndValidate,
} = require('./utils/PlatformUtils.js');

const expect = chai.expect;

const ZERO = new BN(0);
const USDT_TO_USDC_RATE = new BN(9000);
const MAX_RATE = new BN(10000);

const SECONDS_PER_DAY = 24 * 60 * 60;

const MIN_AMOUNT_OF_TOKENS_TO_GET_OUT = (1000000000000000000000 * 0.85).toString(); // 85% of amounts in

const OLD_LP_TOKENS_AMOUNT = toTokenAmount(1000);
const NEW_LP_TOKENS_AMOUNT = toTokenAmount(2500);

let admin, bob, alice, carol;
let accountsUsed;

const setAccounts = async () => {
  [admin, bob, alice, carol] = await getAccounts();
  accountsUsed = [admin, bob, alice, carol];
};

const beforeEachMigrator = async isETH => {
  this.isETH = isETH;

  this.token = await FakeERC20.new('USDT', 'USDT', toTokenAmount(10000000), 6, { from: admin });
  this.newToken = await FakeERC20.new('USDC', 'USDC', toTokenAmount(10000000), 6, { from: admin });
  this.rewardToken = await FakeERC20.new('GOVI', 'GOVI', toTokenAmount(100000000), 18, { from: admin });

  await deployFullPlatform(isETH, this.token);

  await setAccounts();
  this.oldPlatformState = createState(accountsUsed);

  this.oldContracts = getContracts();
  await getContracts().fakePriceProvider.setPrice(toCVI(10000));

  await deployFullPlatform(isETH, this.token);
  this.newSameTokenPlatformState = createState(accountsUsed);

  this.newSameTokenContracts = getContracts();
  await getContracts().fakePriceProvider.setPrice(toCVI(10000));

  await deployFullPlatform(isETH, this.newToken);
  this.newPlatformState = createState(accountsUsed);

  this.newContracts = getContracts();
  await getContracts().fakePriceProvider.setPrice(toCVI(10000));

  this.fakeExchange = await FakeExchange.new(ZERO_ADDRESS, USDT_TO_USDC_RATE, { from: admin });
  this.newToken.transfer(this.fakeExchange.address, toTokenAmount(1000000), { from: admin });
  this.migrator = await PlatformMigrator.new(
    this.rewardToken.address,
    this.token.address,
    this.oldContracts.platform.address,
    this.newContracts.platform.address,
    this.fakeExchange.address,
    { from: admin }
  );
};

const testMigration = async (newContracts, convert = false) => {
  setContracts(this.oldContracts);
  await depositAndValidate(this.oldPlatformState, OLD_LP_TOKENS_AMOUNT, bob);

  // Deposit different amount in new platform, and have a losing position there, to change balance

  setContracts(newContracts);
  await depositAndValidate(this.newPlatformState, NEW_LP_TOKENS_AMOUNT, alice);

  await openPositionAndValidate(this.newPlatformState, toTokenAmount(1000), carol);
  await newContracts.fakePriceProvider.setPrice(toCVI(5000));

  setContracts(this.oldContracts);

  const bobBeforeOldLPTokensAmount = await this.oldContracts.platform.balanceOf(bob);

  await time.increase(3 * SECONDS_PER_DAY);

  await newContracts.fakePriceProvider.setPrice(toCVI(5000));

  setContracts(newContracts);
  await this.oldContracts.platform.approve(this.migrator.address, bobBeforeOldLPTokensAmount, { from: bob });

  await this.rewardToken.transfer(this.migrator.address, toTokenAmount(1000000), { from: admin });

  const userRewardsBalanceBeforeMigration = await this.rewardToken.balanceOf(bob);
  expect(userRewardsBalanceBeforeMigration.toString()).to.equal(ZERO.toString());

  await this.migrator.migrateLPTokens(MIN_AMOUNT_OF_TOKENS_TO_GET_OUT, { from: bob });
  await updateSnapshots(this.newPlatformState);

  const withdrawTokens = await calculateTokensByBurntLPTokensAmount(this.oldPlatformState, bobBeforeOldLPTokensAmount);
  const { withdrawTokenMinusFees } = await calculateWithdrawAmounts(this.oldPlatformState, withdrawTokens);

  setContracts(newContracts);

  const conversionRate = convert ? USDT_TO_USDC_RATE : MAX_RATE;
  const { lpTokens } = await calculateDepositAmounts(
    this.newPlatformState,
    withdrawTokenMinusFees.mul(conversionRate).div(MAX_RATE)
  );

  const bobAfterOldLPTokensAmount = await this.oldContracts.platform.balanceOf(bob);
  expect(bobAfterOldLPTokensAmount).to.be.bignumber.equal(new BN(0));

  const bobNewLPTokensNum = await newContracts.platform.balanceOf(bob);

  expect(bobNewLPTokensNum).to.be.bignumber.equal(lpTokens);

  const bobTokens = await this.oldContracts.token.balanceOf(bob);
  expect(bobTokens).to.be.bignumber.equal(new BN(0));

  const userRewardsAfterMigration = await this.rewardToken.balanceOf(bob);
  expect(userRewardsAfterMigration.toString()).to.equal((await this.migrator.rewardAmount()).toString());
};

const setMigratorTests = () => {
  it('reverts when no LP tokens of old platform', async () => {
    await expectRevert(
      this.migrator.migrateLPTokens(MIN_AMOUNT_OF_TOKENS_TO_GET_OUT, { from: bob }),
      'No LP tokens to migrate'
    );
  });

  it('reverts when funds are locked in old platform', async () => {
    setContracts(this.oldContracts);
    await depositAndValidate(this.oldPlatformState, OLD_LP_TOKENS_AMOUNT, bob);

    const bobLPTokensNum = await this.oldContracts.platform.balanceOf(bob);

    await this.oldContracts.platform.approve(this.migrator.address, bobLPTokensNum, { from: bob });
    await expectRevert(
      this.migrator.migrateLPTokens(MIN_AMOUNT_OF_TOKENS_TO_GET_OUT, { from: bob }),
      'Funds are locked'
    );

    await this.rewardToken.transfer(this.migrator.address, toTokenAmount(1000000), { from: admin });

    await time.increase(3 * SECONDS_PER_DAY - 30);

    await expectRevert(
      this.migrator.migrateLPTokens(MIN_AMOUNT_OF_TOKENS_TO_GET_OUT, { from: bob }),
      'Funds are locked'
    );

    await this.newContracts.fakePriceProvider.setPrice(toCVI(5000));
    await this.oldContracts.fakePriceProvider.setPrice(toCVI(5000));

    await depositAndValidate(this.oldPlatformState, OLD_LP_TOKENS_AMOUNT, bob);

    const bobLPTokensNumAfter = await this.oldContracts.platform.balanceOf(bob);

    await this.oldContracts.platform.approve(this.migrator.address, bobLPTokensNumAfter, { from: bob });

    await time.increase(3 * 24 * 60 * 60 - 2 ); // Latest cvi too long ago

    await this.newContracts.fakePriceProvider.setPrice(toCVI(5000));
    await this.oldContracts.fakePriceProvider.setPrice(toCVI(5000));

    await this.migrator.migrateLPTokens(MIN_AMOUNT_OF_TOKENS_TO_GET_OUT, { from: bob });
  });

  it('migrates LP tokens properly between same token platforms (no uniswap conversion)', async () => {
    this.migrator = await PlatformMigrator.new(
      this.rewardToken.address,
      this.token.address,
      this.oldContracts.platform.address,
      this.newSameTokenContracts.platform.address,
      this.fakeExchange.address,
      { from: admin }
    );
    await testMigration(this.newSameTokenContracts);
  });

  it('migrates LP tokens properly between same token platforms (with uniswap conversion)', async () => {
    this.migrator = await PlatformMigrator.new(
      this.rewardToken.address,
      this.token.address,
      this.oldContracts.platform.address,
      this.newContracts.platform.address,
      this.fakeExchange.address,
      { from: admin }
    );
    await testMigration(this.newContracts, true);
  });

  it('validate Migration event', async () => {
    const newContracts = this.newContracts;

    setContracts(this.oldContracts);
    await depositAndValidate(this.oldPlatformState, OLD_LP_TOKENS_AMOUNT, bob);
    
    setContracts(newContracts);
    await depositAndValidate(this.newPlatformState, NEW_LP_TOKENS_AMOUNT, alice);
  
    await openPositionAndValidate(this.newPlatformState, toTokenAmount(1000), carol);
    await newContracts.fakePriceProvider.setPrice(toCVI(5000));
  
    const bobBeforeOldLPTokensAmount = await this.oldContracts.platform.balanceOf(bob);
  
    await time.increase(3 * SECONDS_PER_DAY);
  
    await newContracts.fakePriceProvider.setPrice(toCVI(5000));
  
    setContracts(newContracts);
    await this.oldContracts.platform.approve(this.migrator.address, bobBeforeOldLPTokensAmount, { from: bob });
  
    await this.rewardToken.transfer(this.migrator.address, toTokenAmount(1000000), { from: admin });
  
    const tx = await this.migrator.migrateLPTokens(MIN_AMOUNT_OF_TOKENS_TO_GET_OUT, { from: bob });

    // Get rest of Migration events params for validation
    const {latestTimestamp: timetsamp} = await updateSnapshots(this.newPlatformState);

    const withdrawTokens = await calculateTokensByBurntLPTokensAmount(this.oldPlatformState, bobBeforeOldLPTokensAmount);
    const convertedTokens = withdrawTokens.mul(new BN(90)).div(new BN(100));
    
    const { lpTokens: newPlatformLPTokens } = await calculateDepositAmounts(this.newPlatformState, convertedTokens);

    const rewardAmount = await this.migrator.rewardAmount();

    await expectEvent(tx, 'Migration', {
      account: bob,
      oldPlatfrom: this.oldContracts.platform.address,
      newPlatform: this.newContracts.platform.address,
      oldLPTokensAmount: bobBeforeOldLPTokensAmount ,
      newLPTokensAmount: newPlatformLPTokens,
      oldTokensAmount: withdrawTokens,
      newTokensAmount: convertedTokens,
      rewardAmount,
    });
  });

  it('sets old platform properly', async () => {
    this.migrator = await PlatformMigrator.new(
      this.rewardToken.address,
      this.token.address,
      this.newSameTokenContracts.platform.address,
      this.newSameTokenContracts.platform.address,
      this.fakeExchange.address,
      { from: admin }
    );
    expect(await this.migrator.oldPlatform()).to.equal(this.newSameTokenContracts.platform.address);

    await this.migrator.setOldPlatform(this.oldContracts.platform.address, { from: admin });
    expect(await this.migrator.oldPlatform()).to.equal(this.oldContracts.platform.address);

    await testMigration(this.newSameTokenContracts);
  });

  it('sets new platform properly', async () => {
    this.migrator = await PlatformMigrator.new(
      this.rewardToken.address,
      this.token.address,
      this.oldContracts.platform.address,
      this.oldContracts.platform.address,
      this.fakeExchange.address,
      { from: admin }
    );

    expect(await this.migrator.newPlatform()).to.equal(this.oldContracts.platform.address);

    await this.migrator.setNewPlatform(this.newSameTokenContracts.platform.address, { from: admin });
    expect(await this.migrator.newPlatform()).to.equal(this.newSameTokenContracts.platform.address);

    await testMigration(this.newSameTokenContracts);
  });

  it('sets uniswap pair properly', async () => {
    const badFakeExchange = await FakeExchange.new(ZERO_ADDRESS, USDT_TO_USDC_RATE.mul(new BN(2)), { from: admin });
    this.migrator = await PlatformMigrator.new(
      this.rewardToken.address,
      this.token.address,
      this.oldContracts.platform.address,
      this.newContracts.platform.address,
      badFakeExchange.address,
      { from: admin }
    );
    expect(await this.migrator.router()).to.equal(badFakeExchange.address);

    await this.migrator.setRouter(this.fakeExchange.address, { from: admin });
    expect(await this.migrator.router()).to.equal(this.fakeExchange.address);

    await testMigration(this.newContracts, true);
  });

  it('reverts when attempting to execute an ownable function by non admin user', async () => {
    await expectRevert(
      this.migrator.setOldPlatform(this.oldContracts.platform.address, { from: bob }),
      'Ownable: caller is not the owner'
    );
    await expectRevert(
      this.migrator.setNewPlatform(this.newContracts.platform.address, { from: bob }),
      'Ownable: caller is not the owner'
    );
    await expectRevert(
      this.migrator.setRouter(this.fakeExchange.address, { from: bob }),
      'Ownable: caller is not the owner'
    );
  });

  it('withdraws rewards', async () => {
    const ownerRewardsBeforeWithdrawingAll = await this.rewardToken.balanceOf(admin);
    const balanceOfRewards = await this.rewardToken.balanceOf(this.migrator.address);
    await this.migrator.withdrawAllRewards({ from: admin });
    const ownerRewardsAfterWithdrawingAll = await this.rewardToken.balanceOf(admin);
    expect(ownerRewardsAfterWithdrawingAll.toString()).to.equal(ownerRewardsBeforeWithdrawingAll.add(balanceOfRewards).toString());
  });

  it('sets reward amount properly', async () => {
    const newAmount = 50000;
    const prevRewardAmount = await this.migrator.rewardAmount();
    await this.migrator.setRewardAmount(newAmount, { from: admin });
    const newRewardAmount = await this.migrator.rewardAmount();
    expect(newRewardAmount.toString()).to.equal(newAmount.toString());
    expect(newRewardAmount).to.not.equal(prevRewardAmount);

    const userRewardsBalanceBeforeMigration = await this.rewardToken.balanceOf(bob);
    await testMigration(this.newContracts, true);
    const userRewardsAfterMigration = await this.rewardToken.balanceOf(bob);
    expect(userRewardsAfterMigration.toString()).to.equal((await this.migrator.rewardAmount()).toString());
  });

  it('sets slippage percent properly', async () => {
    const prevSlippagePercent = await this.fakeExchange.slippagePercent();
    const maxPercentage = await this.fakeExchange.MAX_PERCENTAGE();

    expect(prevSlippagePercent.div(maxPercentage)).to.be.bignumber.equal(new BN(1));
    await this.fakeExchange.setSlippagePercent(9000, { from: admin });

    const newSlippagePercent = await this.fakeExchange.slippagePercent();
    expect(prevSlippagePercent).to.be.bignumber.not.equal(newSlippagePercent);

    await expectRevert(
      testMigration(this.newContracts, true),
      'Fake Uniswap: output below min'
    );
  });

  it('reverts when min amount out is bigger then amount out with slippage', async () => {
    await this.fakeExchange.setSlippagePercent(9000, { from: admin });
    await expectRevert(
      testMigration(this.newContracts, true),
      'Fake Uniswap: output below min'
    );
  });

  it('migrates LP tokens when min amount out is equal to amount out with slippage', async () => {
    setContracts(this.oldContracts);
    await depositAndValidate(this.oldPlatformState, OLD_LP_TOKENS_AMOUNT, bob);
    
    setContracts(this.newContracts);
    await depositAndValidate(this.newPlatformState, NEW_LP_TOKENS_AMOUNT, alice);

    await openPositionAndValidate(this.newPlatformState, toTokenAmount(1000), carol);
    await this.newContracts.fakePriceProvider.setPrice(toCVI(5000));

    setContracts(this.oldContracts);

    const bobBeforeOldLPTokensAmount = await this.oldContracts.platform.balanceOf(bob);

    await time.increase(3 * SECONDS_PER_DAY);

    await this.newContracts.fakePriceProvider.setPrice(toCVI(5000));

    setContracts(this.newContracts);
    await this.oldContracts.platform.approve(this.migrator.address, bobBeforeOldLPTokensAmount, { from: bob });

    await this.fakeExchange.setSlippagePercent(9000, { from: admin }); // slippage is 90%, exchange rate is 90%, we'll be getting 81% of amount back
    const minAmountOut = (1000000000000000000000 * 0.81).toString(); // 81% of amount

    await this.rewardToken.transfer(this.migrator.address, toTokenAmount(1000000), { from: admin });
    await this.migrator.migrateLPTokens(minAmountOut, { from: bob });
  });
};

describe('PlatformMigrator', () => {
  beforeEach(async () => {
    await beforeEachMigrator(false);
  });

  setMigratorTests(false);
});
