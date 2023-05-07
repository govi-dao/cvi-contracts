/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, time } = require('@openzeppelin/test-helpers')
const { toUSD, toBN } = require('./utils/BNUtils.js')
const { getAccounts } = require('./utils/DeployUtils.js')

const chai = require('chai')
const expect = chai.expect

const TEST_AMOUNTS = [0, 500, 1000, 7500, 20000]

const RequestFeesCalculator = artifacts.require('RequestFeesCalculator')

const SECONDS_PER_HOUR = 60 * 60

const MIN_WAIT_TIME = 15 * 60

const FINDERS_FEE_PERCENT = toBN(5000)
const KEEPERS_FEE_PERCENT = toBN(100)
const KEEPERS_MAX_FEE = toUSD(4)

const MAX_TIME_DELAY_FEE = toBN(100)
const MIN_TIME_DELAY_FEE = toBN(0)

const MIN_PENALTY_FEE = toBN(300)
const MAX_PENALTY_FEE = toBN(500)
const MID_PENALTY_FEE = toBN(300)

const MIN_TIME_DELAY = SECONDS_PER_HOUR
const MAX_TIME_DELAY = 3 * SECONDS_PER_HOUR

const MID_PENALTY_TIME = 1 * SECONDS_PER_HOUR
const MAX_PENALTY_TIME = 12 * SECONDS_PER_HOUR

const MAX_PERCENTAGE = toBN(10000)

let admin, bob, alice, carol, dave

const setAccounts = async () => {
  ;[admin, bob, alice, carol, dave] = await getAccounts()
}

const createRequest = (
  requestType,
  tokenAmount,
  timeDelayRequestFeesPercent,
  maxRequestFeesPercent,
  owner,
  requestTimestamp,
  targetTimestamp,
) => {
  return {
    requestType,
    tokenAmount,
    timeDelayRequestFeesPercent,
    maxRequestFeesPercent,
    owner,
    requestTimestamp: requestTimestamp.toString(),
    targetTimestamp: targetTimestamp.toString(),
    useKeepers: false,
    maxBuyingPremiumFeePercentage: 1000,
  }
}

describe('RequestFeesCalcaultor', () => {
  beforeEach(async () => {
    await setAccounts()
    this.requestFeesCalculator = await RequestFeesCalculator.new({ from: admin })
  })

  it('calculates finders fee properly', async () => {
    for (let amount of TEST_AMOUNTS) {
      const findersFee = toBN(amount).mul(FINDERS_FEE_PERCENT).div(MAX_PERCENTAGE)
      expect(await this.requestFeesCalculator.calculateFindersFee(amount)).to.be.bignumber.equal(findersFee)
    }
  })

  it('calculates keepers fee properly, when fee does not exceed maximum', async () => {
    for (let amount of TEST_AMOUNTS) {
      const keepersFee = toBN(amount).mul(KEEPERS_FEE_PERCENT).div(MAX_PERCENTAGE)
      expect(await this.requestFeesCalculator.calculateKeepersFee(amount)).to.be.bignumber.equal(keepersFee)
    }
  })

  it('calculates keepers fee properly, when fee equals or exceeds maximum', async () => {
    for (let amount of TEST_AMOUNTS) {
      expect(
        await this.requestFeesCalculator.calculateKeepersFee(
          toBN(amount).add(KEEPERS_MAX_FEE.mul(MAX_PERCENTAGE).div(KEEPERS_FEE_PERCENT)),
        ),
      ).to.be.bignumber.equal(KEEPERS_MAX_FEE)
    }
  })

  it('reverts when time delay is too small', async () => {
    await expectRevert(this.requestFeesCalculator.calculateTimeDelayFee(MIN_TIME_DELAY - 2), 'Time delay too small')
    await this.requestFeesCalculator.calculateTimeDelayFee(MIN_TIME_DELAY)
  })

  it('reverts when time delay is too big', async () => {
    await expectRevert(this.requestFeesCalculator.calculateTimeDelayFee(MAX_TIME_DELAY + 1), 'Time delay too big')
    await this.requestFeesCalculator.calculateTimeDelayFee(MAX_TIME_DELAY - 1)
  })

  it('calculates time delay fee properly', async () => {
    const timeDelays = [
      SECONDS_PER_HOUR,
      (3 * SECONDS_PER_HOUR) / 2,
      2 * SECONDS_PER_HOUR,
      (5 * SECONDS_PER_HOUR) / 2,
      3 * SECONDS_PER_HOUR,
    ]

    for (let timeDelay of timeDelays) {
      const timeFeePercentage = MAX_TIME_DELAY_FEE.sub(
        toBN(timeDelay)
          .sub(toBN(SECONDS_PER_HOUR))
          .mul(MAX_TIME_DELAY_FEE.sub(MIN_TIME_DELAY_FEE))
          .div(toBN(2 * SECONDS_PER_HOUR)),
      )
      expect(await this.requestFeesCalculator.calculateTimeDelayFee(timeDelay)).to.be.bignumber.equal(timeFeePercentage)
    }
  })

  it('determines liquidity properly', async () => {
    let now = await time.latest()
    expect(
      await this.requestFeesCalculator.isLiquidable(
        createRequest(1, 1000, 50, 500, bob, now, now.sub(toBN(MAX_PENALTY_TIME + 2))),
      ),
    ).to.be.true
    now = await time.latest()
    expect(
      await this.requestFeesCalculator.isLiquidable(
        createRequest(1, 1000, 50, 500, bob, now, now.sub(toBN(MAX_PENALTY_TIME - 2))),
      ),
    ).to.be.false
  })

  it('gets max fee properly', async () => {
    const actualMaxFeesPercent = await this.requestFeesCalculator.getMaxFees()
    expect(actualMaxFeesPercent).to.be.bignumber.equal(MAX_PENALTY_FEE)
  })

  it('reverts when calculating time penalty before min wait time', async () => {
    const delay = SECONDS_PER_HOUR
    const timesAfterRequestTime = [0, MIN_WAIT_TIME / 2, MIN_WAIT_TIME - 1]

    for (let timeAfterRequest of timesAfterRequestTime) {
      const now = await time.latest()
      await expectRevert(
        this.requestFeesCalculator.calculateTimePenaltyFee(
          createRequest(
            1,
            1000,
            500,
            50,
            bob,
            now.sub(toBN(timeAfterRequest)),
            now.add(toBN(delay - timeAfterRequest)),
          ),
        ),
        'Min wait time not over',
      )
    }
  })

  it('calculates time penalty fee properly until target time', async () => {
    const delay = SECONDS_PER_HOUR - MIN_WAIT_TIME
    const timesAfterMinRequestTime = [0, 1, delay / 2, delay / 3, (delay * 2) / 3]

    for (let amount of TEST_AMOUNTS) {
      for (let timeAfterRequest of timesAfterMinRequestTime) {
        const flooredTimeAfterMinRequestTime = Math.floor(timeAfterRequest)
        const now = await time.latest()
        const feePercentage = toBN(delay - flooredTimeAfterMinRequestTime)
          .mul(MIN_PENALTY_FEE)
          .div(toBN(delay))
        const actualFeePercentage = await this.requestFeesCalculator.calculateTimePenaltyFee(
          createRequest(
            1,
            amount,
            500,
            50,
            bob,
            now.sub(toBN(flooredTimeAfterMinRequestTime + MIN_WAIT_TIME)),
            now.add(toBN(delay - flooredTimeAfterMinRequestTime)),
          ),
        )
        expect(actualFeePercentage).to.be.bignumber.equal(feePercentage)
      }
    }
  })

  it('calculates time penalty fee properly until mid time', async () => {
    const timesAfterTarget = [0, 1, MID_PENALTY_TIME / 2, MID_PENALTY_TIME / 3, (MID_PENALTY_TIME * 2) / 3]
    const delay = SECONDS_PER_HOUR

    for (let amount of TEST_AMOUNTS) {
      for (let timeAfterTarget of timesAfterTarget) {
        const flooredTimeAfterTarget = Math.floor(timeAfterTarget)
        const now = await time.latest()
        const feePercentage = toBN(flooredTimeAfterTarget).mul(MID_PENALTY_FEE).div(toBN(MID_PENALTY_TIME))
        const actualFeePercentage = await this.requestFeesCalculator.calculateTimePenaltyFee(
          createRequest(
            1,
            amount,
            500,
            50,
            bob,
            now.sub(toBN(flooredTimeAfterTarget + delay)),
            now.sub(toBN(flooredTimeAfterTarget)),
          ),
        )
        expect(actualFeePercentage).to.be.bignumber.equal(feePercentage)
      }
    }
  })

  it('calculates time penalty fee properly until max time', async () => {
    const timesAfterTarget = [
      MID_PENALTY_TIME,
      MID_PENALTY_TIME + 1,
      (MID_PENALTY_TIME + MAX_PENALTY_TIME) / 2,
      MID_PENALTY_TIME + (MAX_PENALTY_TIME - MID_PENALTY_TIME) / 3,
      MID_PENALTY_TIME + ((MAX_PENALTY_TIME - MID_PENALTY_TIME) * 2) / 3,
    ]
    const delay = SECONDS_PER_HOUR

    for (let amount of TEST_AMOUNTS) {
      for (let timeAfterTarget of timesAfterTarget) {
        const flooredTimeAfterTarget = Math.floor(timeAfterTarget)
        const now = await time.latest()
        const feePercentage = toBN(MID_PENALTY_FEE).add(
          toBN(flooredTimeAfterTarget)
            .sub(toBN(MID_PENALTY_TIME))
            .mul(MAX_PENALTY_FEE.sub(toBN(MID_PENALTY_FEE)))
            .div(toBN(MAX_PENALTY_TIME - MID_PENALTY_TIME)),
        )
        const actualFeePercentage = await this.requestFeesCalculator.calculateTimePenaltyFee(
          createRequest(
            1,
            amount,
            500,
            50,
            bob,
            now.sub(toBN(flooredTimeAfterTarget + delay)),
            now.sub(toBN(flooredTimeAfterTarget)),
          ),
        )
        expect(actualFeePercentage).to.be.bignumber.equal(feePercentage)
      }
    }
  })

  it('calculates time penalty fee properly after max time', async () => {
    const timesAfterTarget = [MAX_PENALTY_TIME, MAX_PENALTY_TIME + 1, MAX_PENALTY_TIME * 2]
    const delay = SECONDS_PER_HOUR

    for (let amount of TEST_AMOUNTS) {
      for (let timeAfterTarget of timesAfterTarget) {
        const now = await time.latest()
        const actualFeePercentage = await this.requestFeesCalculator.calculateTimePenaltyFee(
          createRequest(
            1,
            amount,
            500,
            50,
            bob,
            now.sub(toBN(timeAfterTarget + delay)),
            now.sub(toBN(timeAfterTarget)),
          ),
        )
        expect(actualFeePercentage).to.be.bignumber.equal(MAX_PENALTY_FEE)
      }
    }
  })

  it.skip('reverts when setting min time window to be bigger than max time window', async () => {})

  it.skip('sets time window properly', async () => {})

  it.skip('reverts when setting a too big min time delay fee percent', async () => {})

  it.skip('reverts when setting a too big max time delay fee percent', async () => {})

  it.skip('reverts when setting a min time delay fee percent bigger than max time delay fee percent', async () => {})

  it.skip('sets min time delay fee percent properly', async () => {})

  it.skip('sets max time delay fee percent properly', async () => {})

  it.skip('reverts when setting a min wait time smaller than window', async () => {})

  it.skip('sets min wait time properly', async () => {})

  it.skip('reverts when setting a too big before target max penalty fee', async () => {})

  it.skip('reverts when setting a too big after target mid penalty fee', async () => {})

  it.skip('reverts when setting a too big after target max penalty fee', async () => {})

  it.skip('reverts when setting a penalty fee mid time bigger than penalty fee max time', async () => {})

  it.skip('reverts when setting a penalty fee mid time percent bigger than penalty fee max time percent', async () => {})

  it.skip('sets before target max penalty fee properly', async () => {})

  it.skip('sets penalty fee mid time properly', async () => {})

  it.skip('sets penalty fee mid time percent properly', async () => {})

  it.skip('sets penalty fee max time properly', async () => {})

  it.skip('sets after target max penalty fee properly', async () => {})

  it.skip('sets finders fee percent properly', async () => {})

  it.skip('sets keepers fee percent properly', async () => {})

  it.skip('sets keepers fee max amount properly', async () => {})

  it('reverts when attempting to execute an ownable function by non admin user', async () => {
    const expectedError = 'Ownable: caller is not the owner'

    await expectRevert(this.requestFeesCalculator.setTimeWindow(60, 120, { from: alice }), expectedError)
    await expectRevert(this.requestFeesCalculator.setTimeDelayFeesParameters(100, 200, { from: dave }), expectedError)
    await expectRevert(this.requestFeesCalculator.setMinWaitTime(60, { from: dave }), expectedError)
    await expectRevert(
      this.requestFeesCalculator.setTimePenaltyFeeParameters(1000, 60, 300, 120, 700, { from: carol }),
      expectedError,
    )
    await expectRevert(this.requestFeesCalculator.setFindersFee(100, { from: dave }), expectedError)
    await expectRevert(this.requestFeesCalculator.setKeepersFeePercent(200, { from: dave }), expectedError)
    await expectRevert(this.requestFeesCalculator.setKeepersFeeMax(5000000, { from: dave }), expectedError)
  })
})
