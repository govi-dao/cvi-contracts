/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, time, BN } = require('@openzeppelin/test-helpers')

const { print } = require('./utils/DebugUtils')
const chai = require('chai')

const FakePlatform = artifacts.require('FakePlatform')

const expect = chai.expect

const { toTokenAmount, toUSD, toBN, toCVI } = require('./utils/BNUtils.js')
const {
  deployFullPlatform,
  getContracts,
  getAccounts,
  setRewards,
  setupLiquidityProviders,
  ZERO_ADDRESS,
} = require('./utils/DeployUtils')
const {
  createState,
  depositAndValidate,
  openPositionAndValidate,
  closePositionAndValidate,
} = require('./utils/PlatformUtils')

const CVI_VALUE = 11000
const MAX_FEE = 10000
const DAILY_REWARD = toBN(2300, 18)
const MAX_SINGLE_REWARD = toBN(800, 18)
const PRECISION_DECIMALS = toBN(1, 10)

const SECONDS_PER_DAY = 24 * 60 * 60

const MAX_REWARD_TIME = new BN(SECONDS_PER_DAY * 3)
const MAX_LINEAR_POSITION_UNITS = toBN(20, 18)
const MAX_LINEAR_GOVI = toBN(100, 18)
const MAX_TIME_PERCENTAGE_GAIN = toBN(25, 8)

const FACTOR_REWARD = toBN(1, 13)
const LEVERAGE = new BN(1)

const MARGINS_TO_TEST = [1, 2, 3, 4, 5, 6, 7, 8]

let admin, bob, alice, carol, dave
let accountsUsed

const setAccounts = async () => {
  ;[admin, bob, alice, carol, dave] = await getAccounts()
  accountsUsed = [admin, bob, alice, carol, dave]
}

const calculateReward = (
  positionUnits,
  timePassed,
  maxLinearPositionUnits = MAX_LINEAR_POSITION_UNITS,
  maxLinearGOVI = MAX_LINEAR_GOVI,
  maxSingleReward = MAX_SINGLE_REWARD,
  maxRewardTime = MAX_REWARD_TIME,
  maxTimePercentageGain = MAX_TIME_PERCENTAGE_GAIN,
  factorReward = FACTOR_REWARD,
) => {
  const x0 = maxLinearPositionUnits
  const y0 = maxLinearGOVI.div(factorReward)
  const singleReward = maxSingleReward.div(factorReward)

  const factoredPU = positionUnits
    .mul(PRECISION_DECIMALS.add(timePassed.mul(maxTimePercentageGain).div(maxRewardTime)))
    .div(PRECISION_DECIMALS)

  if (factoredPU.lte(x0)) {
    return factoredPU.mul(y0).div(x0).mul(factorReward)
  }

  const two = new BN(2)

  const beta = singleReward.mul(x0).div(y0)
  const alpha = two.mul(singleReward.pow(two)).mul(beta).mul(x0).div(y0)
  const gamma = two.mul(singleReward).mul(beta).mul(x0).div(y0).sub(beta.pow(two))
  const reward = singleReward.sub(alpha.div(factoredPU.add(beta).pow(two).add(gamma)))

  return reward.mul(factorReward)
}

const claimAndValidate = async (
  account,
  positionUnits,
  positionTimestamp,
  maxLinearPositionUnits,
  maxLinearGovi,
  maxSingleReward,
  maxRewardTime,
  maxTimePercentageGain,
  factorReward,
) => {
  const beforeCVIAmount = await this.cviToken.balanceOf(account)
  const beforeClaimedRewards = await this.rewards.todayClaimedRewards()
  const lastDay = await this.rewards.lastClaimedDay()

  await this.rewards.claimReward({ from: account })

  const claimTime = await time.latest()
  const today = claimTime.div(new BN(SECONDS_PER_DAY))

  let timePassed = claimTime.sub(positionTimestamp)
  if (timePassed.toNumber() > MAX_REWARD_TIME.toNumber()) {
    timePassed = MAX_REWARD_TIME
  }

  const reward = calculateReward(
    positionUnits,
    timePassed,
    maxLinearPositionUnits,
    maxLinearGovi,
    maxSingleReward,
    maxRewardTime,
    maxTimePercentageGain,
    factorReward,
  )
  const afterCVIAmount = await this.cviToken.balanceOf(account)
  const afterClaimedRewards = await this.rewards.todayClaimedRewards()

  expect(afterCVIAmount.sub(beforeCVIAmount)).to.be.bignumber.equal(reward)
  expect(await this.rewards.lastClaimedDay()).to.be.bignumber.equal(today)

  if (lastDay.toNumber() < today.toNumber()) {
    expect(afterClaimedRewards).to.be.bignumber.equal(reward)
  } else {
    expect(afterClaimedRewards.sub(beforeClaimedRewards)).to.be.bignumber.equal(reward)
  }

  return reward
}

const transferRewardTokens = async amount => {
  await this.cviToken.transfer(this.rewards.address, amount, { from: admin })
}

const setPlatform = () => this.rewards.setPlatform(this.platform.address, { from: admin })

const depositToPlatform = async amount => {
  await depositAndValidate(this.state, amount, admin)
}

const rewardAndValidate = async (
  account,
  tokensAmount,
  maxLinearPositionUnits,
  maxLinearGovi,
  maxSingleReward,
  maxRewardTime,
  maxTimePercentageGain,
  factorReward,
) => {
  let today = await getToday()

  const result = await this.platform.positions(account)
  const oldPositionUnits = result.positionUnitsAmount
  const originalCreationTimestamp = result.originalCreationTimestamp

  if (oldPositionUnits.gt(toBN(0))) {
    today = originalCreationTimestamp.div(toBN(SECONDS_PER_DAY))
  }

  const beforeRewardAmount = await this.rewards.claimedPositionUnits(account, today)
  this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
  const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
    this.state,
    tokensAmount,
    account,
  )

  await time.increase(SECONDS_PER_DAY)
  const reward = await claimAndValidate(
    account,
    positionUnits,
    positionTimestamp,
    maxLinearPositionUnits,
    maxLinearGovi,
    maxSingleReward,
    maxRewardTime,
    maxTimePercentageGain,
    factorReward,
  )

  const afterRewardAmount = await this.rewards.claimedPositionUnits(account, today)
  expect(afterRewardAmount.sub(beforeRewardAmount)).to.be.bignumber.equal(
    positionUnits.lt(oldPositionUnits) ? new BN(0) : positionUnits.sub(oldPositionUnits),
  )

  return reward
}

const getToday = async () => {
  return (await time.latest()).div(new BN(SECONDS_PER_DAY))
}

describe('PositionRewards', () => {
  beforeEach(async () => {
    await setAccounts()
    await deployFullPlatform(false)
    await setupLiquidityProviders(accountsUsed)

    this.cviToken = getContracts().cviToken
    this.token = getContracts().token
    this.rewards = getContracts().rewards
    this.platform = getContracts().platform
    this.fakePriceProvider = getContracts().fakePriceProvider

    await getContracts().feesCalculator.setOpenPositionFee(new BN(0), { from: admin })
    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))

    this.state = createState(accountsUsed)
  })

  it('reverts when caliming reward and platform is not set', async () => {
    await expectRevert(this.rewards.claimReward({ from: bob }), 'Platform not set')
  })

  it('reverts when claiming with no opened positions', async () => {
    await setPlatform()

    await expectRevert(this.rewards.claimReward({ from: bob }), 'No opened position')
  })

  it('reverts when claiming after position was fully closed', async () => {
    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increase(SECONDS_PER_DAY)
    await closePositionAndValidate(this.state, positionUnits, bob)

    await expectRevert(this.rewards.claimReward({ from: bob }), 'No opened position')
  })

  it('extracts left rewards properly', async () => {
    const adminGOVI = await this.cviToken.balanceOf(admin)
    await transferRewardTokens(toTokenAmount(1000000))
    const adminGOVIAfterTransfer = await this.cviToken.balanceOf(admin)

    expect(adminGOVIAfterTransfer).to.be.bignumber.not.equal(adminGOVI)
    await this.rewards.extractRewards({ from: admin })

    const adminGOVIAfterExtract = await this.cviToken.balanceOf(admin)
    expect(adminGOVIAfterExtract).to.be.bignumber.equal(adminGOVI)
  })

  it('extracts left rewards properly after claiming some of them', async () => {
    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    await transferRewardTokens(toTokenAmount(1000000))

    await rewardAndValidate(alice, toTokenAmount(1000))
    await rewardAndValidate(bob, toTokenAmount(1000))
    await rewardAndValidate(carol, toTokenAmount(1000))

    const leftGOVI = await this.cviToken.balanceOf(this.rewards.address)

    const adminGOVIBeforeExtract = await this.cviToken.balanceOf(admin)
    await this.rewards.extractRewards({ from: admin })
    const adminGOVIAfterExtract = await this.cviToken.balanceOf(admin)

    expect(adminGOVIAfterExtract.sub(adminGOVIBeforeExtract)).to.be.bignumber.equal(leftGOVI)
  })

  for (let margin of MARGINS_TO_TEST) {
    it(`claims correct amount when opening and merging positions (margin = ${margin})`, async () => {
      await setPlatform()
      await transferRewardTokens(toTokenAmount(1000000))
      await depositToPlatform(toTokenAmount(30000))

      const day = await getToday()

      const result = await this.rewards.claimedPositionUnits(bob, day)

      expect(await this.rewards.claimedPositionUnits(bob, day)).to.be.bignumber.equal(new BN(0))
      expect(await this.rewards.claimedPositionUnits(alice, day)).to.be.bignumber.equal(new BN(0))

      const { positionUnits: bobPositionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
        undefined,
        undefined,
        margin,
      )
      await openPositionAndValidate(this.state, toTokenAmount(2000), alice, undefined, undefined, margin)
      const { positionUnits: alicePositionUnits2, timestamp: positionTimestamp2 } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        alice,
        undefined,
        undefined,
        margin,
      )

      await time.increase(SECONDS_PER_DAY)

      await claimAndValidate(bob, bobPositionUnits.div(new BN(margin)), positionTimestamp)
      await claimAndValidate(alice, alicePositionUnits2.div(new BN(margin)), positionTimestamp2)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`claims correct amount after openning, closing and openning another position on the same day (margin = ${margin})`, async () => {
      await transferRewardTokens(toTokenAmount(1000000))

      await this.platform.setLockupPeriods(0, 0, { from: admin })

      await setPlatform()
      await depositToPlatform(toTokenAmount(20000))
      const { positionUnits } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
        undefined,
        undefined,
        margin,
      )
      await closePositionAndValidate(this.state, positionUnits, bob)
      const { positionUnits: positionUnits2, timestamp: positionTimestamp } = await openPositionAndValidate(
        this.state,
        toTokenAmount(2000),
        bob,
        undefined,
        undefined,
        margin,
      )

      await time.increase(SECONDS_PER_DAY)

      await claimAndValidate(bob, positionUnits2.div(new BN(margin)), positionTimestamp)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`claims correct amount after position was merged after claiming while opened (margin = ${margin})`, async () => {
      await transferRewardTokens(toTokenAmount(1000000))

      await this.platform.setLockupPeriods(0, 0, { from: admin })

      await setPlatform()
      await depositToPlatform(toTokenAmount(50000))
      const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
        undefined,
        undefined,
        margin,
      )

      await time.increase(SECONDS_PER_DAY)
      await claimAndValidate(bob, positionUnits.div(new BN(margin)), positionTimestamp)

      this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
      const { positionUnits: positionUnits2, timestamp: positionTimestamp2 } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
        undefined,
        undefined,
        margin,
      )
      await time.increase(SECONDS_PER_DAY)

      await claimAndValidate(
        bob,
        positionUnits2.div(new BN(margin)).sub(positionUnits.div(new BN(margin))),
        positionTimestamp2,
      )

      this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
      const { positionUnits: positionUnits3, timestamp: positionTimestamp3 } = await openPositionAndValidate(
        this.state,
        toTokenAmount(3000),
        bob,
        undefined,
        undefined,
        margin,
      )
      await time.increase(SECONDS_PER_DAY)

      await claimAndValidate(
        bob,
        positionUnits3.div(new BN(margin)).sub(positionUnits2.div(new BN(margin))),
        positionTimestamp3,
      )
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`claims correct amount after position was partially closed (margin = ${margin})`, async () => {
      await transferRewardTokens(toTokenAmount(1000000))

      await setPlatform()
      await depositToPlatform(toTokenAmount(10000))
      const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
        undefined,
        undefined,
        margin,
      )

      await time.increase(SECONDS_PER_DAY)
      await closePositionAndValidate(this.state, positionUnits.div(new BN(2)), bob)

      await time.increase(SECONDS_PER_DAY)

      await claimAndValidate(bob, positionUnits.div(new BN(margin)).div(new BN(2)), positionTimestamp)
    })
  }

  it('reverts when claiming too early', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { timestamp: positionTimestamp } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too early')

    const openDay = positionTimestamp.div(new BN(SECONDS_PER_DAY))
    const currTime = (await time.latest()).toNumber()
    const secondsLeftInDay = SECONDS_PER_DAY * (openDay.toNumber() + 1) - currTime
    await time.increase(new BN(secondsLeftInDay - 2))

    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too early')
  })

  it('reverts when max claim time exceeded', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { timestamp: positionTimestamp } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increaseTo(positionTimestamp.add(new BN(SECONDS_PER_DAY * 30 - 2)))
    await this.rewards.claimReward({ from: bob })

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { timestamp: positionTimestamp2 } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increaseTo(positionTimestamp2.add(new BN(SECONDS_PER_DAY * 30)))
    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too late')
  })

  it('calculates max claim time of reward amount by latest merge time', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))
    const { timestamp: positionTimestamp } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increaseTo(positionTimestamp.add(new BN(30 * SECONDS_PER_DAY + 1)))
    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too late')

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: positionUnits2, timestamp: positionTimestamp2 } = await openPositionAndValidate(
      this.state,
      toTokenAmount(2000),
      bob,
    )

    await time.increaseTo(positionTimestamp2.add(new BN(SECONDS_PER_DAY * 30 - 2)))
    await claimAndValidate(bob, positionUnits2, positionTimestamp2)
  })

  it('calculates max claim time possible by latest merge time', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))
    await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increase(30 * SECONDS_PER_DAY + 1)
    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too late')

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: positionUnits2, timestamp: positionTimestamp2 } = await openPositionAndValidate(
      this.state,
      toTokenAmount(2000),
      bob,
    )

    await time.increase(SECONDS_PER_DAY)

    await claimAndValidate(bob, positionUnits2, positionTimestamp2)

    await time.increaseTo(positionTimestamp2.add(new BN(30 * SECONDS_PER_DAY + 1)))
    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too late')
  })

  for (let margin of MARGINS_TO_TEST) {
    it(`claims correct amount when claiming (margin = ${margin})`, async () => {
      await transferRewardTokens(toTokenAmount(1000000))

      await setPlatform()
      await depositToPlatform(toTokenAmount(4000000))

      const amounts = [10, 100, 500, 1000, 5000, 10000, 20000, 25000, 30000, 40000, 50000, 100000, 500000, 1000000]
      const MAX_REWARD_PERC = 10
      for (const amount of amounts) {
        print(`Opening a position of size:${amount} USDT`)
        this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
        const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
          this.state,
          toTokenAmount(amount).div(new BN(1000)),
          bob,
          undefined,
          undefined,
          margin,
        )

        await time.increase(SECONDS_PER_DAY)

        const claimed = await claimAndValidate(bob, positionUnits.div(new BN(margin)), positionTimestamp)
        const claimedTokens = claimed.div(new BN('1000000000000000000'))
        const maxExpectedReward = new BN(amount).mul(new BN(MAX_REWARD_PERC)).div(new BN(100))
        print(
          `positionUnits:${positionUnits.toString()} maxExpected:${maxExpectedReward.toString()} claimed:${claimed.toString()} (${claimedTokens.toString()} GOVI)`,
        )
        expect(claimedTokens).to.be.bignumber.below(new BN(amount).mul(new BN(MAX_REWARD_PERC)).div(new BN(100)))
        await closePositionAndValidate(this.state, positionUnits, bob)
        print(`${amount},${Number(claimedTokens.toString())}`)
      }
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`claims correct amount based on time passed from position open (margin = ${margin})`, async () => {
      await transferRewardTokens(toTokenAmount(1000000))

      await setPlatform()
      await depositToPlatform(toTokenAmount(10000))
      const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
        undefined,
        undefined,
        margin,
      )

      await time.increase(SECONDS_PER_DAY * 1 + 60 * 60 * 4 + 60 * 15 + 30)

      await claimAndValidate(bob, positionUnits.div(new BN(margin)), positionTimestamp)
    })
  }

  for (let margin of MARGINS_TO_TEST) {
    it(`claims more if more time passes from position open (margin = ${margin})`, async () => {
      const times = [SECONDS_PER_DAY, (3 * SECONDS_PER_DAY) / 2, 2 * SECONDS_PER_DAY, (5 * SECONDS_PER_DAY) / 2]

      await transferRewardTokens(toTokenAmount(1000000))
      await setPlatform()
      await depositToPlatform(toTokenAmount(20000))

      let lastReward = new BN(0)

      for (let currTime of times) {
        this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
        const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
          this.state,
          toTokenAmount(1000),
          bob,
          undefined,
          undefined,
          margin,
        )
        await time.increase(currTime)
        const currReward = await claimAndValidate(bob, positionUnits.div(new BN(margin)), positionTimestamp)
        expect(currReward).is.bignumber.gte(lastReward)
        lastReward = currReward
        await closePositionAndValidate(this.state, positionUnits, bob)
      }
    })
  }

  it('claims max correct amount if max time passed from position open', async () => {
    await transferRewardTokens(toTokenAmount(1000000))
    await setPlatform()
    await depositToPlatform(toTokenAmount(20000))

    const times = [3 * SECONDS_PER_DAY, 10 * SECONDS_PER_DAY, 29 * SECONDS_PER_DAY]

    for (let currTime of times) {
      this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
      const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
        this.state,
        toTokenAmount(1000),
        bob,
      )
      await time.increase(currTime)
      await claimAndValidate(bob, positionUnits, positionTimestamp)
      await closePositionAndValidate(this.state, positionUnits, bob)
    }
  })

  it('does not allow claiming twice', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )

    await time.increase(SECONDS_PER_DAY)

    await claimAndValidate(bob, positionUnits, positionTimestamp)
    await expectRevert(this.rewards.claimReward({ from: bob }), 'No reward')
  })

  it('does not allow claiming a position not opened by sender', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increase(SECONDS_PER_DAY)

    await expectRevert(this.rewards.claimReward({ from: alice }), 'No opened position')
  })

  it('keeps track of claiming per account', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    const { positionUnits: bobPositionUnits, timestamp: bobPositionTimetamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    await openPositionAndValidate(this.state, toTokenAmount(2000), alice)

    await time.increase(SECONDS_PER_DAY)

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: alicePositionUnits2, timestamp: alicePositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(3000),
      alice,
    )

    await time.increase(SECONDS_PER_DAY)

    await claimAndValidate(bob, bobPositionUnits, bobPositionTimetamp)
    await expectRevert(this.rewards.claimReward({ from: bob }), 'No reward')

    await claimAndValidate(alice, alicePositionUnits2, alicePositionTimestamp)
    await expectRevert(this.rewards.claimReward({ from: alice }), 'No reward')

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: carolPositionUnits, timestamp: carolPositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(3000),
      carol,
    )
    const { positionUnits: bobPositionUnits2, timestamp: bobPositionTimetamp2 } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1500),
      bob,
    )

    await time.increase(SECONDS_PER_DAY)

    await claimAndValidate(carol, carolPositionUnits, carolPositionTimestamp)
    await expectRevert(this.rewards.claimReward({ from: carol }), 'No reward')

    await claimAndValidate(bob, bobPositionUnits2.sub(bobPositionUnits), bobPositionTimetamp2)
    await expectRevert(this.rewards.claimReward({ from: bob }), 'No reward')
  })

  it('allows stopping all rewards by setting daily max to zero', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    await rewardAndValidate(bob, toTokenAmount(1000))

    await this.rewards.setMaxDailyReward(0, { from: admin })

    await expectRevert(rewardAndValidate(bob, toTokenAmount(100)), 'Daily reward spent')
    await expectRevert(rewardAndValidate(alice, toTokenAmount(200)), 'Daily reward spent')
  })

  it('allows claiming a newly opened position after last claim', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    const { positionUnits: bobPositionUnits, timestamp: bobPositionTimetamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    await time.increase(SECONDS_PER_DAY)
    await claimAndValidate(bob, bobPositionUnits, bobPositionTimetamp)

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: bobPositionUnits2, timestamp: bobPositionTimetamp2 } = await openPositionAndValidate(
      this.state,
      toTokenAmount(500),
      bob,
    )
    await time.increase(SECONDS_PER_DAY)
    await claimAndValidate(bob, bobPositionUnits2.sub(bobPositionUnits), bobPositionTimetamp2)
  })

  it('reverts when not called by allowed caller', async () => {
    const accounts = [alice, carol, bob]

    for (let account of accounts) {
      await expectRevert(
        this.rewards.setPlatform(this.platform.address, { from: account }),
        'Ownable: caller is not the owner',
      )
      await expectRevert(
        this.rewards.setMaxDailyReward(DAILY_REWARD, { from: account }),
        'Ownable: caller is not the owner',
      )
      await expectRevert(
        this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {
          from: account,
        }),
        'Ownable: caller is not the owner',
      )
      await expectRevert(
        this.rewards.setMaxClaimPeriod(new BN(SECONDS_PER_DAY * 30), { from: account }),
        'Ownable: caller is not the owner',
      )
      await expectRevert(
        this.rewards.setMaxRewardTime(MAX_REWARD_TIME, { from: account }),
        'Ownable: caller is not the owner',
      )
      await expectRevert(
        this.rewards.setMaxRewardTimePercentageGain(MAX_TIME_PERCENTAGE_GAIN, { from: account }),
        'Ownable: caller is not the owner',
      )
      await expectRevert(this.rewards.setRewardFactor(1, { from: account }), 'Ownable: caller is not the owner')
    }
  })

  it('sets max time percentage gain properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    const gains = [toBN(40, 8), toBN(10, 8), new BN(0)]

    for (let gain of gains) {
      await this.rewards.setMaxRewardTimePercentageGain(gain, { from: admin })
      expect(await this.rewards.maxRewardTimePercentageGain()).to.be.bignumber.equal(gain)
      await rewardAndValidate(
        bob,
        toUSD(1000),
        MAX_LINEAR_POSITION_UNITS,
        MAX_LINEAR_GOVI,
        MAX_SINGLE_REWARD,
        MAX_REWARD_TIME,
        gain,
      )
      await rewardAndValidate(
        bob,
        toUSD(30000),
        MAX_LINEAR_POSITION_UNITS,
        MAX_LINEAR_GOVI,
        MAX_SINGLE_REWARD,
        MAX_REWARD_TIME,
        gain,
      )
    }
  })

  it('sets reward factor properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    expect(await this.rewards.rewardFactor()).to.be.bignumber.equal(FACTOR_REWARD)
    const newFactor = toBN(1, 6) // A too small factor, zeroing reward
    await this.rewards.setRewardFactor(newFactor, { from: admin })
    expect(await this.rewards.rewardFactor()).to.be.bignumber.equal(newFactor)

    await rewardAndValidate(bob, toUSD(1000), undefined, undefined, undefined, undefined, undefined, newFactor)
  })

  const verifyRewardCalculationParameters = async (c, x0, y0, lastC, lastX0, lastY0) => {
    expect(await this.rewards.maxSingleReward()).to.be.bignumber.equal(c)
    expect(await this.rewards.rewardMaxLinearPositionUnits()).to.be.bignumber.equal(x0)
    expect(await this.rewards.rewardMaxLinearGOVI()).to.be.bignumber.equal(y0)
    expect(await this.rewards.lastMaxSingleReward()).to.be.bignumber.equal(lastC)
    expect(await this.rewards.lastRewardMaxLinearPositionUnits()).to.be.bignumber.equal(lastX0)
    expect(await this.rewards.lastRewardMaxLinearGOVI()).to.be.bignumber.equal(lastY0)
  }

  it('sets reward calculation parameters with max claim time delay properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await this.rewards.setRewardCalculationParameters(MAX_SINGLE_REWARD, MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, {
      from: admin,
    })

    await verifyRewardCalculationParameters(
      MAX_SINGLE_REWARD,
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
      MAX_SINGLE_REWARD,
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
    )

    expect(await this.rewards.rewardCalculationValidTimestamp()).to.be.bignumber.equal(
      (await time.latest()).add(new BN(SECONDS_PER_DAY * 30)),
    )

    await depositToPlatform(toTokenAmount(10000))

    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD,
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
      { from: admin },
    )

    await verifyRewardCalculationParameters(
      MAX_SINGLE_REWARD,
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
      MAX_SINGLE_REWARD,
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
    )

    expect(await this.rewards.rewardCalculationValidTimestamp()).to.be.bignumber.equal(
      (await time.latest()).add(new BN(SECONDS_PER_DAY * 30)),
    )

    let setParametersTimestamp = await time.latest()

    const { positionUnits: bobPositionUnits, timestamp: bobPositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(10),
      bob,
    )

    await time.increase(SECONDS_PER_DAY)

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: alicePositionUnits, timestamp: alicePositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(20),
      alice,
    )

    await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 - 1)))
    await claimAndValidate(bob, bobPositionUnits, bobPositionTimestamp)

    await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 + 1)))
    await claimAndValidate(
      alice,
      alicePositionUnits,
      alicePositionTimestamp,
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
    )

    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD.div(new BN(2)),
      MAX_LINEAR_POSITION_UNITS.mul(new BN(2)),
      MAX_LINEAR_GOVI.mul(new BN(2)),
      { from: admin },
    )

    await verifyRewardCalculationParameters(
      MAX_SINGLE_REWARD.div(new BN(2)),
      MAX_LINEAR_POSITION_UNITS.mul(new BN(2)),
      MAX_LINEAR_GOVI.mul(new BN(2)),
      MAX_SINGLE_REWARD,
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
    )

    expect(await this.rewards.rewardCalculationValidTimestamp()).to.be.bignumber.equal(
      (await time.latest()).add(new BN(SECONDS_PER_DAY * 30)),
    )

    setParametersTimestamp = await time.latest()

    await time.increase(SECONDS_PER_DAY)
    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: bobPositionUnits2, timestamp: bobPositionTimestamp2 } = await openPositionAndValidate(
      this.state,
      toTokenAmount(10),
      bob,
    )

    await time.increase(SECONDS_PER_DAY)
    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: carolPositionUnits, timestamp: carolPositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(30),
      carol,
    )

    await time.increase(SECONDS_PER_DAY)
    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits: davePositionUnits, timestamp: davePositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(50),
      dave,
    )

    await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 - 1)))
    await claimAndValidate(
      bob,
      bobPositionUnits2.sub(bobPositionUnits),
      bobPositionTimestamp2,
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
    )

    await time.increaseTo(setParametersTimestamp.add(new BN(SECONDS_PER_DAY * 30 + 1)))
    await claimAndValidate(
      carol,
      carolPositionUnits,
      carolPositionTimestamp,
      MAX_LINEAR_POSITION_UNITS.mul(new BN(2)),
      MAX_LINEAR_GOVI.mul(new BN(2)),
      MAX_SINGLE_REWARD.div(new BN(2)),
    )

    await claimAndValidate(
      dave,
      davePositionUnits,
      davePositionTimestamp,
      MAX_LINEAR_POSITION_UNITS.mul(new BN(2)),
      MAX_LINEAR_GOVI.mul(new BN(2)),
      MAX_SINGLE_REWARD.div(new BN(2)),
    )
  })

  it('allows changing rewards coeffcients immediately', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))

    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD.mul(new BN(2)),
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
      { from: admin },
    )
    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD.mul(new BN(2)),
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
      { from: admin },
    )

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(10),
      bob,
    )
    await time.increase(SECONDS_PER_DAY)
    await claimAndValidate(
      bob,
      positionUnits,
      positionTimestamp,
      MAX_LINEAR_POSITION_UNITS.div(new BN(2)),
      MAX_LINEAR_GOVI.div(new BN(2)),
      MAX_SINGLE_REWARD.mul(new BN(2)),
    )
  })

  it('reverts when claiming no reward', async () => {
    await transferRewardTokens(toTokenAmount(1000000))
    await depositToPlatform(toTokenAmount(10000))

    await setPlatform()

    await expectRevert(this.rewards.claimReward({ from: bob }), 'No opened position')
    await expectRevert(this.rewards.claimReward({ from: alice }), 'No opened position')
    await expectRevert(this.rewards.claimReward({ from: admin }), 'No opened position')

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )

    await time.increase(SECONDS_PER_DAY)

    await this.rewards.claimReward({ from: bob })
    await expectRevert(this.rewards.claimReward({ from: alice }), 'No opened position')
    await expectRevert(this.rewards.claimReward({ from: admin }), 'No opened position')
  })

  it('reverts when claiming and max daily rewards was depleted', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    await time.increase(SECONDS_PER_DAY)
    const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp)

    await time.increase(SECONDS_PER_DAY)
    await this.rewards.setMaxDailyReward(bobReward, { from: admin })

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    await openPositionAndValidate(this.state, toTokenAmount(2000), alice)
    await time.increase(SECONDS_PER_DAY)
    await expectRevert(this.rewards.claimReward({ from: alice }), 'Daily reward spent')
  })

  it('reverts when claiming and max daily rewards is reached with current claim', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    const { positionUnits: alicePositionUnits } = await openPositionAndValidate(this.state, toTokenAmount(2000), alice)
    await time.increase(SECONDS_PER_DAY)
    const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp)
    const aliceReward = calculateReward(alicePositionUnits, new BN(SECONDS_PER_DAY))

    await this.rewards.setMaxDailyReward(bobReward.add(aliceReward.div(new BN(2))), { from: admin })

    await expectRevert(this.rewards.claimReward({ from: alice }), 'Daily reward spent')
  })

  it('resets total rewards claimed when day passes', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    const { positionUnits: alicePositionUnits, timestamp: alicePositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(10),
      alice,
    )
    await time.increase(SECONDS_PER_DAY)
    const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp)
    await this.rewards.setMaxDailyReward(bobReward, { from: admin })

    let today = (await time.latest()).div(new BN(SECONDS_PER_DAY))
    expect(await this.rewards.todayClaimedRewards()).to.be.bignumber.equal(bobReward)
    expect(await this.rewards.lastClaimedDay()).to.be.bignumber.equal(today)

    await expectRevert(this.rewards.claimReward({ from: alice }), 'Daily reward spent')

    const secondsLeftInDay = SECONDS_PER_DAY * (today.toNumber() + 1) - (await time.latest()).toNumber()
    await time.increase(secondsLeftInDay)

    const aliceReward = await claimAndValidate(alice, alicePositionUnits, alicePositionTimestamp)
    today = (await time.latest()).div(new BN(SECONDS_PER_DAY))
    expect(await this.rewards.todayClaimedRewards()).to.be.bignumber.equal(aliceReward)
    expect(await this.rewards.lastClaimedDay()).to.be.bignumber.equal(today)

    await expectRevert(this.rewards.claimReward({ from: alice }), 'No reward')
  })

  it('reverts when not enough CVI tokens are left for current claim', async () => {
    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { positionUnits } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await time.increase(MAX_REWARD_TIME)
    const reward = calculateReward(positionUnits, MAX_REWARD_TIME)

    await transferRewardTokens(reward.sub(new BN(1)))
    await expectRevert(this.rewards.claimReward({ from: bob }), 'ERC20: transfer amount exceeds balance')
  })

  it('reverts when no CVI tokens are left for current claim', async () => {
    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )

    await time.increase(MAX_REWARD_TIME)
    const reward = calculateReward(positionUnits, MAX_REWARD_TIME)

    await transferRewardTokens(reward)

    await claimAndValidate(bob, positionUnits, positionTimestamp)

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    await openPositionAndValidate(this.state, toTokenAmount(1000), alice)
    await time.increase(SECONDS_PER_DAY)
    await expectRevert(this.rewards.claimReward({ from: alice }), 'ERC20: transfer amount exceeds balance')
  })

  it('allows setting daily max reward properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    await openPositionAndValidate(this.state, toTokenAmount(1000), alice)
    await time.increase(SECONDS_PER_DAY)
    const bobReward = await claimAndValidate(bob, positionUnits, positionTimestamp)

    await this.rewards.setMaxDailyReward(bobReward, { from: admin })
    expect(await this.rewards.maxDailyReward()).to.be.bignumber.equal(bobReward)

    await expectRevert(this.rewards.claimReward({ from: alice }), 'Daily reward spent')
  })

  it('allows setting max single reward properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    await rewardAndValidate(bob, toTokenAmount(1000), MAX_LINEAR_POSITION_UNITS, MAX_LINEAR_GOVI, MAX_SINGLE_REWARD)
    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD.div(new BN(2)),
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
      { from: admin },
    )
    await time.increase(30 * SECONDS_PER_DAY)
    expect(await this.rewards.maxSingleReward()).to.be.bignumber.equal(MAX_SINGLE_REWARD.div(new BN(2)))
    await rewardAndValidate(
      alice,
      toTokenAmount(1000),
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
      MAX_SINGLE_REWARD.div(new BN(2)),
    )
  })

  it('allows setting max claim period properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))
    const { timestamp: positionTimestamp } = await openPositionAndValidate(this.state, toTokenAmount(1000), bob)

    await this.rewards.setMaxClaimPeriod(SECONDS_PER_DAY * 3, { from: admin })
    expect(await this.rewards.maxClaimPeriod()).to.be.bignumber.equal(new BN(SECONDS_PER_DAY * 3))

    await time.increaseTo(positionTimestamp.add(new BN(SECONDS_PER_DAY * 3 - 2)))
    await this.rewards.claimReward({ from: bob })

    this.fakePriceProvider.setPrice(toCVI(CVI_VALUE))
    const { positionUnits, timestamp: positionTimestamp2 } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )

    await time.increaseTo(positionTimestamp2.add(new BN(SECONDS_PER_DAY * 3 + 1)))
    await expectRevert(this.rewards.claimReward({ from: bob }), 'Claim too late')
  })

  it('reverts when max reward time properly is set to zero', async () => {
    await expectRevert(this.rewards.setMaxRewardTime(0, { from: admin }), 'Max reward time not positive')
  })

  it('allows setting max reward time properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(10000))

    const maxRewardTime = new BN(SECONDS_PER_DAY * 4)
    await this.rewards.setMaxRewardTime(maxRewardTime, { from: admin })
    expect(await this.rewards.maxRewardTime()).to.be.bignumber.equal(maxRewardTime)

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    await time.increase(SECONDS_PER_DAY)
    await claimAndValidate(bob, positionUnits, positionTimestamp, undefined, undefined, undefined, maxRewardTime)
  })

  it('allows setting the platform properly', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    const fakePlatform = await FakePlatform.new(toTokenAmount(1000), bob)
    const positionTimestamp = await time.latest()

    await this.rewards.setPlatform(fakePlatform.address, { from: admin })

    expect(await this.rewards.platform()).to.equal(fakePlatform.address)

    await time.increase(SECONDS_PER_DAY)

    await claimAndValidate(bob, toTokenAmount(1000), positionTimestamp)
  })

  it('allows stopping all rewards by setting daily max to zero', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    await rewardAndValidate(bob, toTokenAmount(1000))

    await this.rewards.setMaxDailyReward(0, { from: admin })

    await expectRevert(rewardAndValidate(bob, toTokenAmount(100)), 'Daily reward spent')
    await expectRevert(rewardAndValidate(alice, toTokenAmount(200)), 'Daily reward spent')
  })

  it('allows unclaimable rewards to become claimable by increasing max daily reward', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    await setPlatform()
    await depositToPlatform(toTokenAmount(50000))

    const { positionUnits, timestamp: positionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(1000),
      bob,
    )
    const { positionUnits: alicePositionUnits, timestamp: alicePositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(2000),
      alice,
    )
    const { positionUnits: carolPositionUnits, timestamp: carolPositionTimestamp } = await openPositionAndValidate(
      this.state,
      toTokenAmount(3000),
      carol,
    )

    await time.increaseTo(carolPositionTimestamp.add(new BN(3 * SECONDS_PER_DAY)))

    const bobReward = calculateReward(positionUnits, MAX_REWARD_TIME)
    const aliceReward = calculateReward(alicePositionUnits, MAX_REWARD_TIME)
    const carolReward = calculateReward(carolPositionUnits, MAX_REWARD_TIME)

    await this.rewards.setMaxDailyReward(bobReward.add(aliceReward), { from: admin })

    await claimAndValidate(bob, positionUnits, positionTimestamp)
    await claimAndValidate(alice, alicePositionUnits, alicePositionTimestamp)

    await expectRevert(this.rewards.claimReward({ from: carol }), 'Daily reward spent')
    await this.rewards.setMaxDailyReward(bobReward.add(aliceReward).add(carolReward), { from: admin })

    await claimAndValidate(carol, carolPositionUnits, carolPositionTimestamp)
  })

  it('rewards less than max single reward even for a very high amount of position units', async () => {
    await transferRewardTokens(toTokenAmount(1000000))

    const fakePlatform = await FakePlatform.new(toBN(1, 35), bob)
    const positionTimestamp = await time.latest()
    await this.rewards.setPlatform(fakePlatform.address, { from: admin })

    await time.increase(SECONDS_PER_DAY)

    const reward = await claimAndValidate(bob, toBN(1, 35), positionTimestamp)
    expect(reward).to.be.bignumber.lte(MAX_SINGLE_REWARD)
  })

  it('returns correct rewards', async () => {
    const positionUnits = toTokenAmount(1000)

    const openTimestamp = await time.latest()
    await time.increase(SECONDS_PER_DAY)
    const reward = await this.rewards.calculatePositionReward(positionUnits, openTimestamp)
    const rewardTimestamp = await time.latest()

    const expectedReward = calculateReward(positionUnits, rewardTimestamp.sub(openTimestamp))

    expect(reward).to.be.bignumber.equal(expectedReward)
  })

  it('returns minimum after raising rewards', async () => {
    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD.mul(new BN(2)),
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
      { from: admin },
    )

    const positionUnits = toTokenAmount(1000)

    const openTimestamp = await time.latest()
    await time.increase(SECONDS_PER_DAY)
    const reward = await this.rewards.calculatePositionReward(positionUnits, openTimestamp)
    const rewardTimestamp = await time.latest()

    const expectedReward = calculateReward(positionUnits, rewardTimestamp.sub(openTimestamp))

    expect(reward).to.be.bignumber.equal(expectedReward)
  })

  it('returns minimum after lowering rewards', async () => {
    await this.rewards.setRewardCalculationParameters(
      MAX_SINGLE_REWARD.div(new BN(2)),
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
      { from: admin },
    )

    const positionUnits = toTokenAmount(1000)

    const openTimestamp = await time.latest()
    await time.increase(SECONDS_PER_DAY)
    const reward = await this.rewards.calculatePositionReward(positionUnits, openTimestamp)
    const rewardTimestamp = await time.latest()

    const expectedReward = calculateReward(
      positionUnits,
      rewardTimestamp.sub(openTimestamp),
      MAX_LINEAR_POSITION_UNITS,
      MAX_LINEAR_GOVI,
      MAX_SINGLE_REWARD.div(new BN(2)),
    )

    expect(reward).to.be.bignumber.equal(expectedReward)
  })
})
