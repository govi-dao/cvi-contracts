/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, time, BN, balance } = require('@openzeppelin/test-helpers')

const chai = require('chai')
const expect = chai.expect

const { MARGINS_TO_TEST } = require('./utils/TestUtils')

const {
  deployFullPlatform,
  deployPlatform,
  deployPlatformHelper,
  getContracts,
  getAccounts,
  setFeesCalculator,
  setRewards,
  setFeesCollector,
  setLiquidation,
  setStakingContractAddress,
  setupLiquidityProviders,
  ZERO_ADDRESS,
} = require('./utils/DeployUtils')

const {
  createState,
  depositAndValidate,
  withdrawAndValidate,
  openPositionAndValidate,
  closePositionAndValidate,
  liquidateAndValidate,
  MAX_FEE_DELTA_COLLATERAL,
  deposit,
  withdraw,
  withdrawLPTokens,
  openPosition,
  closePosition,
  calculateBalance,
  calculateFundingFeesWithSnapshot,
  calculateFundingFeesWithTwoSnapshots,
  calculateDepositAmounts,
  calculateWithdrawAmounts,
  calculatePositionBalance,
  calculateFundingFees,
  calculateMarginDebt,
  calculateLiquidationCVI,
  calculateLiquidationDays,
  updateSnapshots,
  getAccountBalance,
  getFeesBalance,
  GAS_PRICE,
  ALL_FEES, //TODO: Use boolean instead
  NO_FEES,
} = require('./utils/PlatformUtils.js')

const {
  MIN_CLOSE_FEE,
} = require('./utils/FeesUtils.js')
const { toBN, toTokenAmount, toCVI } = require('./utils/BNUtils.js')
const { print } = require('./utils/DebugUtils')

const StakingRewards = artifacts.require('USDTLPStakingRewards')
const FakeFeesCollector = artifacts.require('FakeFeesCollector')

// Max gas values allowed
const MAX_GAS_FIRST_DEPOSIT_EVER = toBN(250000)
const MAX_GAS_FIRST_OPEN_EVER = toBN(300000)
const MAX_GAS_OPEN = toBN(230000)
const MAX_GAS_MERGE = toBN(220000)
const MAX_GAS_PARTIAL_CLOSE = toBN(250000)
const MAX_GAS_FULL_CLOSE = toBN(210000)
const MAX_GAS_DEPOSIT = toBN(200000)
const MAX_GAS_PARTIAL_WITHDRAW = toBN(200000)
const MAX_GAS_FULL_WITHDRAW = toBN(180000)

const OPEN_FEE_PERC = new BN(15)
const LP_OPEN_FEE_PERC = new BN(15)
const DEPOSIT_FEE_PERC = new BN(0)
const WITHDRAW_FEE_PERC = new BN(0)
const TURBULENCE_PREMIUM_PERC_STEP = new BN(100)
const MAX_BUYING_PREMIUM_PERC = new BN(1000)
const MAX_FEE = new BN(10000)

const SECONDS_PER_DAY = new BN(60 * 60 * 24)
const SECONDS_PER_HOUR = new BN(60 * 60)

const SECOND_INITIAL_RATE = toBN(1, 18)
const SECOND_ETH_INITIAL_RATE = toBN(1, 10)

const CLOSE_FEE_DECAY_PERIOD = toBN(24 * 60 * 60)

let admin, bob, alice, carol, dave, eve, frank
let accountsUsed

const setAccounts = async () => {
  ;[admin, bob, alice, carol, dave, eve, frank] = await getAccounts()
  accountsUsed = [admin, bob, alice, carol, dave, eve, frank]
}

const leftTokensToWithdraw = async account => {
  const totalSupply = await this.platform.totalSupply()

  const totalBalance = await getAccountBalance(this.platform.address)

  return (await this.platform.balanceOf(account)).mul(totalBalance).div(totalSupply)
}

const increaseSharedPool = async (account, amount) => {
  if (this.isETH) {
    await this.platform.increaseSharedPoolETH({ from: account, value: amount })
  } else {
    await this.token.transfer(account, amount, { from: admin })
    await this.token.approve(this.platform.address, amount, { from: account })
    await this.platform.increaseSharedPool(amount, { from: account })
  }
}

const testMultipleAccountsDepositWithdraw = async (
  depositFee,
  withdrawFee,
  testEndBalance = true,
  addLiquidity = false,
) => {
  await this.feesCalculator.setDepositFee(depositFee, { from: admin })
  await this.feesCalculator.setWithdrawFee(withdrawFee, { from: admin })

  await depositAndValidate(this.state, 5000, bob)
  await depositAndValidate(this.state, 1000, alice)

  await time.increase(3 * 24 * 60 * 60)
  await this.fakePriceProvider.setPrice(toCVI(5000))

  await withdrawAndValidate(this.state, 1000, bob)
  await depositAndValidate(this.state, 3000, carol)

  if (addLiquidity) {
    await increaseSharedPool(dave, 5000)
    this.state.sharedPool = this.state.sharedPool.add(new BN(5000))
  }

  await withdrawAndValidate(this.state, 500, alice)

  await time.increase(3 * 24 * 60 * 60)
  await this.fakePriceProvider.setPrice(toCVI(5000))

  if (depositFee.toNumber() === 0 && withdrawFee.toNumber() === 0) {
    await withdrawAndValidate(this.state, 500, alice)
    await withdrawAndValidate(this.state, 3000, carol)
  } else {
    let leftTokens = await leftTokensToWithdraw(alice)
    await withdrawAndValidate(this.state, leftTokens, alice)

    leftTokens = await leftTokensToWithdraw(carol)
    await withdrawAndValidate(this.state, leftTokens, carol)
  }

  if (testEndBalance) {
    expect(await this.platform.balanceOf(carol)).is.bignumber.equal(new BN(0))
    expect(await this.platform.balanceOf(alice)).is.bignumber.equal(new BN(0))
  }
}

const calculationsForBuyingPremium = async (cviValue, openTokenAmount, previousPositionUnits) => {
  let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent()
  let openPositionFee = openTokenAmount.mul(OPEN_FEE_PERC).div(MAX_FEE)
  let positionUnitsAmountWithoutPremium = openTokenAmount
    .sub(openPositionFee)
    .div(cviValue)
    .mul(getContracts().maxCVIValue)
  let minPositionUnitsAmount = positionUnitsAmountWithoutPremium.mul(new BN(90)).div(new BN(100))
  let totalPositionUnitsAmount = await this.platform.totalPositionUnitsAmount()

  let tokensInSharedPoolBalance = await this.token.balanceOf(this.platform.address)
  let collateralRatio = toTokenAmount(totalPositionUnitsAmount.add(minPositionUnitsAmount))
    .div(tokensInSharedPoolBalance.add(openTokenAmount).sub(openPositionFee))
    .div(new BN(100000000))
  let buyingPremium = await this.feesCalculator.calculateBuyingPremiumFee(openTokenAmount, collateralRatio)

  let buyingPremiumPercent = buyingPremium.mul(MAX_FEE).div(openTokenAmount)
  let combineedBuyingPremiumPercent = new BN(buyingPremiumPercent.add(currTurbulence))
  if (combineedBuyingPremiumPercent.gt(MAX_BUYING_PREMIUM_PERC)) {
    combineedBuyingPremiumPercent = MAX_BUYING_PREMIUM_PERC
  }

  let currPositionUnits = openTokenAmount
    .mul(MAX_FEE.sub(OPEN_FEE_PERC).sub(combineedBuyingPremiumPercent))
    .div(MAX_FEE)
    .mul(getContracts().maxCVIValue)
    .div(cviValue)
  let combinedPositionUnits = currPositionUnits.add(previousPositionUnits)

  return [combinedPositionUnits, combineedBuyingPremiumPercent, collateralRatio, minPositionUnitsAmount]
}

const getPositionAmountByDeltaCollateral = (deltaCollateral, deposit, cviValue) => {
  // (position * max / cvi) / (deposit + position) = deltaCollateral / max_fee
  // position * max / cvi = (deltaCollateral / max_fee) * (deposit + position) = (deltaCollateral / max_fee) * deposit + (deltaCollateral / max_fee) * position
  // position * (max / cvi - deltaCollateral / max_fee) = (deltaCollateral / max_fee) * deposit
  // position = ((deltaCollateral / max_fee) * deposit) / ((max * max_fee - deltaCollateral * cvi) / (cvi * max_fee))
  // position = (deltaCollateral / max_fee * deposit) * (cvi * max_fee) / (max * max_fee - deltaCollateral * cvi)
  // position = (deltaCollateral * deposit * cvi) / (max * max_fee - deltaCollateral * cvi)
  return deposit
    .mul(toBN(deltaCollateral))
    .mul(toBN(cviValue))
    .div(MAX_FEE.mul(getContracts().maxCVIValue).sub(toBN(deltaCollateral).mul(toBN(cviValue))))
}

const verifyNoVolumeFeeScenario = async (
  openPositionsNum,
  openPositionDeltaCollateral,
  depositAmount,
  timeBetweenOpens,
) => {
  const cviValue = 10000
  await this.fakePriceProvider.setPrice(toCVI(cviValue))

  const deposit = new BN(depositAmount)
  await depositAndValidate(this.state, deposit, bob)

  const position = getPositionAmountByDeltaCollateral(openPositionDeltaCollateral, deposit, cviValue)

  for (let i = 0; i < openPositionsNum; i++) {
    const { volumeFeePercentage } = await openPositionAndValidate(this.state, position, alice)
    expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0))

    if (timeBetweenOpens !== undefined) {
      await time.increase(timeBetweenOpens)
    }

    await this.fakePriceProvider.setPrice(toCVI(cviValue))
  }
}

const verifyNoCloseVolumeFeeScenario = async (
  closePositionsNum,
  closePositionDeltaCollateral,
  depositAmount,
  timeBetweenCloses,
) => {
  const cviValue = 10000
  await this.fakePriceProvider.setPrice(toCVI(cviValue))

  const deposit = new BN(depositAmount)
  await depositAndValidate(this.state, deposit, bob)

  const position = getPositionAmountByDeltaCollateral(closePositionDeltaCollateral, deposit, cviValue)

  const allPositionUnits = []
  let lastPositionUnits = toBN(0)
  for (let i = 0; i < closePositionsNum; i++) {
    const { positionUnits } = await openPositionAndValidate(this.state, position, alice)
    allPositionUnits.push(positionUnits.sub(lastPositionUnits))
    lastPositionUnits = positionUnits
  }

  await time.increase(SECONDS_PER_DAY.mul(toBN(3)))

  for (let i = 0; i < closePositionsNum; i++) {
    const { volumeFeePercentage } = await closePositionAndValidate(this.state, allPositionUnits[i], alice)
    expect(volumeFeePercentage).to.be.bignumber.equal(toBN(0))

    if (timeBetweenCloses !== undefined) {
      await time.increase(timeBetweenCloses)
    }
  }
}

const beforeEachPlatform = async isETH => {
  await setAccounts()
  await deployFullPlatform(isETH, 1)
  await setupLiquidityProviders(accountsUsed)

  this.isETH = isETH
  this.cviToken = getContracts().cviToken
  this.tokenAddress = getContracts().tokenAddress
  this.token = getContracts().token
  this.fakePriceProvider = getContracts().fakePriceProvider
  this.fakeOracle = getContracts().fakeOracle
  this.feesCalculator = getContracts().feesCalculator
  this.fakeFeesCollector = getContracts().fakeFeesCollector
  this.rewards = getContracts().rewards
  this.liquidation = getContracts().liquidation
  this.platform = getContracts().platform

  this.state = createState(accountsUsed)

  await this.feesCalculator.setDepositFee(DEPOSIT_FEE_PERC, { from: admin })
  await this.feesCalculator.setWithdrawFee(WITHDRAW_FEE_PERC, { from: admin })
}

const setPlatformTests = isETH => {
  it('reverts when deposit gives less than min LP tokens', async () => {
    const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } = await calculateDepositAmounts(this.state, 5000)

    if (!this.isETH) {
      await this.token.transfer(bob, bobDepositTokens, { from: admin })
      await this.token.approve(this.platform.address, bobLPTokens, { from: bob })
    }

    await expectRevert(deposit(bobDepositTokens, bobLPTokens.add(new BN(1)), bob), 'Too few LP tokens')
  })

  if (!isETH) {
    it('reverts when depositing and not enough tokens are allowed', async () => {
      const { depositTokens: bobDepositTokens, lpTokens: bobLPTokens } = await calculateDepositAmounts(this.state, 5000)

      await this.token.transfer(bob, bobDepositTokens, { from: admin })

      await expectRevert(deposit(bobDepositTokens, bobLPTokens, bob), 'ERC20: insufficient allowance')
      await this.token.approve(this.platform.address, bobDepositTokens.sub(new BN(1)), { from: bob })
      await expectRevert(deposit(bobDepositTokens, bobLPTokens, bob), 'ERC20: insufficient allowance')
      await this.token.approve(this.platform.address, bobLPTokens, { from: bob })

      await this.platform.deposit(bobDepositTokens, bobLPTokens, { from: bob })
    })
  }

  it.skip('reverts when depositing not by liquidity provider', async () => {})

  it('reverts when calling deposit too long after latest cvi oracle', async () => {
    await time.increase(5 * SECONDS_PER_DAY)
    await expectRevert(depositAndValidate(this.state, 1000, bob), 'Latest cvi too long ago')
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await depositAndValidate(this.state, 1000, bob)
  })

  it('reverts when calling open too long after latest cvi oracle', async () => {
    await depositAndValidate(this.state, 5000, bob)
    await time.increase(5 * SECONDS_PER_DAY)
    await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'Latest cvi too long ago')
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await openPositionAndValidate(this.state, 1000, alice)
  })

  it('deposits liquidity correctly', async () => {
    await depositAndValidate(this.state, 5000, bob)
    await depositAndValidate(this.state, 1000, bob)
    await depositAndValidate(this.state, 2000, alice)
  })

  it('withdraws all lp tokens correctly', async () => {
    await depositAndValidate(this.state, 1000, bob)
    await time.increase(3 * SECONDS_PER_DAY)

    const bobLPTokensBalance = await this.platform.balanceOf(bob)
    await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance)

    expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0))
  })

  it('reverts when withdrawing locked funds', async () => {
    const { depositTimestamp } = await depositAndValidate(this.state, 5000, bob)

    await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked')
    await time.increaseTo(depositTimestamp.add(new BN(24 * 60 * 60)))
    await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked')
    await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60 - 2)))
    await expectRevert(withdraw(toBN(1), toTokenAmount(1000000), bob), 'Funds are locked')
    await time.increaseTo(depositTimestamp.add(new BN(3 * 24 * 60 * 60)))

    await withdraw(toBN(1), toTokenAmount(1000000), bob)
  })

  it('reverts when withdrawing a zero amount', async () => {
    await expectRevert.unspecified(withdraw(toBN(0), toTokenAmount(1000000), bob))
  })

  it('reverts when withdraw results in burning more than max requested LP tokens', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { withdrawTokens, burnedLPTokens } = await calculateWithdrawAmounts(this.state, 5000)

    await time.increase(3 * 24 * 60 * 60)

    await expectRevert(withdraw(withdrawTokens, burnedLPTokens.sub(new BN(1)), bob), 'Too much LP tokens to burn')
  })

  it.skip('reverts when withdrawing not by liquidity provider', async () => {})

  it('reverts when withdrawing with not enough LP tokens in account balance', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { withdrawTokens, burnedLPTokens } = await calculateWithdrawAmounts(this.state, 5001)

    await time.increase(3 * 24 * 60 * 60)

    await expectRevert(withdraw(withdrawTokens, burnedLPTokens, bob), 'Not enough LP tokens for account')
  })

  it('reverts when withdrawing funds that are holding current positions (broken collateral)', async () => {
    await this.fakePriceProvider.setPrice(toCVI(11000))

    await depositAndValidate(this.state, toTokenAmount(2), bob)
    await depositAndValidate(this.state, toTokenAmount(1), carol)

    await time.increase(3 * 24 * 60 * 60)

    await this.fakePriceProvider.setPrice(toCVI(11000))
    await openPositionAndValidate(this.state, toTokenAmount(3), alice)

    // Note that there is quite a high premium + volume fee, so need to withdraw quite a lot to break collalteral
    await expectRevert(withdrawAndValidate(this.state, toTokenAmount(1).div(toBN(3)), bob), 'Collateral ratio broken')
    await expectRevert(withdrawAndValidate(this.state, toTokenAmount(1).div(toBN(3)), carol), 'Collateral ratio broken')
  })

  it('withdraws liquidity correctly', async () => {
    await depositAndValidate(this.state, 5000, bob)

    await time.increase(3 * 24 * 60 * 60)

    await withdrawAndValidate(this.state, 1000, bob)
    await withdrawAndValidate(this.state, 500, bob)
    await withdrawAndValidate(this.state, 2000, bob)

    const leftTokens = await leftTokensToWithdraw(bob)
    await withdrawAndValidate(this.state, leftTokens, bob)

    expect(await this.platform.balanceOf(bob)).is.bignumber.equal(new BN(0))
  })

  it('handles multiple accounts deposit and withdraw correctly with a different initial rate', async () => {
    await deployPlatform(this.isETH, SECOND_INITIAL_RATE, SECOND_ETH_INITIAL_RATE)
    this.platform = getContracts().platform
    this.feesCalculator.setStateUpdator(this.platform.address, { from: admin })
    await setupLiquidityProviders(accountsUsed)

    await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, WITHDRAW_FEE_PERC)
  })

  it('handles multiple accounts deposit and withdraw correctly', async () => {
    await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, WITHDRAW_FEE_PERC)
  })

  it('handles multiple accounts deposit and withdraw correctly with no fees', async () => {
    await testMultipleAccountsDepositWithdraw(new BN(0), new BN(0))
  })

  it('handles multiple accounts deposit and withdraw correctly with deposit fee only', async () => {
    await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, new BN(0))
  })

  it('handles multiple accounts deposit and withdraw correctly with withdraw fee only', async () => {
    await testMultipleAccountsDepositWithdraw(new BN(0), WITHDRAW_FEE_PERC)
  })

  it('handles increasing shared pool correctly', async () => {
    await this.platform.setAddressSpecificParameters(dave, true, false, true, { from: admin })
    await testMultipleAccountsDepositWithdraw(DEPOSIT_FEE_PERC, WITHDRAW_FEE_PERC, false, true)
  })

  it('reverts when trying to increase shared pool without permission', async () => {
    await expectRevert.unspecified(increaseSharedPool(bob, 1000)) // 'Not allowed'
    await expectRevert.unspecified(increaseSharedPool(alice, 1000)) // 'Not allowed'

    await this.platform.setAddressSpecificParameters(alice, true, false, true, { from: admin })

    await expectRevert.unspecified(increaseSharedPool(bob, 1000)) // 'Not allowed'
    await increaseSharedPool(alice, 1000)

    await this.platform.setAddressSpecificParameters(alice, true, false, false, { from: admin })

    await expectRevert.unspecified(increaseSharedPool(bob, 1000)) // 'Not allowed'
    await expectRevert.unspecified(increaseSharedPool(alice, 1000)) // 'Not allowed'
  })

  it('prevents bypassing lock by passing token to antoher address', async () => {
    const { depositTimestamp: timestamp } = await depositAndValidate(this.state, 1000, bob)
    const lpTokensNum = await this.platform.balanceOf(bob)

    await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), bob), 'Funds are locked')

    await time.increaseTo(timestamp.add(new BN(SECONDS_PER_DAY)))
    await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), bob), 'Funds are locked')

    await this.platform.transfer(alice, lpTokensNum, { from: bob })

    await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), alice), 'Funds are locked')

    await time.increaseTo(timestamp.add(new BN(3 * SECONDS_PER_DAY - 3)))
    await expectRevert(withdraw(new BN(1), toTokenAmount(1000000), alice), 'Funds are locked')

    await time.increaseTo(timestamp.add(new BN(3 * SECONDS_PER_DAY)))
    await withdraw(new BN(1), toTokenAmount(1000000), alice)
  })

  it('lock time is not passed when staking/unstaking to staking contract address specified, and sets current time on withdraw', async () => {
    if (!this.isETH) {
      await this.token.transfer(bob, 2000, { from: admin })
      await this.token.approve(this.platform.address, 2000, { from: bob })

      await this.token.transfer(alice, 1000, { from: admin })
      await this.token.approve(this.platform.address, 1000, { from: alice })
    }

    const staking = await StakingRewards.new(admin, admin, this.cviToken.address, this.platform.address)

    await deposit(1000, 0, bob)
    const timestamp = await time.latest()
    const lpTokensNum = await this.platform.balanceOf(bob)

    expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp)

    await time.increase(60)

    await this.platform.approve(staking.address, lpTokensNum, { from: bob })
    await staking.stake(lpTokensNum, { from: bob })
    expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp)

    await time.increase(60)

    await deposit(1000, 0, alice)
    const timestamp2 = await time.latest()
    const lpTokensNum2 = await this.platform.balanceOf(alice)
    expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp)

    await time.increase(60)

    await this.platform.approve(staking.address, lpTokensNum2, { from: alice })
    await staking.stake(lpTokensNum2, { from: alice })
    expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2)

    await time.increase(60)

    await staking.withdraw(lpTokensNum, { from: bob })
    expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp2)

    await setStakingContractAddress(staking.address, { from: admin })
    await time.increase(60)

    await deposit(1000, 0, bob)
    const timestamp3 = await time.latest()
    const lpTokensNum3 = await this.platform.balanceOf(bob)
    expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3)

    await time.increase(60)

    this.platform.approve(staking.address, lpTokensNum3, { from: bob })
    await staking.stake(lpTokensNum3, { from: bob })
    expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2)
    expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(timestamp3)

    await time.increase(60)

    await staking.withdraw(lpTokensNum3, { from: bob })
    const withdrawTimestamp = await time.latest()

    expect(await this.platform.lastDepositTimestamp(staking.address)).to.be.bignumber.equal(timestamp2)
    expect(await this.platform.lastDepositTimestamp(bob)).to.be.bignumber.equal(withdrawTimestamp)
  })

  it('prevents transfer of locked tokens if recipient sets so', async () => {
    const { depositTimestamp: timestamp } = await depositAndValidate(this.state, 1000, bob)
    const lpTokensNum = await this.platform.balanceOf(bob)

    if (!this.isETH) {
      await this.token.transfer(bob, 1000, { from: admin })
      await this.token.approve(this.platform.address, 1000, { from: bob })

      await this.token.transfer(alice, 1000, { from: admin })
      await this.token.approve(this.platform.address, 1000, { from: alice })
    }

    await time.increaseTo(timestamp.add(new BN(2 * SECONDS_PER_DAY)))
    await this.fakePriceProvider.setPrice(toCVI(5000))

    expect(await this.platform.revertLockedTransfered(bob)).to.be.false
    expect(await this.platform.revertLockedTransfered(alice)).to.be.false

    await this.platform.transfer(alice, lpTokensNum.div(new BN(4)), { from: bob })
    await this.platform.setRevertLockedTransfers(true, { from: bob })
    expect(await this.platform.revertLockedTransfered(bob)).to.be.true

    await time.increase(1)
    await deposit(10, 0, bob)

    await this.platform.transfer(alice, lpTokensNum.div(new BN(4)), { from: bob })
    await this.platform.setRevertLockedTransfers(true, { from: alice })
    expect(await this.platform.revertLockedTransfered(alice)).to.be.true

    await time.increase(1)
    await deposit(10, 0, bob)

    await expectRevert(
      this.platform.transfer(alice, lpTokensNum.div(new BN(4)), { from: bob }),
      'Recipient refuses locked tokens',
    )
    await this.platform.setRevertLockedTransfers(false, { from: alice })

    await time.increase(1)
    await deposit(10, 0, alice)

    await this.platform.transfer(alice, lpTokensNum.div(new BN(4)), { from: bob })
    await expectRevert(
      this.platform.transfer(bob, lpTokensNum.div(new BN(4)), { from: alice }),
      'Recipient refuses locked tokens',
    )
  })

  it('allows emergency withdraw if set even when collateral is broken but keeps lock', async () => {
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await depositAndValidate(this.state, toTokenAmount(5), bob)

    await openPositionAndValidate(this.state, toTokenAmount(1), alice)

    await time.increase(3 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(10000))

    await expectRevert(withdrawAndValidate(this.state, toTokenAmount(5), bob), 'Collateral ratio broken')
    await this.platform.setEmergencyParameters(true, true, { from: admin })
    await withdrawAndValidate(this.state, toTokenAmount(3), bob)

    await depositAndValidate(this.state, toTokenAmount(5), bob)

    await expectRevert(withdrawAndValidate(this.state, toTokenAmount(5), bob), 'Funds are locked')

    await time.increase(3 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(10000))

    await this.platform.setEmergencyParameters(false, true, { from: admin })
    await withdrawAndValidate(this.state, toTokenAmount(5), bob)
  })

  it('allows complete shutdown of all operations by setters', async () => {
    await setFeesCalculator(ZERO_ADDRESS, { from: admin })

    await expectRevert(depositAndValidate(this.state, 5000, bob), 'revert')

    await setFeesCalculator(this.feesCalculator.address, { from: admin })
    await depositAndValidate(this.state, 5000, bob)
    await setFeesCalculator(ZERO_ADDRESS, { from: admin })

    await time.increase(3 * 24 * 60 * 60)

    await expectRevert(withdraw(1000, toBN(1, 40), bob), 'revert')
    await expectRevert(withdrawLPTokens(1000, bob), 'revert')

    await this.fakePriceProvider.setPrice(toCVI(5000))

    await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'revert')

    await setFeesCalculator(this.feesCalculator.address, { from: admin })
    await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(24 * 60 * 60)

    await setFeesCalculator(ZERO_ADDRESS, { from: admin })
    await expectRevert(closePosition(1000, 5000, alice), 'revert')

    await setLiquidation(ZERO_ADDRESS, { from: admin })
    await expectRevert(this.platform.liquidatePositions([bob], { from: carol }), 'revert')

    await setFeesCalculator(this.feesCalculator.address, { from: admin })
    await setLiquidation(this.liquidation.address, { from: admin })

    await expectRevert(this.platform.liquidatePositions([bob], { from: carol }), 'No liquidable position')
  })

  it('reverts when opening a position with zero tokens', async () => {
    await expectRevert.unspecified(openPosition(0, 20000, alice))
  })

  it('reverts when opening a position with a bad max CVI value', async () => {
    await expectRevert.unspecified(openPosition(5000, 0, alice))
    await expectRevert.unspecified(openPosition(5000, getContracts().maxCVIValue.toNumber() + 1, alice))
  })

  it('reverts when opening a position with CVI value higher than max CVI', async () => {
    await depositAndValidate(this.state, 40000, bob)

    if (!this.isETH) {
      await this.token.transfer(alice, 10000, { from: admin })
      await this.token.approve(this.platform.address, 10000, { from: alice })
    }

    await this.fakePriceProvider.setPrice(toCVI(5000))
    await expectRevert(openPosition(5000, 4999, alice), 'CVI too high')

    await this.fakePriceProvider.setPrice(toCVI(6000))
    await openPosition(5000, 6000, alice)
    await openPosition(5000, 6001, alice)
    await expectRevert(openPosition(5000, 5999, alice), 'CVI too high')
  })

  //TODO: Needed?...
  it.skip('output funding fee values', async () => {
    const result = await getContracts().platformHelper.fundingFeeValues(this.platform.address, 0, 20000, 5000, 5000)
    for (let i = 0; i < result[0].length; i++) {
      console.log('cvi: ' + (i * 100).toString() + ', percent: ' + result[0][i].toString())
    }
  })

  it('calculates funding fees properly for different cvi values', async () => {
    const cviValues = [50, 55, 75, 100, 125, 150, 180, 200]
    const helperRates = []
    let nextCVIIndex = 0

    const result = await getContracts().platformHelper.fundingFeeValues(this.platform.address, 0, 220, 5000, 5000)
    for (let i = 0; i < result[0].length; i++) {
      if (i === cviValues[nextCVIIndex]) {
        helperRates.push(result[0][i])
        nextCVIIndex++
      }
    }

    await depositAndValidate(this.state, toTokenAmount(1), bob)

    for (let i = 0; i < cviValues.length; i++) {
      const cvi = cviValues[i]
      await time.increase(1 * SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(cvi * 100))
      const { positionUnits } = await openPositionAndValidate(this.state, 1000000000, alice)
      await time.increase(1 * SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(cvi * 100))
      const { fundingFees } = await closePositionAndValidate(this.state, positionUnits, alice)
      await time.increase(1 * SECONDS_PER_DAY)

      expect(fundingFees / 1000000000).to.be.lte(helperRates[i].toNumber() / 1000000)
      expect(fundingFees / 1000000000).to.be.gte((helperRates[i].toNumber() * 95) / 100000000)
    }
  })

  it('calcalates time turbulence with not enough deviation properly', async () => {
    await depositAndValidate(this.state, 40000, bob)

    // Cause turbulence
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5005))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5010))
    await time.increase(1)

    await openPositionAndValidate(this.state, 1000, alice)
  })

  it('calcalates time turbulence with more than enough deviation properly', async () => {
    await depositAndValidate(this.state, 40000, bob)

    // Cause turbulence
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(6000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(7000))
    await time.increase(1)

    await openPositionAndValidate(this.state, 1000, alice)
  })

  it('calcalates time turbulence with nearly enough deviation properly', async () => {
    await depositAndValidate(this.state, 40000, bob)

    // Cause turbulence
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5300))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5400))
    await time.increase(1)

    await openPositionAndValidate(this.state, 1000, alice)
  })

  it.skip('calculates time turbulence properly with a shorter heartbeat', async () => {})

  it('reverts when opening a position with buying premium percentage higher than max', async () => {
    await depositAndValidate(this.state, 800000, bob)

    if (!this.isETH) {
      await this.token.transfer(alice, 10000, { from: admin })
      await this.token.approve(this.platform.address, 10000, { from: alice })
    }

    // Cause turbulence
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(6000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(7000))
    await time.increase(1)

    // Used to update snapshots
    await depositAndValidate(this.state, 1, bob)

    const turbulenceIndicatorPercent = TURBULENCE_PREMIUM_PERC_STEP.mul(new BN(3))

    await expectRevert(
      openPosition(5000, 7000, alice, turbulenceIndicatorPercent.add(LP_OPEN_FEE_PERC).sub(new BN(1))),
      'Premium fee too high',
    )
    await openPosition(5000, 7000, alice, turbulenceIndicatorPercent.add(LP_OPEN_FEE_PERC))
  })

  it.skip('opens a position with no fees at all properly', async () => {
    await depositAndValidate(this.state, 40000, bob)

    // Cause turbulence
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5300))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5400))
    await time.increase(1)

    await this.platform.setAddressSpecificParameters(alice, true, true, false, { from: admin })
    await openPositionAndValidate(this.state, 1000, alice, true, true)
  })

  it.skip('closes a position with LP close premium fee properly', async () => {})

  it.skip('prevents underflow when position units goes back to nearly zero, and total funding fees become negative', async () => {
    // NOTE: This test attempts to recreate a scenario where subtracting funding fees necessarily underflows and needs a special test to avoid reverting

    await this.fakePriceProvider.setPrice(toCVI(10000))
    await openPositionAndValidate(this.state, new BN('120329945501764161'), frank)
    await time.increase(SECONDS_PER_DAY)
    const positionUnitsFrank = (await this.platform.positions(frank)).positionUnitsAmount
    await closePositionAndValidate(this.state, positionUnitsFrank.div(toBN(2)).sub(toBN(1)), frank)
    await time.increase(SECONDS_PER_HOUR)
    await closePositionAndValidate(this.state, positionUnitsFrank.div(toBN(2)).sub(toBN(1)), frank) // NOTE: This line should cause the overflow!
  })

  it.skip('calculates volume fees correctly on a complex scenario', async () => {
    let cviValue = 10000
    await this.fakePriceProvider.setPrice(toCVI(cviValue))

    let deposit = toTokenAmount(10)
    await depositAndValidate(this.state, deposit, bob)
    await depositAndValidate(this.state, deposit, alice)
    await depositAndValidate(this.state, deposit, carol)
    await depositAndValidate(this.state, deposit, dave)

    deposit = deposit.mul(new BN(4))

    await time.increase(SECONDS_PER_DAY * 3)

    await this.fakePriceProvider.setPrice(toCVI(cviValue))

    let position = getPositionAmountByDeltaCollateral(100, deposit, cviValue)
    const evePosition = position
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(this.state, position, eve)
    deposit = deposit.add(position)

    await time.increase(SECONDS_PER_HOUR)

    cviValue = 11000
    await this.fakePriceProvider.setPrice(toCVI(cviValue))

    position = getPositionAmountByDeltaCollateral(150, deposit, cviValue)
    let frankPosition = position
    await openPositionAndValidate(this.state, position, frank)
    deposit = deposit.add(position)

    await time.increase(SECONDS_PER_DAY)

    await withdrawAndValidate(this.state, 0, bob, await this.platform.balanceOf(bob))
    deposit = deposit.sub(toTokenAmount(10))

    await closePositionAndValidate(this.state, positionUnits1, eve)
    deposit = deposit.sub(evePosition)

    cviValue = 10500
    await this.fakePriceProvider.setPrice(toCVI(cviValue))

    await time.increase(SECONDS_PER_HOUR.div(toBN(4)))

    await depositAndValidate(this.state, toTokenAmount(20), bob)
    deposit = deposit.add(toTokenAmount(20))

    position = getPositionAmountByDeltaCollateral(50, deposit, cviValue)
    frankPosition = frankPosition.add(position)
    await openPositionAndValidate(this.state, position, frank)
    deposit = deposit.add(position)

    await time.increase(SECONDS_PER_DAY)

    const positionUnitsFrank = (await this.platform.positions(frank)).positionUnitsAmount

    await closePositionAndValidate(this.state, positionUnitsFrank.div(toBN(2)).sub(toBN(1)), frank)
    deposit = deposit.sub(frankPosition.div(toBN(2)))

    await time.increase(SECONDS_PER_HOUR)

    await closePositionAndValidate(this.state, positionUnitsFrank.div(toBN(2)).sub(toBN(1)), frank) // NOTE: This line caused the overflow once
    deposit = deposit.sub(frankPosition.div(toBN(2)))

    await withdrawAndValidate(this.state, 0, alice, await this.platform.balanceOf(alice))
    deposit = deposit.sub(toTokenAmount(10))

    await this.fakePriceProvider.setPrice(toCVI(cviValue))

    position = getPositionAmountByDeltaCollateral(50, deposit, cviValue)
    await openPositionAndValidate(this.state, position, eve)
    deposit = deposit.add(position)
  })

  const testOpenWithoutPrivilage = async withFees => {
    await depositAndValidate(this.state, 40000, bob)

    // Remove privilage
    await this.platform.setAddressSpecificParameters(alice, true, false, false, false, { from: admin })
    await this.platform.setAddressSpecificParameters(bob, true, false, false, true, { from: admin })

    await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, withFees))
    await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, undefined, withFees))

    await this.platform.setAddressSpecificParameters(alice, true, true, false, false, { from: admin })

    await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, withFees))
    await openPositionAndValidate(this.state, 1000, alice, undefined, withFees)

    await this.platform.setAddressSpecificParameters(alice, true, false, false, false, { from: admin })

    await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, bob, undefined, withFees))
    await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, undefined, withFees))
  }

  it('reverts when trying to open a position with no fees without privilage', async () => {
    await testOpenWithoutPrivilage(NO_FEES)
  })

  it('reverts when trying to open a position with fees without privilage', async () => {
    await testOpenWithoutPrivilage(ALL_FEES)
  })

  it('reverts when opening a position with too high position units', async () => {
    await expectRevert.unspecified(openPosition(toBN(374, 48), 5000, alice))
    await expectRevert.unspecified(openPosition(toBN(94, 48), 5000, alice))
  })

  it('reverts when merging a position with too high position units', async () => {
    await depositAndValidate(this.state, 5000, bob)
    await openPositionAndValidate(this.state, 1000, alice)

    await expectRevert.unspecified(openPosition(toBN(374, 48).sub(new BN(1000).div(new BN(4))), 5000, alice))
    await expectRevert.unspecified(openPosition(toBN(120, 48).sub(new BN(1000).div(new BN(4))), 5000, alice))
  })

  it('reverts when opening a position with no liquidity at all (special division by zero revert)', async () => {
    await expectRevert.unspecified(openPositionAndValidate(this.state, toTokenAmount(15), alice))
  })

  for (let margin of MARGINS_TO_TEST) {
    it(`reverts if not enough liquidity expected after openning a position (margin = ${margin})`, async () => {
      this.feesCalculator.setBuyingPremiumFeeMax(0, { from: admin })
      this.feesCalculator.setOpenPositionFee(0, { from: admin })

      let cviValue = toCVI(11000)
      await this.fakePriceProvider.setPrice(cviValue)

      await depositAndValidate(this.state, toTokenAmount(9), bob)
      const deposit = toTokenAmount(10)

      // amount margined = x
      // total position units = x * 2 (cvi) * margin
      // x * 2 * margin < deposit + x * margin
      // x * margin < deposit => x < deposit / margin
      const open = toBN(((1e18 * 10) / margin + 1000000).toString())

      // Note: not using openPositionAndValidate since open position fees and preimum fees are disabled, and would cause test to fail
      if (!getContracts().isETH) {
        await getContracts().token.transfer(alice, open, { from: admin })
        await getContracts().token.approve(getContracts().platform.address, open, { from: alice })
        await expectRevert(
          this.platform.openPosition(open, toBN(22000), toBN(1), margin, { from: alice }),
          'Not enough liquidity',
        )
      } else {
        await expectRevert(
          this.platform.openPositionETH(toBN(22000), toBN(1), margin, { from: alice, value: open }),
          'Not enough liquidity',
        )
      }

      await depositAndValidate(this.state, toTokenAmount(1), bob)

      if (!getContracts().isETH) {
        await getContracts().token.transfer(alice, open, { from: admin })
        await getContracts().token.approve(getContracts().platform.address, open, { from: alice })
        await expectRevert(
          this.platform.openPosition(open, toBN(22000), toBN(1), margin, { from: alice }),
          'Not enough liquidity',
        )
      } else {
        await expectRevert(
          this.platform.openPositionETH(toBN(22000), toBN(1), margin, { from: alice, value: open }),
          'Not enough liquidity',
        )
      }

      await depositAndValidate(this.state, toBN(1000000000), bob)

      if (!getContracts().isETH) {
        await getContracts().token.transfer(alice, open, { from: admin })
        await getContracts().token.approve(getContracts().platform.address, open, { from: alice })
        await this.platform.openPosition(open, toBN(22000), toBN(1), margin, { from: alice })
      } else {
        await this.platform.openPositionETH(toBN(22000), toBN(1), margin, { from: alice, value: open })
      }

      await time.increase(SECONDS_PER_DAY * 3)

      await this.fakePriceProvider.setPrice(toCVI(22000))

      const position = await this.platform.positions(alice)
      await this.platform.closePosition(position.positionUnitsAmount, toBN(1), { from: alice })
    })

    it(`reverts when opening a position with a different margin than an already opened position (margin = ${margin})`, async () => {
      const firstMargin = MARGINS_TO_TEST[0]
      const secondMargin = MARGINS_TO_TEST[1]

      expect(firstMargin).not.equal(secondMargin)

      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, 5000 * firstMargin * 2 - 5000 * (firstMargin - 1) - 5000, bob)
      await openPositionAndValidate(this.state, 5000, alice, true, false, firstMargin)

      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, 5000 * secondMargin * 2 - 5000 * (secondMargin - 1) - 5000, bob)
      await expectRevert.unspecified(openPositionAndValidate(this.state, 5000, alice, true, false, secondMargin))
    })
  }

  it('checks liquidity check disregards margin debt until close', async () => {
    let cviValue = toCVI(11000)
    await this.fakePriceProvider.setPrice(cviValue)

    await depositAndValidate(this.state, toTokenAmount(2), bob)

    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice, 2)

    await time.increase(SECONDS_PER_DAY * 3)

    await this.fakePriceProvider.setPrice(toCVI(22000))
    await closePositionAndValidate(this.state, positionUnits, alice)
  })

  it('reaches low enough gas values for deposit/withdraw actions', async () => {
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))

    const { gasUsed: firstDepositGasUsed } = await depositAndValidate(this.state, 4000, bob)
    print('first deposit', firstDepositGasUsed.div(GAS_PRICE).toString())
    expect(firstDepositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FIRST_DEPOSIT_EVER)

    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(6000))
    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(6000))

    const { gasUsed: depositGasUsed } = await depositAndValidate(this.state, 2000, bob)
    print('deposit', depositGasUsed.div(GAS_PRICE).toString())
    expect(depositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_DEPOSIT)

    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(7000))
    await time.increase(3 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(7000))

    const { gasUsed: partialWithdrawGasUsed } = await withdrawAndValidate(this.state, 2000, bob)
    print('partial withdraw', partialWithdrawGasUsed.div(GAS_PRICE).toString())
    expect(partialWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_PARTIAL_WITHDRAW)

    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))
    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))

    const { gasUsed: fullWithdrawGasUsed } = await withdrawAndValidate(this.state, 4000, bob)
    print('full withdraw', fullWithdrawGasUsed.div(GAS_PRICE).toString())
    expect(fullWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FULL_WITHDRAW)
  })

  it('reaches low enough gas values for open/close actions', async () => {
    await this.fakePriceProvider.setPrice(toCVI(5000))

    await time.increase(24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    const { gasUsed: firstDepositGasUsed } = await depositAndValidate(this.state, 40000, bob)
    print('first deposit', firstDepositGasUsed.div(GAS_PRICE).toString())
    expect(firstDepositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FIRST_DEPOSIT_EVER)

    await time.increase(24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(6000))
    await time.increase(60 * 60)

    const { gasUsed: firstOpenGasUsed, positionUnits: positionUnits1 } = await openPositionAndValidate(
      this.state,
      5000,
      alice,
    )
    print('first open', firstOpenGasUsed.div(GAS_PRICE).toString())
    expect(firstOpenGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FIRST_OPEN_EVER)

    await time.increase(60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(7000))
    await time.increase(60 * 60)

    const { gasUsed: mergeGasUsed, positionUnits: positionUnits2 } = await openPositionAndValidate(
      this.state,
      3000,
      alice,
    )
    print('merge', mergeGasUsed.div(GAS_PRICE).toString())
    expect(mergeGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_MERGE)

    const { gasUsed: openGasUsed, positionUnits: positionUnitsCarol } = await openPositionAndValidate(
      this.state,
      3000,
      carol,
    )
    print('open', openGasUsed.div(GAS_PRICE).toString())
    expect(openGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_OPEN)

    let positionUnits = positionUnits2

    await time.increase(60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))
    await time.increase(60 * 60)

    await time.increase(3 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))
    const { gasUsed: partialCloseGasUsed } = await closePositionAndValidate(
      this.state,
      positionUnits.div(new BN(2)),
      alice,
    )
    print('partial close', partialCloseGasUsed.div(GAS_PRICE).toString())
    expect(partialCloseGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_PARTIAL_CLOSE)

    positionUnits = positionUnits.sub(positionUnits.div(new BN(2)))
    await time.increase(24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))
    const { gasUsed: fullCloseGasUsed } = await closePositionAndValidate(this.state, positionUnits, alice)
    print('full close', fullCloseGasUsed.div(GAS_PRICE).toString())
    expect(fullCloseGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FULL_CLOSE)

    await time.increase(3 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))
    const { gasUsed: partialWithdrawGasUsed } = await withdrawAndValidate(this.state, 10000, bob)
    print('partial withdraw', partialWithdrawGasUsed.div(GAS_PRICE).toString())
    expect(partialWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_PARTIAL_WITHDRAW)

    await time.increase(24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))
    const { gasUsed: depositGasUsed } = await depositAndValidate(this.state, 10000, bob)
    print('deposit', depositGasUsed.div(GAS_PRICE).toString())
    expect(depositGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_DEPOSIT)

    await time.increase(3 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))

    await closePositionAndValidate(this.state, positionUnitsCarol, carol)

    const tokensLeft = await getAccountBalance(this.platform.address)
    const { gasUsed: fullWithdrawGasUsed } = await withdrawAndValidate(this.state, tokensLeft, bob)
    print('full withdraw', fullWithdrawGasUsed.div(GAS_PRICE).toString())
    expect(fullWithdrawGasUsed.div(GAS_PRICE)).to.be.bignumber.at.most(MAX_GAS_FULL_WITHDRAW)
  })

  it('opens a position properly', async () => {
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(24 * 24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await depositAndValidate(this.state, 30000, bob)
    await time.increase(24 * 24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await openPositionAndValidate(this.state, 5000, alice)
  })

  for (let margin of MARGINS_TO_TEST) {
    it(`opens a margined position properly with premium fee (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, 5000 * margin * 2 - 5000 * (margin - 1) - 5000, bob)
      await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`opens a margined position properly without premium fee (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob)
      await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`merges a margined position properly with premium fee (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob)
      await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin)
      await time.increase(SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(12000))
      await openPositionAndValidate(this.state, 2500, alice, undefined, undefined, margin)
      await time.increase(SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await openPositionAndValidate(this.state, 2000, alice, undefined, undefined, margin)
      await time.increase(SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(13000))
      await openPositionAndValidate(this.state, 500, alice, undefined, undefined, margin)
    })

    it(`liquidates a negative balance margined position on merge properly (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      await openPositionAndValidate(this.state, toTokenAmount(2), alice, undefined, undefined, margin)

      const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 11000, true)
      await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation))

      await this.fakePriceProvider.setPrice(toCVI(11000))
      await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin, true)
    })

    it(`does not liquidates a liquidable positive balance position on merge (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      await openPositionAndValidate(this.state, toTokenAmount(2), alice, undefined, undefined, margin)

      const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 11000)
      await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation))

      await this.fakePriceProvider.setPrice(toCVI(11000))
      await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`closes a margined position properly, cvi rises (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob)
      const { positionUnits } = await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin)
      await time.increase(SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(13000))
      await closePositionAndValidate(this.state, positionUnits, alice)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`closes a margined position properly, cvi drops (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob)
      const { positionUnits } = await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin)
      await time.increase(SECONDS_PER_DAY)
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await closePositionAndValidate(this.state, positionUnits, alice)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`closes part of a margined position properly (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, (5000 * margin * 2 - 5000 * (margin - 1) - 5000) * 2, bob)
      const { positionUnits } = await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, margin)
      await time.increase(24 * 60 * 60)
      await closePositionAndValidate(this.state, positionUnits.div(new BN(3)), alice)
      await time.increase(24 * 60 * 60)
      await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice)
    })
  }

  it('opens multiple margined positioned together with different margins, including premium fee', async () => {
    await this.fakePriceProvider.setPrice(toCVI(11000))
    await depositAndValidate(this.state, 110000, bob)
    await openPositionAndValidate(this.state, 5000, alice, undefined, undefined, 1)
    await openPositionAndValidate(this.state, 15000, dave, undefined, undefined, 8)
    await openPositionAndValidate(this.state, 15000, carol, undefined, undefined, 4)
  })

  const positionForCollateral = (deposit, positionUnits, collateral) => {
    // (deposit + position) / (positionUnits + position * 2) = collateral / MAX_FEE
    // position = (deposit * MAX_FEE - collateral * positionUnits) / (2 * collateral - MAX_FEE)

    return deposit.mul(MAX_FEE).sub(collateral.mul(positionUnits)).div(toBN(2).mul(collateral).sub(MAX_FEE))
  }

  const testPremiumFeeByMerge = async (margin, firstDelta, secondDelta) => {
    await this.fakePriceProvider.setPrice(toCVI(11000))

    let deposit = toTokenAmount(5)
    const positionUnits = toBN(0)

    await depositAndValidate(this.state, deposit, bob)

    const position = getPositionAmountByDeltaCollateral(firstDelta, deposit, 11000).div(toBN(margin))
    const { premiumPercentage } = await openPositionAndValidate(
      this.state,
      position,
      alice,
      undefined,
      undefined,
      margin,
    )

    expect(premiumPercentage).to.be.bignumber.equal(toBN(0))

    await time.increase(SECONDS_PER_HOUR.mul(toBN(2)))

    const position2 = getPositionAmountByDeltaCollateral(secondDelta, deposit, 11000).div(toBN(margin))
    const { premiumPercentage: premiumPercentage2 } = await openPositionAndValidate(
      this.state,
      position2,
      alice,
      undefined,
      undefined,
      margin,
    )

    expect(premiumPercentage2).to.be.bignumber.above(toBN(0))
  }

  //TODO: Udnerstand these tests and what they should have tested....
  for (let margin of MARGINS_TO_TEST) {
    it.skip(`calculates premium fee correctly by collateral ratio (margin = ${margin})`, async () => {
      await testPremiumFeeByMerge(margin, 6500, 2000)
    })

    it.skip(`calculates premium fee correctly by part that passed collateral ratio (margin = ${margin})`, async () => {
      await testPremiumFeeByMerge(margin, 5000, 3000)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`liquidates positions due to cvi drop (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin)
      await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin)

      const liquidationCVI = await calculateLiquidationCVI(this.state, alice)
      const carolLiquidationCVI = await calculateLiquidationCVI(this.state, carol)

      await this.fakePriceProvider.setPrice(toCVI(liquidationCVI))

      await liquidateAndValidate(this.state, [alice], dave, true)

      await this.fakePriceProvider.setPrice(toCVI(carolLiquidationCVI))

      await liquidateAndValidate(this.state, [carol], dave, true)
    })

    it(`liquidates multiple positions at once due to cvi drop (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await depositAndValidate(this.state, 50000, bob)
      await openPositionAndValidate(this.state, 1000, alice, undefined, undefined, margin)
      await openPositionAndValidate(this.state, 2000, carol, undefined, undefined, margin)

      let liquidationCVI = await calculateLiquidationCVI(this.state, alice)
      const carolLiquidationCVI = await calculateLiquidationCVI(this.state, carol)

      if (carolLiquidationCVI.lt(liquidationCVI)) {
        liquidationCVI = carolLiquidationCVI
      }

      await this.fakePriceProvider.setPrice(toCVI(liquidationCVI))

      await liquidateAndValidate(this.state, [alice, carol], dave, true)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`does not liquidates positions due to nearly enough cvi drop (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, 50000, bob)
      await openPositionAndValidate(this.state, 1000, alice, undefined, undefined, margin)

      const liquidationCVI = (await calculateLiquidationCVI(this.state, alice)).add(new BN(100))

      await this.fakePriceProvider.setPrice(toCVI(liquidationCVI))
      await liquidateAndValidate(this.state, [alice], carol, false)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`liquidates position due to funding fees (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin)
      await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin)

      const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000)
      const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000)

      expect(daysToLiquidation).to.be.bignumber.equal(carolDaysToLiquidation)

      await time.increase(daysToLiquidation.sub(new BN(1)).mul(SECONDS_PER_DAY))

      await this.fakePriceProvider.setPrice(toCVI(10000))
      await liquidateAndValidate(this.state, [alice], dave, false)
      await liquidateAndValidate(this.state, [carol], dave, false)

      await time.increase(new BN(3600 * 24))
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await liquidateAndValidate(this.state, [alice], dave, true)
      await liquidateAndValidate(this.state, [carol], dave, true)
    })

    it(`liquidates only liquidable positions from accounts list due to funding fees (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, margin)
      await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, margin)

      const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000)
      const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000)

      expect(daysToLiquidation).to.be.bignumber.equal(carolDaysToLiquidation)

      await time.increase(daysToLiquidation.sub(new BN(1)).mul(SECONDS_PER_DAY))

      await this.fakePriceProvider.setPrice(toCVI(10000))
      await openPositionAndValidate(this.state, toTokenAmount(3), eve, undefined, undefined, margin)
      await expectRevert(
        liquidateAndValidate(this.state, [alice, carol], dave, [false, false]),
        'No liquidable position',
      )

      await time.increase(new BN(3600 * 24))
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await liquidateAndValidate(this.state, [alice, carol, eve], dave, [true, true, false])
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`liquidates a negative balance position on full or partial close (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      const { positionUnits } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1),
        alice,
        undefined,
        undefined,
        margin,
      )
      const { positionUnits: positionUnitsCarol } = await openPositionAndValidate(
        this.state,
        toTokenAmount(2),
        carol,
        undefined,
        undefined,
        margin,
      )

      const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000, true)
      const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000, true)

      expect(daysToLiquidation).to.be.bignumber.equal(carolDaysToLiquidation)
      await time.increase(daysToLiquidation.mul(SECONDS_PER_DAY))

      await this.fakePriceProvider.setPrice(toCVI(10000))
      await closePositionAndValidate(this.state, positionUnits, alice, true)
      await closePositionAndValidate(this.state, positionUnits.div(toBN(2)), carol, true)
    })

    it(`does not liquidates a liquidable positive balance position on close (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      const { positionUnits } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1),
        alice,
        undefined,
        undefined,
        margin,
      )

      const daysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000, false)

      await time.increase(daysToLiquidation.mul(SECONDS_PER_DAY))

      await this.fakePriceProvider.setPrice(toCVI(10000))
      await closePositionAndValidate(this.state, positionUnits, alice)
    })
  }

  it('liquidates margined positions sooner', async () => {
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await depositAndValidate(this.state, toTokenAmount(50), bob)
    await openPositionAndValidate(this.state, toTokenAmount(1), alice, undefined, undefined, 4)
    await openPositionAndValidate(this.state, toTokenAmount(2), carol, undefined, undefined, 2)
    await openPositionAndValidate(this.state, toTokenAmount(2), eve, undefined, undefined, 1)

    const aliceDaysToLiquidation = await calculateLiquidationDays(this.state, alice, 10000)
    const carolDaysToLiquidation = await calculateLiquidationDays(this.state, carol, 10000)
    const eveDaysToLiquidation = await calculateLiquidationDays(this.state, eve, 10000)

    expect(carolDaysToLiquidation).to.be.bignumber.at.least(aliceDaysToLiquidation)
    expect(eveDaysToLiquidation).to.be.bignumber.at.least(carolDaysToLiquidation)

    await time.increase(aliceDaysToLiquidation.sub(new BN(1)).mul(SECONDS_PER_DAY))

    await this.fakePriceProvider.setPrice(toCVI(10000))

    await liquidateAndValidate(this.state, [alice], dave, false)
    await liquidateAndValidate(this.state, [carol], dave, false)
    await liquidateAndValidate(this.state, [eve], dave, false)

    await time.increase(SECONDS_PER_DAY)
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await liquidateAndValidate(this.state, [alice], dave, true)
    await liquidateAndValidate(this.state, [carol], dave, false)
    await liquidateAndValidate(this.state, [eve], dave, false)

    await time.increase(carolDaysToLiquidation.sub(aliceDaysToLiquidation).sub(new BN(1)).mul(SECONDS_PER_DAY))
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await liquidateAndValidate(this.state, [carol], dave, false)
    await liquidateAndValidate(this.state, [eve], dave, false)

    await time.increase(SECONDS_PER_DAY)
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await liquidateAndValidate(this.state, [carol], dave, true)
    await liquidateAndValidate(this.state, [eve], dave, false)

    await time.increase(eveDaysToLiquidation.sub(carolDaysToLiquidation).sub(new BN(1)).mul(SECONDS_PER_DAY))
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await liquidateAndValidate(this.state, [eve], dave, false)

    await time.increase(SECONDS_PER_DAY)
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await liquidateAndValidate(this.state, [eve], dave, true)
  })

  it('LPs dont lose from margin debt calculation', async () => {
    await this.platform.setLockupPeriods(0, 0, { from: admin })

    await this.fakePriceProvider.setPrice(toCVI(5000))

    await depositAndValidate(this.state, 5000 * 2 * 2 * 100, carol) // Multiply by 100 to prevent volume fee on open

    const beforeBobBalance = await getAccountBalance(bob)
    const beforeDaveBalance = await getAccountBalance(dave)

    let bobGasUsed = new BN(0)
    let daveGasUsed = new BN(0)

    const bobDeposit = new BN(5000 * 2 * 2)
    const daveDeposit = new BN(10000 * 2 * 2)

    const { gasUsed: bobDepositGas } = await depositAndValidate(this.state, bobDeposit, bob)
    const { gasUsed: daveDepositGas } = await depositAndValidate(this.state, daveDeposit, dave)

    bobGasUsed = bobGasUsed.add(bobDepositGas)
    daveGasUsed = daveGasUsed.add(daveDepositGas)

    await openPositionAndValidate(this.state, 5000, alice, 2)

    const bobLPTokensBalance = await this.platform.balanceOf(bob)
    const daveLPTokensBalance = await this.platform.balanceOf(dave)

    const { gasUsed: bobWithdrawGas } = await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance)
    const { gasUsed: daveWithdrawGas } = await withdrawAndValidate(this.state, 0, dave, daveLPTokensBalance)

    bobGasUsed = bobGasUsed.add(bobWithdrawGas)
    daveGasUsed = daveGasUsed.add(daveWithdrawGas)

    const afterWithdrawBobBalance = await getAccountBalance(bob)
    const afterWithdrawDaveBalance = await getAccountBalance(dave)

    const maxReasonableFundingFeesGain = new BN(10)

    if (this.isETH) {
      expect(beforeBobBalance.sub(afterWithdrawBobBalance)).to.be.bignumber.at.least(
        bobGasUsed.sub(maxReasonableFundingFeesGain),
      )
      expect(beforeDaveBalance.sub(afterWithdrawDaveBalance)).to.be.bignumber.at.least(
        daveGasUsed.sub(maxReasonableFundingFeesGain),
      )

      expect(beforeBobBalance.sub(afterWithdrawBobBalance)).to.be.bignumber.at.most(bobGasUsed)
      expect(beforeDaveBalance.sub(afterWithdrawDaveBalance)).to.be.bignumber.at.most(daveGasUsed)
    } else {
      expect(afterWithdrawBobBalance.sub(bobDeposit)).to.be.bignumber.at.most(maxReasonableFundingFeesGain)
      expect(afterWithdrawDaveBalance.sub(daveDeposit)).to.be.bignumber.at.most(maxReasonableFundingFeesGain)

      expect(afterWithdrawBobBalance.sub(bobDeposit)).to.be.bignumber.at.least(new BN(0))
      expect(afterWithdrawDaveBalance.sub(daveDeposit)).to.be.bignumber.at.least(new BN(0))
    }
  })

  const testMultiplePositions = async (openFees, closeFees) => {
    if (openFees !== undefined) {
      this.feesCalculator.setOpenPositionFee(openFees, { from: admin })
    }

    if (closeFees !== undefined) {
      this.feesCalculator.setClosePositionFee(closeFees, { from: admin })
    }

    await depositAndValidate(this.state, 60000, bob)
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(this.state, 5000, alice)
    await time.increase(SECONDS_PER_DAY * 2)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await closePositionAndValidate(this.state, positionUnits1, alice)
    const { positionUnits: positionUnits2 } = await openPositionAndValidate(this.state, 4000, alice)
    await time.increase(SECONDS_PER_DAY * 2)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await closePositionAndValidate(this.state, positionUnits2, alice)

    await openPositionAndValidate(this.state, 3000, alice)
    await openPositionAndValidate(this.state, 1000, alice)
  }

  it('opens multiple positions and closes them, but gets reward correctly on last open and merge afterwards', async () => {
    await testMultiplePositions()
  })

  it('opens multiple positions and closes them with different open fee and no close fees', async () => {
    await testMultiplePositions(40, 0)
  })

  it('opens multiple positions and closes them with no open fees and different close fees', async () => {
    await testMultiplePositions(0, 40)
  })

  it('opens multiple positions and closes them with different no open fees and no close fees', async () => {
    await testMultiplePositions(0, 0)
  })

  it('opens multiple positions and closes them with different non default open fees and close fees', async () => {
    await testMultiplePositions(40, 50)
  })

  it.skip('opens a position properly with rewards', async () => {
    await setRewards(ZERO_ADDRESS, { from: admin })

    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(24 * 24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await depositAndValidate(this.state, 30000, bob)
    await time.increase(24 * 24 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await openPositionAndValidate(this.state, 5000, alice, false)
  })

  it('merges a position properly', async () => {
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await depositAndValidate(this.state, 60000, bob)
    await openPositionAndValidate(this.state, 5000, alice)

    // To avoid turbulence
    await time.increase(60 * 60)

    await this.fakePriceProvider.setPrice(toCVI(6000))
    await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(7000))
    await time.increase(60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(8000))

    await openPositionAndValidate(this.state, 1000, alice)
  })

  it('merges a position properly with premium fee', async () => {
    await this.fakePriceProvider.setPrice(toCVI(11000))
    await depositAndValidate(this.state, 60000, bob)
    await openPositionAndValidate(this.state, 10000, alice)

    await openPositionAndValidate(this.state, 10000, alice)

    await openPositionAndValidate(this.state, 10000, alice)
  })

  it('merges a position with less position units after merge properly', async () => {
    await this.fakePriceProvider.setPrice(toCVI(11000))
    await depositAndValidate(this.state, toTokenAmount(6), bob)
    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice)

    await time.increase(SECONDS_PER_DAY * 2)
    await this.fakePriceProvider.setPrice(toCVI(11000))

    const { positionUnits: positionUnits2, positionUnitsAdded } = await openPositionAndValidate(
      this.state,
      5000000000,
      alice,
    )

    expect(positionUnits2).to.be.bignumber.below(positionUnits)
    expect(positionUnitsAdded).to.be.bignumber.equal(toBN(0))
  })

  it('cvi oracle truncates to max value', async () => {
    const cvi = getContracts().maxCVIValue.toNumber() + 1
    await this.fakePriceProvider.setPrice(toCVI(cvi))

    expect((await this.fakeOracle.getCVILatestRoundData()).cviValue).to.be.bignumber.equal(getContracts().maxCVIValue)
  })

  it('reverts when trying to close too many positional units', async () => {
    await this.fakePriceProvider.setPrice(toCVI(5000))

    await expectRevert.unspecified(this.platform.closePosition(1, 5000, { from: alice }))
    await depositAndValidate(this.state, toTokenAmount(5), bob)
    await expectRevert.unspecified(this.platform.closePosition(1, 5000, { from: alice }))
    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice)

    await time.increase(24 * 60 * 60)

    await expectRevert.unspecified(this.platform.closePosition(positionUnits.add(new BN(1)), 5000, { from: alice }))
    await closePositionAndValidate(this.state, positionUnits, alice)
  })

  it('reverts when closing zero position units', async () => {
    await depositAndValidate(this.state, 5000, bob)
    await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(24 * 60 * 60)

    await expectRevert.unspecified(closePosition(0, 5000, alice))
  })

  it('reverts when closing a position with an invalid min CVI value', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(24 * 60 * 60)

    await expectRevert.unspecified(closePosition(positionUnits, 0, alice))
    await expectRevert.unspecified(closePosition(positionUnits, getContracts().maxCVIValue.toNumber() + 1, alice))

    await closePosition(positionUnits, 5000, alice)
  })

  it('reverts when closing a position while locked', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits, timestamp } = await openPositionAndValidate(this.state, 1000, alice)

    await time.increaseTo(timestamp.add(new BN(5 * 60 * 60)))
    await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked')
    await time.increaseTo(timestamp.add(new BN(6 * 60 * 60 - 15)))
    await expectRevert(closePosition(positionUnits, 5000, alice), 'Position locked')

    await time.increaseTo(timestamp.add(new BN(6 * 60 * 60)))
    await closePosition(positionUnits, 5000, alice)
  })

  it('reverts when closing a position with CVI below min CVI', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(24 * 60 * 60)

    await this.fakePriceProvider.setPrice(toCVI(5000))

    await expectRevert(closePosition(positionUnits, 5001, alice), 'CVI too low')

    await this.fakePriceProvider.setPrice(toCVI(6000))

    await expectRevert(closePosition(positionUnits, 6001, alice), 'CVI too low')
    await closePosition(positionUnits, 6000, alice)
  })

  it('closes a position properly', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(24 * 60 * 60)

    await closePositionAndValidate(this.state, positionUnits, alice)
  })

  it('closes part of a position properly', async () => {
    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(24 * 60 * 60)

    await closePositionAndValidate(this.state, positionUnits.div(new BN(3)), alice)

    await time.increase(24 * 60 * 60)

    await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), alice)
  })

  it('updates total funding fee back to zero instead of overflowing when rounding, if position units updates to zero', async () => {
    await depositAndValidate(this.state, 5000, bob)

    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)
    await time.increase(24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))

    // Total funding fees grow here
    await depositAndValidate(this.state, 1000, bob)
    await time.increase(24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(5000))

    // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
    await closePositionAndValidate(this.state, positionUnits, alice)
  })

  it('updates total funding fee back to zero instead of overflowing when rounding on merge, if position units updates to zero', async () => {
    await this.fakePriceProvider.setPrice(toCVI(10000))
    await depositAndValidate(this.state, 5000, bob)

    await openPositionAndValidate(this.state, 1000, alice)
    await time.increase(2 * 24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(10000))

    // Total funding fees grow here
    const { positionUnits } = await openPositionAndValidate(this.state, 5, alice)
    await time.increase(24 * 60 * 60)
    await this.fakePriceProvider.setPrice(toCVI(10000))

    // And should go back to 1 here (because of rounding), so making sure they go to 0 with total position units going back to 0 as well
    await closePositionAndValidate(this.state, positionUnits, alice)

    await expect(await this.platform.totalFundingFeesAmount()).to.be.bignumber.equal(toBN(0))
  })

  //TODO: Not clear if done right after fix, should consider "grows close volume fee by massive closing of positions one after the other" instead (make sure it goes under zero)
  it('updates total funding fee back to zero instead of one when rounding, if position units updates to zero', async () => {
    await depositAndValidate(this.state, 1000, bob)

    const { positionUnits } = await openPositionAndValidate(this.state, 201, alice)
    await time.increase(96 * 59 * 59)
    await this.fakePriceProvider.setPrice(toCVI(15000))

    // Total funding fees grow here
    await depositAndValidate(this.state, 1001, bob)
    await time.increase(96 * 59 * 60)
    await this.fakePriceProvider.setPrice(toCVI(15000))

    // And should go back to 1 here (because of rounding), so making sure they go to -1 with total position units going back to 0 as well
    await closePositionAndValidate(this.state, positionUnits, alice)
  })

  const testSnapshot = async (timestamp, shouldBeZero) => {
    if (shouldBeZero) {
      expect(await this.platform.cviSnapshots(timestamp)).to.be.bignumber.equal(new BN(0))
    } else {
      expect(await this.platform.cviSnapshots(timestamp)).to.be.bignumber.not.equal(new BN(0))
    }
  }

  const testLastSnapshotRemove = async canPurgeSnapshots => {
    const { depositTimestamp: timestamp1 } = await depositAndValidate(this.state, 2000, bob)
    expect(await this.platform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0))

    await time.increase(3 * 24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(5000))

    const { timestamp: timestamp2 } = await withdrawAndValidate(this.state, 1000, bob)

    await testSnapshot(timestamp1, canPurgeSnapshots)
    expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0))

    await time.increase(1)

    const { positionUnits, timestamp: timestamp3 } = await openPositionAndValidate(this.state, 100, alice)
    await testSnapshot(timestamp2, canPurgeSnapshots)
    expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0))

    await time.increase(24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(5000))

    const { timestamp: timestamp4 } = await closePositionAndValidate(this.state, positionUnits, alice)
    expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0))
    expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0))

    await time.increase(1)

    const { depositTimestamp: timestamp5 } = await depositAndValidate(this.state, 2000, bob)
    await testSnapshot(timestamp4, canPurgeSnapshots)
    expect(await this.platform.cviSnapshots(timestamp5)).to.be.bignumber.not.equal(new BN(0))
  }

  it('deletes last snapshot only if it was not an open position snapshot', async () => {
    await testLastSnapshotRemove(true)
  })

  it('sets can purge snapshots properly', async () => {
    const beforeEmergencyWithdrawAllowed = await this.platform.emergencyWithdrawAllowed()
    await this.platform.setEmergencyParameters(beforeEmergencyWithdrawAllowed, false, { from: admin })
    const afterEmergencyWithdrawAllowed = await this.platform.emergencyWithdrawAllowed()
    expect(afterEmergencyWithdrawAllowed).to.equal(beforeEmergencyWithdrawAllowed)

    await testLastSnapshotRemove(false)

    await this.platform.setEmergencyParameters(beforeEmergencyWithdrawAllowed, true, { from: admin })
    expect(await this.platform.emergencyWithdrawAllowed()).to.equal(beforeEmergencyWithdrawAllowed)

    await testLastSnapshotRemove(true)
  })

  it('reverts when opening with a leverage higher than max', async () => {
    await this.platform.setMaxAllowedLeverage(1, { from: admin })
    await expectRevert.unspecified(openPosition(1000, 5000, bob, 1000, 2))
  })

  it.skip('sets oracle properly', async () => {})

  it.skip('sets rewards properly', async () => {})

  it.skip('sets liquidation properly', async () => {})

  it.skip('sets staking address properly', async () => {})

  it.skip('sets liquidity provider properly', async () => {})

  it('sets feesCollector properly', async () => {
    await depositAndValidate(this.state, 10000, bob)

    const anotherFakeFeesCollector = await FakeFeesCollector.new(this.tokenAddress, { from: admin })

    expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.equal(new BN(0))
    expect(await getFeesBalance(this.fakeFeesCollector)).to.be.bignumber.equal(new BN(0))

    await openPositionAndValidate(this.state, 1000, alice)

    expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.equal(new BN(0))

    const feesCollectorBalance = await getFeesBalance(this.fakeFeesCollector)
    expect(feesCollectorBalance).to.be.bignumber.not.equal(new BN(0))

    await setFeesCollector(anotherFakeFeesCollector.address, { from: admin })
    this.state.totalFeesSent = new BN(0)

    await openPositionAndValidate(this.state, 1000, alice)
    expect(await getFeesBalance(anotherFakeFeesCollector)).to.be.bignumber.not.equal(new BN(0))
    expect(await getFeesBalance(this.fakeFeesCollector)).to.be.bignumber.equal(feesCollectorBalance)
  })

  it('sets maxLeverage properly', async () => {
    await this.fakePriceProvider.setPrice(toCVI(5000))

    await this.platform.setMaxAllowedLeverage(1, { from: admin })

    if (!this.isETH) {
      await this.token.transfer(alice, 1000, { from: admin })
      await this.token.approve(this.platform.address, 10000, { from: alice })
    }

    await depositAndValidate(this.state, 30000, bob)

    expect(await this.platform.maxAllowedLeverage()).to.be.bignumber.equal(new BN(1))
    await this.platform.setMaxAllowedLeverage(new BN(8), { from: admin })
    expect(await this.platform.maxAllowedLeverage()).to.be.bignumber.equal(new BN(8))
    await expectRevert.unspecified(openPosition(1000, 5000, alice, 1000, 9))
    await openPosition(1000, 5000, alice, 1000, 8)
  })

  it.skip('sets fees calculator properly', async () => {
    // NOTE: Make sure the fees calculator change was actually done (for example: set to a new fees calculator with no open fees and see an open position charges no fees) (Amir/Vladi)

    const beforeSet = await this.platform.feesCalculator()

    await this.platform.setFeesCalculator(ZERO_ADDRESS)

    const afterSet = await this.platform.feesCalculator()
    expect(beforeSet).to.be.not.equal(afterSet)
  })

  it.skip('sets latest oracle round id properly', async () => {
    // NOTE: Make sure change was done, for example: test there is an exception because the latest round is not compatible anymore (Amir/Vladi)

    expect(await this.platform.latestOracleRoundId()).to.be.bignumber.equal(new BN(0))
    await this.platform.setLatestOracleRoundId(222)
    expect(await this.platform.latestOracleRoundId()).to.be.bignumber.equal(new BN(222))
  })

  it('sets max time allowed after latest round properly', async () => {
    await this.platform.setMaxTimeAllowedAfterLatestRound(SECONDS_PER_DAY)
    const set1 = await this.platform.maxTimeAllowedAfterLatestRound()
    expect(set1).to.be.bignumber.equal(new BN(SECONDS_PER_DAY))

    await time.increase(SECONDS_PER_DAY)

    await expectRevert(depositAndValidate(this.state, 1000, bob), 'Latest cvi too long ago')
    await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'Latest cvi too long ago')

    this.fakePriceProvider.setPrice(toCVI(11000))
    await this.platform.setMaxTimeAllowedAfterLatestRound(SECONDS_PER_DAY * 2)
    const set2 = await this.platform.maxTimeAllowedAfterLatestRound()
    expect(set2).to.be.bignumber.equal(new BN(SECONDS_PER_DAY * 2))

    await time.increase(SECONDS_PER_DAY)

    await depositAndValidate(this.state, 20000, bob)
    await openPositionAndValidate(this.state, 1000, alice)

    await time.increase(SECONDS_PER_DAY)

    await expectRevert(depositAndValidate(this.state, 1000, bob), 'Latest cvi too long ago')
    await expectRevert(openPositionAndValidate(this.state, 1000, alice), 'Latest cvi too long ago')
  })

  it('sets no lock address properly', async () => {
    await depositAndValidate(this.state, 20000, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)
    const { positionUnits: carolPositionUnits } = await openPositionAndValidate(this.state, 1000, carol)

    expect(await this.platform.noLockPositionAddresses(alice)).to.equal(false)
    expect(await this.platform.noLockPositionAddresses(carol)).to.equal(false)

    await expectRevert(closePositionAndValidate(this.state, positionUnits, alice, false, true), 'Position locked')
    await expectRevert(closePositionAndValidate(this.state, carolPositionUnits, carol, false, true), 'Position locked')

    await this.platform.setAddressSpecificParameters(alice, false, true, false, false, { from: admin })
    expect(await this.platform.noLockPositionAddresses(alice)).to.equal(true)
    expect(await this.platform.noLockPositionAddresses(carol)).to.equal(false)

    await closePositionAndValidate(this.state, positionUnits.div(toBN(2)), alice, false, true)
    await expectRevert(closePositionAndValidate(this.state, carolPositionUnits, carol, false, true), 'Position locked')

    await this.platform.setAddressSpecificParameters(alice, true, true, false, false, { from: admin })
    await this.platform.setAddressSpecificParameters(carol, false, true, false, false, { from: admin })

    await expectRevert(
      closePositionAndValidate(this.state, positionUnits.div(toBN(2)), alice, false, true),
      'Position locked',
    )
    await closePositionAndValidate(this.state, carolPositionUnits, carol, false, true)
  })

  it.skip('sets no fee allowed properly', async () => {
    // NOTE: Test no fees at all + no volume fees as well in results
    // NOTE: Test only specific address is affected

    await depositAndValidate(this.state, 20000, bob)

    expect(await this.platform.noPremiumFeeAllowedAddresses(alice)).to.equal(false)

    await expectRevert.unspecified(openPositionAndValidate(this.state, 1000, alice, true, ONLY_OPEN_FEES)) // "Not allowed"

    // NOTE: Test closing with no premium fee is not possible

    await this.platform.setAddressSpecificParameters(alice, true, true, false, { from: admin })
    expect(await this.platform.noPremiumFeeAllowedAddresses(alice)).to.equal(true)

    // NOTE: Open a big position to make sure colalteral premium fee should be charged, then check the premium fee
    // returned from openPositionAndValidate to be zero (Amir/Vladi)
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(
      this.state,
      1000,
      alice,
      true,
      ONLY_OPEN_FEES,
    )

    // NOTE: Test closing with no premium fee is possible
    // NOTE: Test setting back to false restores the exception
  })

  it('sets increase shared pool allowed properly', async () => {
    const totalLeveragedTokensAmount = await this.platform.totalLeveragedTokensAmount()
    expect(await this.platform.increaseSharedPoolAllowedAddresses(alice)).to.equal(false)

    const addAmount = toTokenAmount(1000)
    await expectRevert.unspecified(increaseSharedPool(alice, addAmount)) // "Not allowed"

    await this.platform.setAddressSpecificParameters(alice, true, false, true, { from: admin })
    expect(await this.platform.increaseSharedPoolAllowedAddresses(alice)).to.equal(true)

    await increaseSharedPool(alice, addAmount)
    await expectRevert.unspecified(increaseSharedPool(bob, addAmount)) // "Not allowed"

    const totalLeveragedTokensAmount1 = await this.platform.totalLeveragedTokensAmount()
    expect(totalLeveragedTokensAmount1).to.be.bignumber.equal(totalLeveragedTokensAmount.add(addAmount))

    await this.platform.setAddressSpecificParameters(alice, true, false, false, { from: admin })
    expect(await this.platform.increaseSharedPoolAllowedAddresses(alice)).to.equal(false)

    await expectRevert.unspecified(increaseSharedPool(alice, addAmount)) // "Not allowed"
  })

  it('sets can emergency withdraw allowed properly', async () => {
    this.fakePriceProvider.setPrice(toCVI(5000))
    await depositAndValidate(this.state, 10000, alice)
    await openPositionAndValidate(this.state, 2000, bob, true, false, 1)
    expect(await this.platform.emergencyWithdrawAllowed()).to.equal(false)

    await time.increase(3 * 24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(5000))

    await expectRevert(withdrawAndValidate(this.state, 10000, alice), 'Collateral ratio broken')
    await this.platform.setEmergencyParameters(true, false, { from: admin })
    expect(await this.platform.emergencyWithdrawAllowed()).to.equal(true)
    await withdrawAndValidate(this.state, 10000, alice)

    await depositAndValidate(this.state, 10000, alice)
    await time.increase(3 * 24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(5000))

    await this.platform.setEmergencyParameters(false, false, { from: admin })
    expect(await this.platform.emergencyWithdrawAllowed()).to.equal(false)
    await expectRevert(withdrawAndValidate(this.state, 10000, alice), 'Collateral ratio broken')
  })

  it('sets max allowed leverage properly', async () => {
    await depositAndValidate(this.state, 10000, alice)
    await this.platform.setMaxAllowedLeverage(1, { from: admin })
    const beforeLeverage = await this.platform.maxAllowedLeverage()
    expect(beforeLeverage).to.be.bignumber.equal(new BN(1))
    await expectRevert.unspecified(openPosition(1000, 5000, bob, 1000, 2))

    await this.platform.setMaxAllowedLeverage(2, { from: admin })
    const afterLeverage = await this.platform.maxAllowedLeverage()
    expect(afterLeverage).to.be.bignumber.equal(new BN(2))
    await openPositionAndValidate(this.state, 1000, bob, true, false, 2)
    await expectRevert.unspecified(openPosition(1000, 5000, carol, 1000, 3))
  })

  it('does not delete snapshot if an open occured on its block', async () => {
    const { depositTimestamp: timestamp1 } = await depositAndValidate(this.state, 2000, bob)
    const { timestamp: timestamp2 } = await openPositionAndValidate(this.state, 100, alice)

    if (timestamp1 === timestamp2) {
      expect(await this.platform.cviSnapshots(timestamp1)).to.be.bignumber.not.equal(new BN(0))
    }

    expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0))

    await time.increase(3 * 24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(5000))

    const { timestamp: timestamp4 } = await openPositionAndValidate(this.state, 100, alice)
    const { timestamp: timestamp3 } = await withdrawAndValidate(this.state, 1000, bob)

    if (timestamp3 === timestamp4) {
      expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0))
    }

    expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0))
    expect(await this.platform.cviSnapshots(timestamp3)).to.be.bignumber.not.equal(new BN(0))

    await time.increase(1)

    const { timestamp: timestamp5 } = await openPositionAndValidate(this.state, 10, alice)
    const { depositTimestamp: timestamp6 } = await depositAndValidate(this.state, 1, bob)

    if (timestamp5 === timestamp6) {
      expect(await this.platform.cviSnapshots(timestamp6)).to.be.bignumber.not.equal(new BN(0))
    }

    expect(await this.platform.cviSnapshots(timestamp2)).to.be.bignumber.not.equal(new BN(0))
    expect(await this.platform.cviSnapshots(timestamp4)).to.be.bignumber.not.equal(new BN(0))
    expect(await this.platform.cviSnapshots(timestamp5)).to.be.bignumber.not.equal(new BN(0))
  })

  //TODO: Not really on same block...
  it('runs multiple actions on same blocks properly', async () => {
    await depositAndValidate(this.state, 2000, bob)
    await depositAndValidate(this.state, 1000, alice)
    await depositAndValidate(this.state, 3000, carol)

    await time.increase(3 * 24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(15000))

    await withdrawAndValidate(this.state, 100, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 200, alice)
    await depositAndValidate(this.state, 3000, carol)

    await time.increase(3 * 24 * 60 * 60)
    this.fakePriceProvider.setPrice(toCVI(15000))

    await closePositionAndValidate(this.state, positionUnits, alice)
    await withdrawAndValidate(this.state, 3000, carol)
    await depositAndValidate(this.state, 3000, carol)
  })

  it('runs deposit/withdraw actions properly with many positions opened', async () => {
    await depositAndValidate(this.state, 30000, bob)

    await time.increase(60)

    await openPositionAndValidate(this.state, 200, bob)
    await time.increase(1)
    await openPositionAndValidate(this.state, 200, alice)
    await time.increase(1)
    await openPositionAndValidate(this.state, 200, carol)

    await time.increase(1)

    await testMultipleAccountsDepositWithdraw(new BN(0), new BN(0), false)
  })

  it('reverts when liquidating non-existing position', async () => {
    await expectRevert(this.platform.liquidatePositions([alice], { from: dave }), 'No liquidable position')
    await expectRevert(this.platform.liquidatePositions([bob, carol], { from: dave }), 'No liquidable position')
    await expectRevert(
      this.platform.liquidatePositions([alice, bob, carol, dave], { from: dave }),
      'No liquidable position',
    )
  })

  it('reverts when action attempted during lockup period - buyers', async () => {
    await this.platform.setLockupPeriods(240, SECONDS_PER_DAY, { from: admin })

    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(this.state, 1000, alice)
    await time.increase(SECONDS_PER_DAY - 10)
    await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice), 'Position locked')
    await time.increase(10)
    await closePositionAndValidate(this.state, positionUnits1, alice)
  })

  //TOOD: Add test like this that deposits, wihtdraws all and deposits again, have crashed because collateral divides zero
  // to get calculated, resolved, but need a test to make sure it doens't return
  it('sets lockup period correctly - buyers', async () => {
    await this.platform.setLockupPeriods(240, SECONDS_PER_DAY, { from: admin })
    const period1 = await this.platform.buyersLockupPeriod()
    expect(period1).to.be.bignumber.equal(new BN(SECONDS_PER_DAY))

    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(this.state, 1000, alice)
    await time.increase(SECONDS_PER_DAY - 10)
    await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice), 'Position locked')
    await time.increase(10)
    await closePositionAndValidate(this.state, positionUnits1, alice)

    await this.platform.setLockupPeriods(240, +SECONDS_PER_DAY + 100, { from: admin })
    const period2 = await this.platform.buyersLockupPeriod()
    expect(period2).to.be.bignumber.equal(new BN(+SECONDS_PER_DAY + 100))

    await this.fakePriceProvider.setPrice(toCVI(11000))

    await depositAndValidate(this.state, 5000, bob)
    const { positionUnits: positionUnits2 } = await openPositionAndValidate(this.state, 1000, alice)
    await time.increase(SECONDS_PER_DAY - 10)
    await expectRevert(closePositionAndValidate(this.state, positionUnits2, alice), 'Position locked')
    await time.increase(10)
    await expectRevert(closePositionAndValidate(this.state, positionUnits2, alice), 'Position locked')
    await time.increase(94)
    await expectRevert(closePositionAndValidate(this.state, positionUnits2, alice), 'Position locked')
    await time.increase(6)
    await closePositionAndValidate(this.state, positionUnits2, alice)
  })

  it('sets lockup period correctly - LPs', async () => {
    await this.platform.setLockupPeriods(240, 120, { from: admin })
    const period1 = await this.platform.lpsLockupPeriod()
    expect(period1).to.be.bignumber.equal(new BN(240))

    await depositAndValidate(this.state, 1000, bob)
    await time.increase(200)
    const bobLPTokensBalance = await this.platform.balanceOf(bob)
    await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance), 'Funds are locked')
    await time.increase(40)
    await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance)
    expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0))

    await this.platform.setLockupPeriods(500, 120, { from: admin })
    const period2 = await this.platform.lpsLockupPeriod()
    expect(period2).to.be.bignumber.equal(new BN(500))

    await depositAndValidate(this.state, 1000, bob)
    await time.increase(200)
    const bobLPTokensBalance2 = await this.platform.balanceOf(bob)
    await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2), 'Funds are locked')
    await time.increase(40)
    await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2), 'Funds are locked')
    await time.increase(254)
    await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2), 'Funds are locked')
    await time.increase(6)
    await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance2)
    expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0))
  })

  it('close fee decay functions properly', async () => {
    await depositAndValidate(this.state, 20000, bob)
    const { positionUnits } = await openPositionAndValidate(this.state, 1000, alice)
    const { positionUnits: positionUnitsBob } = await openPositionAndValidate(this.state, 1000, bob)
    const { positionUnits: positionUnitsCarol } = await openPositionAndValidate(this.state, 1000, carol)

    const period = await this.platform.buyersLockupPeriod()
    await time.increase(period)

    // Min decay (after lockup is over)
    await closePositionAndValidate(this.state, positionUnits, alice)

    await time.increase(CLOSE_FEE_DECAY_PERIOD.div(toBN(2)).sub(period))

    // Mid decay
    await closePositionAndValidate(this.state, positionUnitsBob, bob)

    await time.increase(CLOSE_FEE_DECAY_PERIOD.div(toBN(2)))

    // Max decay
    await closePositionAndValidate(this.state, positionUnitsCarol, carol)
  })

  it('no lock addresses do not get close decay fees but minimal close fees always', async () => {
    await depositAndValidate(this.state, 20000, bob)
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(this.state, 1000, alice)

    await this.platform.setAddressSpecificParameters(alice, false, true, false, false, { from: admin })

    const period = await this.platform.buyersLockupPeriod()
    await time.increase(period)

    // Verify min decay close fee
    const { closeFeePercentage } = await closePositionAndValidate(this.state, positionUnits1, alice, false, true)
    expect(closeFeePercentage).to.be.bignumber.equal(MIN_CLOSE_FEE)
  })

  it('does not revert when in buyers lockup period but account set as not locked', async () => {
    await depositAndValidate(this.state, 20000, bob)
    const { positionUnits: positionUnits1 } = await openPositionAndValidate(this.state, 1000, alice)
    const { positionUnits: positionUnitsCarol } = await openPositionAndValidate(this.state, 1000, carol)
    await expectRevert(closePositionAndValidate(this.state, positionUnits1, alice), 'Position locked')
    await expectRevert(closePositionAndValidate(this.state, positionUnitsCarol, carol), 'Position locked')
    await this.platform.setAddressSpecificParameters(alice, false, true, false, false, { from: admin })
    await expectRevert(closePositionAndValidate(this.state, positionUnitsCarol, carol), 'Position locked')
    await closePosition(positionUnits1, 5000, alice)

    await this.platform.setAddressSpecificParameters(alice, true, true, false, false, { from: admin })

    if (!getContracts().isETH) {
      await getContracts().token.transfer(alice, 1000, { from: admin })
      await getContracts().token.approve(getContracts().platform.address, 1000, { from: alice })
    }
    await openPosition(1000, 20000, alice)

    await expectRevert(closePosition(1, 5000, alice), 'Position locked')
  })

  it('reverts when action attempted during lockup period - LPs', async () => {
    await this.platform.setLockupPeriods(240, 120, { from: admin })

    await depositAndValidate(this.state, 1000, bob)
    await time.increase(200)
    const bobLPTokensBalance = await this.platform.balanceOf(bob)
    await expectRevert(withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance), 'Funds are locked')
    await time.increase(40)
    await withdrawAndValidate(this.state, 0, bob, bobLPTokensBalance)
    expect(await this.platform.balanceOf(bob)).to.be.bignumber.equal(new BN(0))
  })

  it('reverts when attempting to execute an ownable function by non admin user', async () => {
    const expectedError = 'Ownable: caller is not the owner'

    // Tests setSubContracts
    await expectRevert(setFeesCalculator(this.feesCalculator.address, { from: bob }), expectedError)

    await expectRevert(this.platform.setEmergencyParameters(false, false, { from: alice }), expectedError)
    await expectRevert(this.platform.setMaxAllowedLeverage(new BN(8), { from: dave }), expectedError)
    await expectRevert(this.platform.setLockupPeriods(60 * 60 * 24, 24 * 60 * 60, { from: dave }), expectedError)
    await expectRevert(
      this.platform.setAddressSpecificParameters(bob, false, true, true, false, { from: carol }),
      expectedError,
    )
    await expectRevert(this.platform.setLatestOracleRoundId(2, { from: dave }), expectedError)
    await expectRevert(
      this.platform.setSubContracts(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, {
        from: dave,
      }),
      expectedError,
    )
    await expectRevert(this.platform.setMaxTimeAllowedAfterLatestRound(2, { from: dave }), expectedError)

    const staking = await StakingRewards.new(admin, admin, this.cviToken.address, this.platform.address)
    await expectRevert(setStakingContractAddress(staking.address, { from: bob }), expectedError)
  })

  it('reverts when trying to get balance/funding fees with addendum of a non-existing position', async () => {
    await expectRevert.unspecified(this.platform.calculatePositionBalance(bob))
    await expectRevert.unspecified(this.platform.calculatePositionBalance(alice))
    await expectRevert.unspecified(this.platform.calculatePositionPendingFees(bob, 0))
    await expectRevert.unspecified(this.platform.calculatePositionPendingFees(alice, 0))
  })

  it('reverts when trying to get balance/funding fees with addendum of an already-closed position', async () => {
    await depositAndValidate(this.state, toTokenAmount(5), bob)
    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice)

    await time.increase(SECONDS_PER_DAY * 3)

    await closePositionAndValidate(this.state, positionUnits, alice)

    await expectRevert.unspecified(this.platform.calculatePositionBalance(alice))
    await expectRevert.unspecified(this.platform.calculatePositionPendingFees(alice, positionUnits))
  })

  it("reverts when trying to get funding fees with addendum for more than position's position units", async () => {
    await depositAndValidate(this.state, toTokenAmount(5), bob)
    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1), alice)

    await this.platform.calculatePositionPendingFees(alice, toBN(0))
    await this.platform.calculatePositionPendingFees(alice, positionUnits.div(toBN(2)))
    await this.platform.calculatePositionPendingFees(alice, positionUnits)
    await expectRevert.unspecified(this.platform.calculatePositionPendingFees(alice, positionUnits.add(toBN(1))))
  })

  it.skip('deposit gets initial rate when balance is zero, not on first deposit', async () => {
    // Set funding fees to zero
    // Deposit liquidity
    // Open positions
    // Set CVI to max
    // Deposit another liqudiity and get initial rate (balance is exactly zero)
  })

  const verifyPendingFees = async (account, positionUnits) => {
    const pendingFees = await this.platform.calculatePositionPendingFees(account, positionUnits)
    const { snapshot: pendingFeesSnapshot } = await updateSnapshots(this.state, false)

    const feesUpToLatestSnapshot = calculateFundingFeesWithSnapshot(
      this.state,
      this.state.snapshots[this.state.latestSnapshotTimestamp],
      account,
      positionUnits,
    )

    const feesFromLatestSnapshot = calculateFundingFeesWithTwoSnapshots(
      this.state.snapshots[this.state.latestSnapshotTimestamp],
      pendingFeesSnapshot,
      positionUnits,
    )
    const expectedPendingFees = feesUpToLatestSnapshot.add(feesFromLatestSnapshot)

    expect(pendingFees).to.be.bignumber.equal(expectedPendingFees)
  }

  const verifyBalance = async (account, isPositive = true) => {
    const result = await this.platform.calculatePositionBalance(account)
    const { latestTimestamp: timestamp, snapshot } = await updateSnapshots(this.state, false)

    expect(result.isPositive).to.equal(isPositive)
    expect(result.positionUnitsAmount).to.be.bignumber.equal(this.state.positions[account].positionUnitsAmount)
    expect(result.leverage).to.be.bignumber.equal(this.state.positions[account].leverage)

    const fundingFees = calculateFundingFeesWithSnapshot(
      this.state,
      snapshot,
      account,
      this.state.positions[account].positionUnitsAmount,
    )
    expect(result.fundingFees).to.be.bignumber.equal(fundingFees)

    const marginDebt = calculateMarginDebt(this.state, account)
    expect(result.marginDebt).to.be.bignumber.equal(marginDebt)

    const positionBalance = await calculatePositionBalance(this.state.positions[account].positionUnitsAmount)
    expect(result.currentPositionBalance).to.be.bignumber.equal(
      isPositive ? positionBalance.sub(fundingFees).sub(marginDebt) : fundingFees.add(marginDebt).sub(positionBalance),
    )
  }

  const verifyTotalBalance = async () => {
    const result = await this.platform.totalBalance(true)
    const { totalFundingFees: addendumFundingFees } = await updateSnapshots(this.state, false)

    const totalBalance = await calculateBalance(this.state, addendumFundingFees)
    expect(result).to.be.bignumber.equal(totalBalance)
  }

  it('calculates latest turbulence indicator percent properly', async () => {
    await depositAndValidate(this.state, 40000, bob)

    // Cause turbulence
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(6000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(7000))
    await time.increase(1)

    // Causes snapshot
    await openPositionAndValidate(this.state, 1000, alice)

    expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(300))

    await time.increase(SECONDS_PER_HOUR)

    expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(300))

    await this.fakePriceProvider.setPrice(toCVI(6000)) // Turbulence drops to 150
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(5000)) // Rises to 250
    await time.increase(1)

    expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(250))

    await this.fakePriceProvider.setPrice(toCVI(6000)) // Rises to 350
    await time.increase(1)

    expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(350))

    await this.fakePriceProvider.setPrice(toCVI(7000)) // Rises to 350
    await time.increase(1)

    // Should be 0 as there are 3 rounds and deviation si not enough
    expect(await this.platform.calculateLatestTurbulenceIndicatorPercent()).to.be.bignumber.equal(toBN(0))
  })

  for (let margin of MARGINS_TO_TEST) {
    it(`calculates all addendum view functions results properly (margin = ${margin})`, async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toTokenAmount(50), bob)
      await openPositionAndValidate(this.state, toTokenAmount(2), alice, undefined, undefined, margin)
      await openPositionAndValidate(this.state, toTokenAmount(1), carol, undefined, undefined, margin)

      await verifyBalance(alice)
      await verifyBalance(carol)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)))
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount)
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)))
      await verifyTotalBalance()

      await time.increase(7 * SECONDS_PER_DAY)

      await this.fakePriceProvider.setPrice(toCVI(10000))

      await time.increase(7 * SECONDS_PER_DAY)
      await verifyBalance(alice)
      await verifyBalance(carol)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)))
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount)
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)))
      await verifyTotalBalance()

      await time.increase(24 * 60 * 60)

      await this.fakePriceProvider.setPrice(toCVI(9500))
      await verifyBalance(alice)
      await verifyBalance(carol)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)))
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount)
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)))
      await verifyTotalBalance()

      const daysToNegativeBalance = await calculateLiquidationDays(this.state, alice, 9500, true)

      await time.increase(daysToNegativeBalance.mul(SECONDS_PER_DAY))

      await verifyBalance(alice, false)
      await verifyBalance(carol, false)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount)
      await verifyPendingFees(alice, this.state.positions[alice].positionUnitsAmount.div(toBN(3)))
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount)
      await verifyPendingFees(carol, this.state.positions[carol].positionUnitsAmount.div(toBN(3)))
      await verifyTotalBalance()
    })
  }
}

describe.only('Platform', () => {
  console.log(`start time`, process.uptime())
  beforeEach(async () => {
    await beforeEachPlatform(false)
    await deployPlatformHelper(ZERO_ADDRESS, ZERO_ADDRESS)
  })

  setPlatformTests(false)
})
