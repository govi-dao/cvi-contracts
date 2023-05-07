/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, expectEvent, time, BN, balance, send, ether } = require('@openzeppelin/test-helpers')
const chai = require('chai')

const { toTokenAmount, toBN } = require('./utils/BNUtils.js')
const { getAccounts, deployPlatformHelper } = require('./utils/DeployUtils.js')

const Staking = artifacts.require('Staking')
const StakingVault = artifacts.require('StakingVault')
const FakeERC20 = artifacts.require('FakeERC20')
const FakeWETH = artifacts.require('FakeWETH')

const expect = chai.expect

const MAX_PERCENTAGE = toBN(10000)

const TO_WETH_RATE = toBN(1, 4)
const PRECISION_DECIMALS = toBN(1, 18)
const CONVERSION_PRECISION_DECIMALS = toBN(1, 4)

const SECONDS_PER_HOUR = toBN(60 * 60)
const SECONDS_PER_DAY = toBN(60 * 60 * 24)

const REWARDS_DURATION = toBN(60 * 60 * 24 * 7)
const REWARDS_PER_DURATION = toBN(28000, 18)

const INITIAL_REWARDS_RATE = REWARDS_PER_DURATION.div(REWARDS_DURATION)
let REWARDS_RATE = INITIAL_REWARDS_RATE

const GAS_PRICE = toBN(1, 10)

let admin, bob, alice, carol

const setAccounts = async () => {
  ;[admin, bob, alice, carol] = await getAccounts()
}

const sendProfitAndValidate = async (token, account, amount, recipient, isProfit) => {
  const beforeProfit = await this.staking.totalProfits(token.address)
  const stakes = await this.staking.totalSupply()

  const beforeSenderBalance = await token.balanceOf(account)
  const beforeRecipientBalane = await token.balanceOf(recipient)
  await token.approve(this.staking.address, amount, { from: account })
  const tx = await this.staking.sendProfit(amount, token.address, { from: account })
  const afterSenderBalance = await token.balanceOf(account)
  const afterRecipientBalance = await token.balanceOf(recipient)

  expect(afterRecipientBalance.sub(beforeRecipientBalane)).to.be.bignumber.equal(amount)
  expect(beforeSenderBalance.sub(afterSenderBalance)).to.be.bignumber.equal(amount)

  const afterProfit = await this.staking.totalProfits(token.address)

  let profitAdded = new BN(0)

  if (isProfit) {
    profitAdded = amount.mul(PRECISION_DECIMALS).div(stakes)
    await expectEvent(tx, 'ProfitAdded', { token: token.address, profit: amount })
  }

  expect(afterProfit.sub(beforeProfit)).to.be.bignumber.equal(profitAdded)

  return profitAdded
}

const stakeAndValidate = async (account, amount) => {
  const sharesBefore = await this.staking.balanceOf(account)
  const totalStakesBefore = await this.staking.totalSupply()

  expect(await this.goviToken.balanceOf(this.staking.address)).to.be.bignumber.equal(this.state.goviBalance)

  const cviBefore = await this.goviToken.balanceOf(account)

  await this.goviToken.approve(this.staking.address, amount, { from: account })
  const tx = await this.staking.stake(amount, { from: account })
  const stakeTimestamp = await time.latest()

  let share = amount
  if (totalStakesBefore.gt(toBN(0))) {
    const timeFromLastUpdate = stakeTimestamp.sub(this.state.lastUpdateTime)
    this.state.goviBalance = this.state.goviBalance.add(timeFromLastUpdate.mul(REWARDS_RATE))

    share = amount.mul(totalStakesBefore).div(this.state.goviBalance)
  }

  this.state.goviBalance = this.state.goviBalance.add(amount)
  this.state.lastUpdateTime = stakeTimestamp

  const sharesAfter = await this.staking.balanceOf(account)
  const totalStakesAfter = await this.staking.totalSupply()

  expect(await this.goviToken.balanceOf(this.staking.address)).to.be.bignumber.equal(this.state.goviBalance)

  const cviAfter = await this.goviToken.balanceOf(account)
  expect(await this.staking.stakeTimestamps(account)).to.be.bignumber.equal(stakeTimestamp)

  expect(cviBefore.sub(cviAfter)).to.be.bignumber.equal(amount)
  expect(sharesAfter.sub(sharesBefore)).to.be.bignumber.equal(share)
  expect(totalStakesAfter.sub(totalStakesBefore)).to.be.bignumber.equal(share)

  await expectEvent(tx, 'Staked', {
    account,
    goviAmount: amount,
    xGOVIMinted: share,
    xGOVIBalance: await this.staking.balanceOf(account),
  })

  await validatePlatformHelperFunctions(account)

  return stakeTimestamp
}

const validatePlatformHelperFunctions = async account => {
  const apr = await this.platformHelper.calculateStakingAPR()

  const expectedAPR = this.state.goviBalance.eq(toBN(0))
    ? toBN(0)
    : REWARDS_RATE.mul(SECONDS_PER_DAY.mul(toBN(365)))
        .mul(MAX_PERCENTAGE)
        .div(this.state.goviBalance)
  expect(await this.platformHelper.calculateStakingAPR()).to.be.bignumber.equal(expectedAPR)

  const result = await this.platformHelper.stakedGOVI(account)
  const timestamp = await time.latest()

  const xGOVIBalance = await this.staking.balanceOf(account)
  const xGOVITotalSupply = await this.staking.totalSupply()

  const addedReward = REWARDS_RATE.mul(timestamp.sub(this.state.lastUpdateTime))
  const expectedStakedAmount = xGOVITotalSupply.eq(toBN(0))
    ? toBN(0)
    : this.state.goviBalance.add(addedReward).mul(xGOVIBalance).div(xGOVITotalSupply)
  const expectedShare = xGOVITotalSupply.eq(toBN(0)) ? toBN(0) : xGOVIBalance.mul(MAX_PERCENTAGE).div(xGOVITotalSupply)

  //TODO: Calculate share like expectedStaked / (added + total) and make sure it's close enough to share

  expect(result.stakedAmount).to.be.bignumber.equal(expectedStakedAmount)
  expect(result.share).to.be.bignumber.equal(expectedShare)
}

const unstakeAndValidate = async (account, shares) => {
  const sharesBefore = await this.staking.balanceOf(account)
  const totalStakesBefore = await this.staking.totalSupply()

  expect(await this.goviToken.balanceOf(this.staking.address)).to.be.bignumber.equal(this.state.goviBalance)

  const cviBefore = await this.goviToken.balanceOf(account)

  const tx = await this.staking.unstake(new BN(shares), { from: account })
  const unstakeTimestamp = await time.latest()

  const timeFromLastUpdate = unstakeTimestamp.sub(this.state.lastUpdateTime)
  this.state.goviBalance = this.state.goviBalance.add(timeFromLastUpdate.mul(REWARDS_RATE))
  this.state.lastUpdateTime = unstakeTimestamp

  const goviAmount = shares.mul(this.state.goviBalance).div(totalStakesBefore)
  this.state.goviBalance = this.state.goviBalance.sub(goviAmount)

  const sharesAfter = await this.staking.balanceOf(account)
  const totalStakesAfter = await this.staking.totalSupply()

  expect(await this.goviToken.balanceOf(this.staking.address)).to.be.bignumber.equal(this.state.goviBalance)

  const cviAfter = await this.goviToken.balanceOf(account)

  expect(cviAfter.sub(cviBefore)).to.be.bignumber.equal(goviAmount)
  expect(sharesBefore.sub(sharesAfter)).to.be.bignumber.equal(shares)
  expect(totalStakesBefore.sub(totalStakesAfter)).to.be.bignumber.equal(shares)

  await expectEvent(tx, 'Unstaked', {
    account,
    xGOVIBurned: shares,
    goviReward: goviAmount,
    xGOVIBalance: await this.staking.balanceOf(account),
  })

  await validatePlatformHelperFunctions(account)

  return { goviReward: goviAmount, timestamp: unstakeTimestamp }
}

const claimAndValidate = async (account, tokens, expectedProfit) => {
  const tokensBefore = []
  for (let token of tokens) {
    tokensBefore.push(await token.balanceOf(account))
  }

  const ethBefore = await balance.current(account, 'wei')

  let profits = []
  let tx
  let claimCallTimestamp
  let timeProfit

  if (tokens.length === 1) {
    const profit = await this.staking.claimProfit.call(tokens[0].address, { from: account })
    claimCallTimestamp = await time.latest()
    profits.push(profit)
    tx = await this.staking.claimProfit(tokens[0].address, { from: account, gasPrice: GAS_PRICE })
  } else {
    profits = await this.staking.claimAllProfits.call({ from: account })
    claimCallTimestamp = await time.latest()
    tx = await this.staking.claimAllProfits({ from: account, gasPrice: GAS_PRICE })
  }

  const claimTimestamp = await time.latest()

  let index = 0
  for (let token of tokens) {
    if ((await token.name()) === 'WETH') {
      const ethAfter = await balance.current(account, 'wei')
      expect(ethAfter.sub(ethBefore)).to.be.bignumber.equal(
        expectedProfit.sub(new BN(tx.receipt.gasUsed).mul(GAS_PRICE)),
      )
    } else {
      const tokenAfter = await token.balanceOf(account)
      expect(tokenAfter.sub(tokensBefore[index])).to.be.bignumber.equal(expectedProfit)
    }
    index++
  }

  expect(profits.length).to.equal(tokens.length)

  let tokenIndex = 0
  for (let profit of profits) {
    const currToken = tokens[tokenIndex]
    expect(profit).to.be.bignumber.equal(expectedProfit)
    await expectEvent(tx, 'RewardClaimed', { account, token: currToken.address, reward: expectedProfit })
    tokenIndex++
  }

  await validatePlatformHelperFunctions(account)

  return claimTimestamp
}

const createCompoundBalancesState = accounts => {
  const goviBalances = {}
  const totalGOVIBalance = toBN(0)

  for (const account of accounts) {
    goviBalances[account] = toBN(0)
  }

  return { balances: goviBalances, total: totalGOVIBalance }
}

const addGOVIByTime = async (state, startTimestamp, endTimestamp) => {
  const newGOVIByTime = endTimestamp.sub(startTimestamp).mul(REWARDS_RATE)

  for (let account of Object.keys(state.balances)) {
    state.balances[account] = state.balances[account].add(newGOVIByTime.mul(state.balances[account]).div(state.total))
  }
  state.total = state.total.add(newGOVIByTime)

  this.state.goviBalance = this.state.goviBalance.add(newGOVIByTime)
  this.state.lastUpdateTime = endTimestamp
}

const stakeAndUpdateCompoundState = async (state, staker, stakeAmount, lastTimestamp) => {
  const stakeTimestamp = await stakeAndValidate(staker, stakeAmount)
  const newGOVIByTime = lastTimestamp === undefined ? toBN(0) : stakeTimestamp.sub(lastTimestamp).mul(REWARDS_RATE)

  if (!state.total.eq(toBN(0))) {
    for (let account of Object.keys(state.balances)) {
      state.balances[account] = state.balances[account].add(newGOVIByTime.mul(state.balances[account]).div(state.total))
    }
  }

  state.balances[staker] = state.balances[staker].add(stakeAmount)
  state.total = state.total.add(newGOVIByTime).add(stakeAmount)

  return stakeTimestamp
}

const updateStateOnUnstakeAndValidate = async (state, unstaker, unstakeShareDivider, lastTimestamp) => {
  const sharesToUnstake = (await this.staking.balanceOf(unstaker)).div(unstakeShareDivider)
  const { timestamp: unstakeTimestamp, goviReward } = await unstakeAndValidate(unstaker, sharesToUnstake)

  const newGOVIByTime = unstakeTimestamp.sub(lastTimestamp).mul(REWARDS_RATE)

  for (let account of Object.keys(state.balances)) {
    state.balances[account] = state.balances[account].add(newGOVIByTime.mul(state.balances[account]).div(state.total))
  }

  const usntakerGOVIReward = state.balances[unstaker].div(unstakeShareDivider)

  // Allow for some offset due to rounding issues doing a different calculation
  expect(goviReward).to.be.bignumber.above(usntakerGOVIReward.sub(toBN(10)))
  expect(goviReward).to.be.bignumber.below(usntakerGOVIReward.add(toBN(10)))

  state.balances[unstaker] = state.balances[unstaker].sub(usntakerGOVIReward)
  state.total = state.total.add(newGOVIByTime).sub(usntakerGOVIReward)

  return unstakeTimestamp
}

const calculateProfit = (stakeTimeProfitsPerAmount, unstakeTimeProfitsPerAmount, amount) => {
  return unstakeTimeProfitsPerAmount.sub(stakeTimeProfitsPerAmount).mul(amount).div(PRECISION_DECIMALS)
}

const testAddAndRemoveTokens = async (addToken, removeToken, getTokens) => {
  expect(await getTokens()).to.eql([])

  await addToken(this.wethToken)
  expect(await getTokens()).to.eql([this.wethToken.address])

  await addToken(this.daiToken)
  expect(await getTokens()).to.eql([this.wethToken.address, this.daiToken.address])

  await removeToken(this.wethToken)
  expect(await getTokens()).to.eql([this.daiToken.address])

  await removeToken(this.daiToken)
  expect(await getTokens()).to.eql([])
}

describe('Staking', () => {
  beforeEach(async () => {
    await setAccounts()

    this.goviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(1000000000), 18, { from: admin })
    this.wethToken = await FakeWETH.new('WETH', 'WETH', toTokenAmount(1000000000000000), 18, { from: admin })
    this.cotiToken = await FakeERC20.new('COTI', 'COTI', toTokenAmount(1000000000), 18, { from: admin })
    this.daiToken = await FakeERC20.new('DAI', 'DAI', toTokenAmount(1000000000), 18, { from: admin })
    this.usdtToken = await FakeERC20.new('USDT', 'USDT', toTokenAmount(1000000000), 18, { from: admin })
    this.stakingVault = await StakingVault.new(this.goviToken.address, { from: admin })
    this.staking = await Staking.new({ from: admin })

    await this.staking.initialize(this.goviToken.address, this.stakingVault.address, this.wethToken.address, {
      from: admin,
    })
    await this.stakingVault.setWithdrawer(this.staking.address, { from: admin })
    await this.goviToken.transfer(this.stakingVault.address, toTokenAmount(100000), { from: admin })

    this.state = {}
    this.state.goviBalance = toBN(0)
    this.state.lastUpdateTime = toBN(0)

    this.platformHelper = await deployPlatformHelper(this.goviToken.address, this.staking.address)
  })

  it('exposes correct precision decimals', async () => {
    expect(await this.staking.PRECISION_DECIMALS()).to.be.bignumber.equal(PRECISION_DECIMALS)
  })

  it('reverts when staking zero amount', async () => {
    await expectRevert(this.staking.stake(new BN(0), { from: bob }), 'Amount must be positive')
  })

  it('stakes properly when no claimable tokens', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(alice, toTokenAmount(2000), { from: admin })
    await this.goviToken.transfer(carol, toTokenAmount(3000), { from: admin })

    await stakeAndValidate(bob, toTokenAmount(1000))
    await stakeAndValidate(alice, toTokenAmount(2000))
    await stakeAndValidate(carol, toTokenAmount(3000))
  })

  it('accepts profit for claimable token only', async () => {
    await this.wethToken.approve(this.staking.address, toTokenAmount(10000), { from: admin })
    await this.daiToken.approve(this.staking.address, toTokenAmount(10000), { from: admin })
    await this.goviToken.approve(this.staking.address, toTokenAmount(10000), { from: admin })

    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, { from: admin }),
      'Token not supported',
    )
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, { from: admin }),
      'Token not supported',
    )
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.goviToken.address, { from: admin }),
      'Token not supported',
    )

    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, { from: admin }),
      'Token not supported',
    )
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.goviToken.address, { from: admin }),
      'Token not supported',
    )

    await this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, { from: admin })

    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })

    await this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, { from: admin })
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.goviToken.address, { from: admin }),
      'Token not supported',
    )

    await this.staking.removeClaimableToken(this.daiToken.address, { from: admin })

    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.daiToken.address, { from: admin }),
      'Token not supported',
    )
    await this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, { from: admin })

    await this.staking.removeClaimableToken(this.wethToken.address, { from: admin })
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.wethToken.address, { from: admin }),
      'Token not supported',
    )
  })

  it('reverts when sending govi profit even if govi was added as claimable token', async () => {
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.goviToken.address, { from: admin }),
      'Token not supported',
    )
    await this.staking.addClaimableToken(this.goviToken.address, { from: admin })
    await expectRevert(
      this.staking.sendProfit(toTokenAmount(1000), this.goviToken.address, { from: admin }),
      'Token not supported',
    )
  })

  it('sends profit to fallback recipient if no stakes', async () => {
    await this.wethToken.transfer(bob, toTokenAmount(2000), { from: admin })
    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await sendProfitAndValidate(this.wethToken, bob, toTokenAmount(2000), admin, false)
  })

  it('handles adding profit properly for claimable token', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(1000))

    await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true)
  })

  it('saves last profits for each claimable token on staking (no compounded govi time rewards)', async () => {
    await this.staking.setRewardRate(toBN(0), { from: admin })
    REWARDS_RATE = toBN(0)

    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(alice, toTokenAmount(1000), { from: admin })

    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })
    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })
    await this.staking.addClaimableToken(this.cotiToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(500))

    const daiTotalProfits = await sendProfitAndValidate(
      this.daiToken,
      admin,
      toTokenAmount(1000),
      this.staking.address,
      true,
    )
    const wethTotalProfits = await sendProfitAndValidate(
      this.wethToken,
      admin,
      toTokenAmount(2000),
      this.staking.address,
      true,
    )
    const cotiTotalProfits = await sendProfitAndValidate(
      this.cotiToken,
      admin,
      toTokenAmount(3000),
      this.staking.address,
      true,
    )

    await stakeAndValidate(bob, toTokenAmount(500))
    await stakeAndValidate(alice, toTokenAmount(250))

    const daiTotalProfits2 = daiTotalProfits.add(
      await sendProfitAndValidate(this.daiToken, admin, toTokenAmount(1000), this.staking.address, true),
    )
    const wethTotalProfits2 = wethTotalProfits.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true),
    )
    const cotiTotalProfits2 = cotiTotalProfits.add(
      await sendProfitAndValidate(this.cotiToken, admin, toTokenAmount(3000), this.staking.address, true),
    )

    expect(await this.staking.profitOf(bob, this.daiToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), daiTotalProfits, toTokenAmount(500)).add(
        calculateProfit(daiTotalProfits, daiTotalProfits2, toTokenAmount(1000)),
      ),
    )
    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), wethTotalProfits, toTokenAmount(500)).add(
        calculateProfit(wethTotalProfits, wethTotalProfits2, toTokenAmount(1000)),
      ),
    )
    expect(await this.staking.profitOf(bob, this.cotiToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), cotiTotalProfits, toTokenAmount(500)).add(
        calculateProfit(cotiTotalProfits, cotiTotalProfits2, toTokenAmount(1000)),
      ),
    )

    expect(await this.staking.profitOf(alice, this.daiToken.address)).to.be.bignumber.equal(
      calculateProfit(daiTotalProfits, daiTotalProfits2, toTokenAmount(250)),
    )
    expect(await this.staking.profitOf(alice, this.wethToken.address)).to.be.bignumber.equal(
      calculateProfit(wethTotalProfits, wethTotalProfits2, toTokenAmount(250)),
    )
    expect(await this.staking.profitOf(alice, this.cotiToken.address)).to.be.bignumber.equal(
      calculateProfit(cotiTotalProfits, cotiTotalProfits2, toTokenAmount(250)),
    )

    REWARDS_RATE = INITIAL_REWARDS_RATE
  })

  it.skip('saves last profits for each claimable token on staking (with compounded govi time rewards)', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(alice, toTokenAmount(1000), { from: admin })

    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })
    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })
    await this.staking.addClaimableToken(this.cotiToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(500))

    const daiTotalProfits = await sendProfitAndValidate(
      this.daiToken,
      admin,
      toTokenAmount(1000),
      this.staking.address,
      true,
    )
    const wethTotalProfits = await sendProfitAndValidate(
      this.wethToken,
      admin,
      toTokenAmount(2000),
      this.staking.address,
      true,
    )
    const cotiTotalProfits = await sendProfitAndValidate(
      this.cotiToken,
      admin,
      toTokenAmount(3000),
      this.staking.address,
      true,
    )

    await stakeAndValidate(bob, toTokenAmount(500))
    await stakeAndValidate(alice, toTokenAmount(250))

    const daiTotalProfits2 = daiTotalProfits.add(
      await sendProfitAndValidate(this.daiToken, admin, toTokenAmount(1000), this.staking.address, true),
    )
    const wethTotalProfits2 = wethTotalProfits.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true),
    )
    const cotiTotalProfits2 = cotiTotalProfits.add(
      await sendProfitAndValidate(this.cotiToken, admin, toTokenAmount(3000), this.staking.address, true),
    )

    expect(await this.staking.profitOf(bob, this.daiToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), daiTotalProfits, toTokenAmount(500)).add(
        calculateProfit(daiTotalProfits, daiTotalProfits2, toTokenAmount(1000)),
      ),
    )
    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), wethTotalProfits, toTokenAmount(500)).add(
        calculateProfit(wethTotalProfits, wethTotalProfits2, toTokenAmount(1000)),
      ),
    )
    expect(await this.staking.profitOf(bob, this.cotiToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), cotiTotalProfits, toTokenAmount(500)).add(
        calculateProfit(cotiTotalProfits, cotiTotalProfits2, toTokenAmount(1000)),
      ),
    )

    expect(await this.staking.profitOf(alice, this.daiToken.address)).to.be.bignumber.equal(
      calculateProfit(daiTotalProfits, daiTotalProfits2, toTokenAmount(250)),
    )
    expect(await this.staking.profitOf(alice, this.wethToken.address)).to.be.bignumber.equal(
      calculateProfit(wethTotalProfits, wethTotalProfits2, toTokenAmount(250)),
    )
    expect(await this.staking.profitOf(alice, this.cotiToken.address)).to.be.bignumber.equal(
      calculateProfit(cotiTotalProfits, cotiTotalProfits2, toTokenAmount(250)),
    )
  })

  it('unstakes and restakes new amnount if staking when already staked (no compounded govi time rewards)', async () => {
    await this.staking.setRewardRate(toBN(0), { from: admin })
    REWARDS_RATE = toBN(0)

    await this.goviToken.transfer(bob, toTokenAmount(2000), { from: admin })

    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(250))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(new BN(0))

    await stakeAndValidate(bob, toTokenAmount(750))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(new BN(0))
    await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true)
    const firstTotalProfit = toTokenAmount(2000).mul(PRECISION_DECIMALS).div(toTokenAmount(1000))
    const firstProfit = calculateProfit(new BN(0), firstTotalProfit, toTokenAmount(1000))
    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(firstProfit)

    await stakeAndValidate(bob, toTokenAmount(500))
    await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(3000), this.staking.address, true)
    const secondTotalProfit = firstTotalProfit.add(toTokenAmount(3000).mul(PRECISION_DECIMALS).div(toTokenAmount(1500)))
    const secondProfit = calculateProfit(firstTotalProfit, secondTotalProfit, toTokenAmount(1500))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(
      firstProfit.add(secondProfit),
    )

    REWARDS_RATE = INITIAL_REWARDS_RATE
  })

  it.skip('unstakes and restakes new amnount if staking when already staked (with compounded govi time rewards)', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(2000), { from: admin })

    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(250))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(new BN(0))

    await stakeAndValidate(bob, toTokenAmount(750))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(new BN(0))
    await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true)
    const firstTotalProfit = toTokenAmount(2000).mul(PRECISION_DECIMALS).div(toTokenAmount(1000))
    const firstProfit = calculateProfit(new BN(0), firstTotalProfit, toTokenAmount(1000))
    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(firstProfit)

    await stakeAndValidate(bob, toTokenAmount(500))
    await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(3000), this.staking.address, true)
    const secondTotalProfit = firstTotalProfit.add(toTokenAmount(3000).mul(PRECISION_DECIMALS).div(toTokenAmount(1500)))
    const secondProfit = calculateProfit(firstTotalProfit, secondTotalProfit, toTokenAmount(1500))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(
      firstProfit.add(secondProfit),
    )
  })

  it('reverts when unstaking zero amount', async () => {
    await expectRevert(this.staking.unstake(new BN(0), { from: bob }), 'Amount must be positive')
  })

  it('reverts when unstaking amount more than staked', async () => {
    await expectRevert(this.staking.unstake(new BN(1), { from: bob }), 'Not enough staked')

    await this.goviToken.transfer(bob, toTokenAmount(500), { from: admin })
    await stakeAndValidate(bob, toTokenAmount(500))

    await expectRevert(this.staking.unstake(toTokenAmount(501), { from: bob }), 'Not enough staked')
    await expectRevert(this.staking.unstake(toTokenAmount(500), { from: bob }), 'Funds locked')
  })

  it('reverts when stakes are locked', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(500), { from: admin })
    const stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(500))

    await expectRevert(this.staking.unstake(toTokenAmount(500), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp.add(new BN(60 * 60 - 3)))

    await expectRevert(this.staking.unstake(toTokenAmount(500), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp.add(new BN(60 * 60)))
    await unstakeAndValidate(bob, toTokenAmount(500))
  })

  it('locks all stakes when adding stakes', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    const stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(500))

    await expectRevert(this.staking.unstake(toTokenAmount(500), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp.add(new BN(10 * 60)))
    const stakeTimestamp2 = await stakeAndValidate(bob, toTokenAmount(500))

    await time.increaseTo(stakeTimestamp.add(new BN(60 * 60)))
    await expectRevert(this.staking.unstake(toTokenAmount(500), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp2.add(new BN(60 * 60 - 2)))
    await expectRevert(this.staking.unstake(toTokenAmount(500), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp2.add(new BN(60 * 60)))
    await unstakeAndValidate(bob, toTokenAmount(500))
  })

  it('allows staking before adding claimable token', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(500), { from: admin })
    await stakeAndValidate(bob, toTokenAmount(500))

    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })
    const totalProfit = await sendProfitAndValidate(
      this.wethToken,
      admin,
      toTokenAmount(1000),
      this.staking.address,
      true,
    )

    await time.increase(60 * 60)

    await unstakeAndValidate(bob, toTokenAmount(500))

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(
      calculateProfit(new BN(0), totalProfit, toTokenAmount(500)),
    )
  })

  it('calculates profits proportionally for multiple accounts (no compounded govi time reward)', async () => {
    await this.wethToken.deposit({ from: admin, value: ether('20000') })

    await this.staking.setRewardRate(toBN(0), { from: admin })
    REWARDS_RATE = toBN(0)

    await this.goviToken.transfer(alice, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(carol, toTokenAmount(1000), { from: admin })

    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(500))
    const totalProfit1 = await sendProfitAndValidate(
      this.wethToken,
      admin,
      toTokenAmount(1000),
      this.staking.address,
      true,
    )

    await stakeAndValidate(alice, toTokenAmount(400))
    const totalProfit2 = totalProfit1.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(4000), this.staking.address, true),
    )

    await stakeAndValidate(carol, toTokenAmount(300))
    const totalProfit3 = totalProfit2.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true),
    )

    await time.increase(60 * 60)

    await unstakeAndValidate(carol, toTokenAmount(200))
    await stakeAndValidate(alice, toTokenAmount(100))
    const totalProfit4 = totalProfit3.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(3000), this.staking.address, true),
    )

    await time.increase(60 * 60)

    await unstakeAndValidate(alice, toTokenAmount(400))
    const totalProfit5 = totalProfit4.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(500), this.staking.address, true),
    )

    await unstakeAndValidate(bob, toTokenAmount(300))
    const totalProfit6 = totalProfit5.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(7000), this.staking.address, true),
    )

    await unstakeAndValidate(bob, toTokenAmount(200))
    await unstakeAndValidate(carol, toTokenAmount(100))

    const bobProfit = calculateProfit(new BN(0), totalProfit5, toTokenAmount(500)).add(
      calculateProfit(totalProfit5, totalProfit6, toTokenAmount(200)),
    )

    const aliceProfit = calculateProfit(totalProfit1, totalProfit4, toTokenAmount(400)).add(
      calculateProfit(totalProfit3, totalProfit6, toTokenAmount(100)),
    )

    const carolProfit = calculateProfit(totalProfit2, totalProfit3, toTokenAmount(300)).add(
      calculateProfit(totalProfit3, totalProfit6, toTokenAmount(100)),
    )

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(bobProfit)
    expect(await this.staking.profitOf(alice, this.wethToken.address)).to.be.bignumber.equal(aliceProfit)
    expect(await this.staking.profitOf(carol, this.wethToken.address)).to.be.bignumber.equal(carolProfit)

    await claimAndValidate(bob, [this.wethToken], bobProfit)
    await claimAndValidate(alice, [this.wethToken], aliceProfit)
    await claimAndValidate(carol, [this.wethToken], carolProfit)

    REWARDS_RATE = INITIAL_REWARDS_RATE
  })

  it.skip('calculates profits proportionally for multiple accounts (compounded with govi time rewards)', async () => {
    // NOTE: Fix to work properly with compounded

    await this.goviToken.transfer(alice, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(carol, toTokenAmount(1000), { from: admin })

    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })

    await stakeAndValidate(bob, toTokenAmount(500))
    const totalProfit1 = await sendProfitAndValidate(
      this.wethToken,
      admin,
      toTokenAmount(1000),
      this.staking.address,
      true,
    )

    await stakeAndValidate(alice, toTokenAmount(400))
    const totalProfit2 = totalProfit1.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(4000), this.staking.address, true),
    )

    await stakeAndValidate(carol, toTokenAmount(300))
    const totalProfit3 = totalProfit2.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(2000), this.staking.address, true),
    )

    await time.increase(60 * 60)

    await unstakeAndValidate(carol, toTokenAmount(200))
    await stakeAndValidate(alice, toTokenAmount(100))
    const totalProfit4 = totalProfit3.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(3000), this.staking.address, true),
    )

    await time.increase(60 * 60)

    await unstakeAndValidate(alice, toTokenAmount(400))
    const totalProfit5 = totalProfit4.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(500), this.staking.address, true),
    )

    await unstakeAndValidate(bob, toTokenAmount(300))
    const totalProfit6 = totalProfit5.add(
      await sendProfitAndValidate(this.wethToken, admin, toTokenAmount(7000), this.staking.address, true),
    )

    await unstakeAndValidate(bob, toTokenAmount(200))
    await unstakeAndValidate(carol, toTokenAmount(100))

    const bobProfit = calculateProfit(new BN(0), totalProfit5, toTokenAmount(500)).add(
      calculateProfit(totalProfit5, totalProfit6, toTokenAmount(200)),
    )

    const aliceProfit = calculateProfit(totalProfit1, totalProfit4, toTokenAmount(400)).add(
      calculateProfit(totalProfit3, totalProfit6, toTokenAmount(100)),
    )

    const carolProfit = calculateProfit(totalProfit2, totalProfit3, toTokenAmount(300)).add(
      calculateProfit(totalProfit3, totalProfit6, toTokenAmount(100)),
    )

    expect(await this.staking.profitOf(bob, this.wethToken.address)).to.be.bignumber.equal(bobProfit)
    expect(await this.staking.profitOf(alice, this.wethToken.address)).to.be.bignumber.equal(aliceProfit)
    expect(await this.staking.profitOf(carol, this.wethToken.address)).to.be.bignumber.equal(carolProfit)

    // NOTE: Add claimAndValidate!
  })

  const testAutoCompoundMultiUsers = async (changeRate, newRate) => {
    await this.goviToken.transfer(alice, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(carol, toTokenAmount(1000), { from: admin })

    const goviState = createCompoundBalancesState([bob, alice, carol])

    const bobStakeTimestamp = await stakeAndUpdateCompoundState(goviState, bob, toTokenAmount(500))
    await time.increase(60 * 60)
    const aliceStakeTimestamp = await stakeAndUpdateCompoundState(
      goviState,
      alice,
      toTokenAmount(400),
      bobStakeTimestamp,
    )
    await time.increase(3 * 60 * 60)
    const carolStakeTimestamp = await stakeAndUpdateCompoundState(
      goviState,
      carol,
      toTokenAmount(300),
      aliceStakeTimestamp,
    )
    await time.increase(2 * 60 * 60)
    const carolUnstakeTimestamp = await updateStateOnUnstakeAndValidate(goviState, carol, toBN(3), carolStakeTimestamp)
    let aliceSecondStakeTimestamp = await stakeAndUpdateCompoundState(
      goviState,
      alice,
      toTokenAmount(100),
      carolUnstakeTimestamp,
    )

    if (changeRate !== undefined) {
      await time.increase(4 * 60 * 60)
      await this.staking.setRewardRate(newRate, { from: admin })
      const setRewardTimestamp = await time.latest()
      await addGOVIByTime(goviState, aliceSecondStakeTimestamp, setRewardTimestamp)
      REWARDS_RATE = newRate // Note: Setting reward only after gathering up to setReward by OLD rate!
      aliceSecondStakeTimestamp = setRewardTimestamp
      await time.increase(4 * 60 * 60)
    } else {
      await time.increase(8 * 60 * 60)
    }

    const aliceUnstakeTimestamp = await updateStateOnUnstakeAndValidate(
      goviState,
      alice,
      toBN(2),
      aliceSecondStakeTimestamp,
    )
    await time.increase(60 * 60)
    const bobUnstakeTimestamp = await updateStateOnUnstakeAndValidate(goviState, bob, toBN(5), aliceUnstakeTimestamp)
    await time.increase(3 * 60 * 60)
    const bobSecondUnstakeTimestamp = await updateStateOnUnstakeAndValidate(
      goviState,
      bob,
      toBN(4),
      bobUnstakeTimestamp,
    )
    const carolSecondUnstakeTimestamp = await updateStateOnUnstakeAndValidate(
      goviState,
      carol,
      toBN(3),
      bobSecondUnstakeTimestamp,
    )
    await time.increase(5 * 60 * 60)
    const bobFinalUnstakeTimestamp = await updateStateOnUnstakeAndValidate(
      goviState,
      bob,
      toBN(1),
      carolSecondUnstakeTimestamp,
    )
    await updateStateOnUnstakeAndValidate(goviState, carol, toBN(1), bobFinalUnstakeTimestamp)

    REWARDS_RATE = INITIAL_REWARDS_RATE
  }

  it('calculates auto-compounded govi by time proportionally for multiple accounts', async () => {
    await testAutoCompoundMultiUsers()
  })

  it('sets locking period properly', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(500), { from: admin })
    await this.staking.setStakingLockupTime(0, { from: admin })
    expect(await this.staking.stakeLockupTime()).to.be.bignumber.equal(new BN(0))

    let stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(100))
    await unstakeAndValidate(bob, toTokenAmount(100))

    await this.staking.setStakingLockupTime(60, { from: admin })
    expect(await this.staking.stakeLockupTime()).to.be.bignumber.equal(new BN(60))

    stakeTimestamp = await stakeAndValidate(bob, toTokenAmount(100))
    await expectRevert(this.staking.unstake(toTokenAmount(100), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp.add(new BN(60 - 3)))
    await expectRevert(this.staking.unstake(toTokenAmount(100), { from: bob }), 'Funds locked')

    await time.increaseTo(stakeTimestamp.add(new BN(60)))
    await unstakeAndValidate(bob, toTokenAmount(100))
  })

  it('sets reward rate properly', async () => {
    expect(await this.staking.rewardPerSecond()).to.be.bignumber.equal(toBN(28000, 18).div(toBN(60 * 60 * 24 * 7)))
    const newRate = toBN(10000, 18).div(toBN(60 * 60 * 24 * 7))
    await this.staking.setRewardRate(newRate, { from: admin })
    expect(await this.staking.rewardPerSecond()).to.be.bignumber.equal(newRate)
    REWARDS_RATE = newRate

    await testAutoCompoundMultiUsers()
  })

  it('collects reward from vault so far when setting reward rate by rate up to change', async () => {
    const newRate = toBN(10000, 18).div(toBN(60 * 60 * 24 * 7))
    await testAutoCompoundMultiUsers(true, newRate)
  })

  it('stops collecting time rewards when rate is zero and resumse when rate is back to non-zero', async () => {
    await this.goviToken.transfer(alice, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await this.goviToken.transfer(carol, toTokenAmount(1000), { from: admin })

    const goviState = createCompoundBalancesState([bob, alice, carol])

    const bobStakeTimestamp = await stakeAndUpdateCompoundState(goviState, bob, toTokenAmount(500))
    await time.increase(60 * 60)
    const aliceStakeTimestamp = await stakeAndUpdateCompoundState(
      goviState,
      alice,
      toTokenAmount(400),
      bobStakeTimestamp,
    )
    await time.increase(3 * 60 * 60)
    const carolStakeTimestamp = await stakeAndUpdateCompoundState(
      goviState,
      carol,
      toTokenAmount(300),
      aliceStakeTimestamp,
    )
    await time.increase(2 * 60 * 60)

    await this.staking.setRewardRate(toBN(0), { from: admin })
    const setRewardTimestamp = await time.latest()
    await addGOVIByTime(goviState, carolStakeTimestamp, setRewardTimestamp)
    REWARDS_RATE = toBN(0) // Note: Setting reward only after gathering up to setReward by OLD rate!
    await time.increase(24 * 60 * 60)

    const aliceUnstakeTimestamp = await updateStateOnUnstakeAndValidate(goviState, alice, toBN(2), setRewardTimestamp)
    await time.increase(60 * 60)
    const bobUnstakeTimestamp = await updateStateOnUnstakeAndValidate(goviState, bob, toBN(5), aliceUnstakeTimestamp)
    await time.increase(3 * 60 * 60)
    const bobSecondUnstakeTimestamp = await updateStateOnUnstakeAndValidate(
      goviState,
      bob,
      toBN(4),
      bobUnstakeTimestamp,
    )
    const carolSecondUnstakeTimestamp = await updateStateOnUnstakeAndValidate(
      goviState,
      carol,
      toBN(3),
      bobSecondUnstakeTimestamp,
    )
    await time.increase(3 * 60 * 60)

    await this.staking.setRewardRate(INITIAL_REWARDS_RATE, { from: admin })
    const setRewardTimestamp2 = await time.latest()
    await addGOVIByTime(goviState, carolSecondUnstakeTimestamp, setRewardTimestamp2)
    REWARDS_RATE = INITIAL_REWARDS_RATE // Note: Setting reward only after gathering up to setReward by OLD rate!
    await time.increase(3 * 60 * 60)

    const bobFinalUnstakeTimestamp = await updateStateOnUnstakeAndValidate(goviState, bob, toBN(1), setRewardTimestamp2)
    await updateStateOnUnstakeAndValidate(goviState, carol, toBN(1), bobFinalUnstakeTimestamp)
  })

  it('reverts when setting locking period, or adding/removing tokens not by owner', async () => {
    await expectRevert(this.staking.setStakingLockupTime(60, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.staking.setRewardRate(1000, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.staking.setStakingLockupTime(60, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(
      this.staking.addClaimableToken(this.wethToken.address, { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(
      this.staking.removeClaimableToken(this.wethToken.address, { from: bob }),
      'Ownable: caller is not the owner',
    )
  })

  it('adds and removes claimable tokens properly', async () => {
    const addOtherToken = token => this.staking.addClaimableToken(token.address, { from: admin })
    const removeOtherToken = token => this.staking.removeClaimableToken(token.address, { from: admin })
    const getTokens = () => this.staking.getClaimableTokens()

    await testAddAndRemoveTokens(addOtherToken, removeOtherToken, getTokens)
  })

  it('reverts when adding same claimable token twice', async () => {
    await this.staking.addClaimableToken(this.wethToken.address, { from: admin })
    await expectRevert(this.staking.addClaimableToken(this.wethToken.address, { from: admin }), 'Token already added')

    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })
    await expectRevert(this.staking.addClaimableToken(this.daiToken.address, { from: admin }), 'Token already added')
  })

  // Note: was not functioning well after moving to safeApprove as didn't approve 0 on remove
  it('allows removing tokens from claimable and add same ones back again', async () => {
    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })
    await this.staking.removeClaimableToken(this.daiToken.address, { from: admin })
    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })
  })

  const testClaimProfit = async (tokens, convertToToken) => {
    await this.goviToken.transfer(bob, convertToToken(1000), { from: admin })

    for (let token of tokens) {
      await this.staking.addClaimableToken(token.address, { from: admin })
    }

    if (tokens.length === 1) {
      await expectRevert(this.staking.claimProfit(tokens[0].address, { from: bob }), 'No profit for token')
    } else {
      await expectRevert(this.staking.claimAllProfits({ from: bob }), 'No profit')
    }

    await stakeAndValidate(bob, convertToToken(500))

    let totalProfit1
    for (let token of tokens) {
      totalProfit1 = await sendProfitAndValidate(token, admin, convertToToken(1000), this.staking.address, true)
    }

    await claimAndValidate(bob, tokens, calculateProfit(new BN(0), totalProfit1, convertToToken(500)))

    let totalProfit2
    let totalProfit3
    for (let token of tokens) {
      totalProfit2 = totalProfit1.add(
        await sendProfitAndValidate(token, admin, convertToToken(4000), this.staking.address, true),
      )
      totalProfit3 = totalProfit2.add(
        await sendProfitAndValidate(token, admin, convertToToken(2000), this.staking.address, true),
      )
    }

    await claimAndValidate(bob, tokens, calculateProfit(totalProfit1, totalProfit3, convertToToken(500)))

    if (tokens.length === 1) {
      await expectRevert(this.staking.claimProfit(tokens[0].address, { from: bob }), 'No profit for token')
    } else {
      await expectRevert(this.staking.claimAllProfits({ from: bob }), 'No profit')
    }
  }

  it('reverts when claiming unsupported token or no profit', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await stakeAndValidate(bob, toTokenAmount(1000))

    await expectRevert(this.staking.claimProfit(this.daiToken.address, { from: bob }), 'Token not supported')
    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })

    await sendProfitAndValidate(this.daiToken, admin, toTokenAmount(2000), this.staking.address, true)
    await this.staking.claimProfit(this.daiToken.address, { from: bob })
  })

  it('reverts when claiming no profit token', async () => {
    await this.goviToken.transfer(bob, toTokenAmount(1000), { from: admin })
    await stakeAndValidate(bob, toTokenAmount(1000))

    await this.staking.addClaimableToken(this.daiToken.address, { from: admin })
    await expectRevert(this.staking.claimProfit(this.daiToken.address, { from: bob }), 'No profit for token')
  })

  it('claims profit properly for non-weth token', async () => {
    await testClaimProfit([this.daiToken], amount => toTokenAmount(amount))
  })

  it('claims profit as eth for weth token', async () => {
    await this.wethToken.deposit({ from: admin, value: ether('10000') })
    await testClaimProfit([this.wethToken], amount => toBN(amount, 13))
  })

  it('reverts when claiming all profits with no cache flow profits', async () => {
    await expectRevert(this.staking.claimAllProfits({ from: bob }), 'No profit')
  })
})
