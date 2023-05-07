/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, time, BN } = require('@openzeppelin/test-helpers')
const chai = require('chai')

const FeesCalculator = artifacts.require('FeesCalculator')
const CVIOracle = artifacts.require('ETHVolOracle')
const FakePriceProvider = artifacts.require('FakePriceProvider')

const { getContracts, getAccounts, ZERO_ADDRESS } = require('./utils/DeployUtils.js')
const { toBN, toTokenAmount, toCVI } = require('./utils/BNUtils.js')
const {
  calculateSingleUnitFee,
  calculatePremiumFee,
  MAX_PERCENTAGE,
  COLLATERAL_TO_PREMIUM_FEE_RATIOS,
} = require('./utils/FeesUtils.js')
const { print } = require('./utils/DebugUtils')

const expect = chai.expect

const SECONDS_PER_HOUR = 60 * 60

const PREMIUM_FEE_TEST_RATIOS = [0.599, 0.61, 0.61, 0.74, 0.85, 0.99, 1.0, 1.01]
const PREMIUM_FEE_TEST_LAST_RATIOS = [0.5, 0.55, 0.5, 0.56, 0.5, 0.2, 0.3, 0.4]
const PREMIUM_FEE_TEST_UNITS = [1, 1000, 2000]

const MAX_CVI_VALUE = toBN(22000)

const RATIO_DECIMALS = toBN(1, 10)

const MIN_PREMIUM_COLLATERLA_FEE = 6500

const LP_PREMIUM_FEE_PERCENTAGE = toBN(15)
const MAX_PREMIUM_FEE_PERCENTAGE = toBN(1000)

const premiumFeeTests = []

for (let i = 0; i < PREMIUM_FEE_TEST_RATIOS.length; i++) {
  for (let j = 0; j < PREMIUM_FEE_TEST_UNITS.length; j++) {
    const ratio = toBN(PREMIUM_FEE_TEST_RATIOS[i] * 1000, 7)
    premiumFeeTests.push({ units: toTokenAmount(PREMIUM_FEE_TEST_UNITS[j]), ratio, lastRatio: ratio.sub(new BN(1)) })
    premiumFeeTests.push({
      units: toTokenAmount(PREMIUM_FEE_TEST_UNITS[j]),
      ratio,
      lastRatio: toBN(PREMIUM_FEE_TEST_LAST_RATIOS[i] * 1000, 7),
    })
  }
}

const FUNDING_FEE_TESTS = [
  [{ period: 0, cviValue: 0 }],
  [{ period: 86400, cviValue: 0 }],
  [{ period: 0, cviValue: 10000 }],
  [{ period: 86400, cviValue: 2000 }],
  [{ period: 172800, cviValue: 5500 }],
  [{ period: 86400, cviValue: 6000 }],
  [{ period: 86400, cviValue: 8000 }],
  [{ period: 86400, cviValue: 11000 }],
  [{ period: 172800, cviValue: 16000 }],
  [{ period: 86400, cviValue: 20000 }],
  [{ period: 8888, cviValue: 11700 }],
  [{ period: 15000, cviValue: 12100 }],
  [{ period: 7777, cviValue: 12100 }],
]

let admin, updator, bob

const setAccounts = async () => {
  ;[admin, updator, bob] = await getAccounts()
}

const validateTurbulenceUpdate = async periods => {
  let currTurbulence = await this.feesCalculator.turbulenceIndicatorPercent()

  await this.feesCalculator.updateTurbulenceIndicatorPercent(periods, { from: updator })

  for (let i = 0; i < periods.length; i++) {
    if (periods[i] >= SECONDS_PER_HOUR) {
      currTurbulence = currTurbulence.div(new BN(2))
      if (currTurbulence.lt(new BN(100))) {
        currTurbulence = new BN(0)
      }
    } else {
      currTurbulence = currTurbulence.add(new BN(100))
    }
  }

  if (currTurbulence.gt(new BN(1000))) {
    currTurbulence = new BN(1000)
  }

  expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(currTurbulence)
}

const testBuyingPremiumMapping = async mapping => {
  for (let i = 0; i < mapping.length; i++) {
    const collateralRatio = (i * 10 ** 10) / 10 ** 2
    const result = await this.feesCalculator.calculateBuyingPremiumFee(
      new BN(10000),
      1,
      collateralRatio,
      collateralRatio,
      false,
    )

    let expectedPremium = new BN(mapping[i]).add(LP_PREMIUM_FEE_PERCENTAGE)

    if (expectedPremium.gt(MAX_PREMIUM_FEE_PERCENTAGE)) {
      expectedPremium = MAX_PREMIUM_FEE_PERCENTAGE
    }

    expect(result[0]).to.be.bignumber.equal(expectedPremium)
    expect(result[1]).to.be.bignumber.equal(expectedPremium)
  }
}

describe('FeesCalcaultor', () => {
  beforeEach(async () => {
    await setAccounts()

    this.fakePriceProvider = await FakePriceProvider.new(80, { from: admin })
    this.fakeOracle = await CVIOracle.new(this.fakePriceProvider.address, ZERO_ADDRESS, 2, { from: admin }) //TODO: Test for every margin...
    this.feesCalculator = await FeesCalculator.new(this.fakeOracle.address, MAX_CVI_VALUE.mul(toBN(2)), 2, { from: admin })

    this.feesCalculator.setBuyingPremiumThreshold(MIN_PREMIUM_COLLATERLA_FEE, { from: admin })

    this.fakePriceProvider.setPrice(toCVI(5000), { from: admin })
  })

  it('sets oracle properly', async () => {
    expect(await this.feesCalculator.cviOracle()).to.equal(this.fakeOracle.address)
    await this.feesCalculator.setOracle(ZERO_ADDRESS, { from: admin })
    expect(await this.feesCalculator.cviOracle()).to.equal(ZERO_ADDRESS)

    const currTimestamp = await time.latest()
    await expectRevert.unspecified(
      this.feesCalculator.updateSnapshots(currTimestamp.sub(new BN(1000)), 0, RATIO_DECIMALS, 1),
    )
  })

  it.skip('reverts when attempting to execute an ownable function by non admin user', async () => {
    const expectedError = 'Ownable: caller is not the owner'
    await expectRevert(this.feesCalculator.setOracle(ZERO_ADDRESS, { from: bob }), expectedError)

    //TODO: Add more functions!
  })

  it('updates turbulence only by state udpator', async () => {
    await expectRevert(
      this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, { from: updator }),
      'Not allowed',
    )
    await expectRevert(
      this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, { from: admin }),
      'Not allowed',
    )
    await expectRevert(
      this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, { from: bob }),
      'Not allowed',
    )

    await expectRevert(this.feesCalculator.setStateUpdator(admin, { from: bob }), 'Ownable: caller is not the owner')
    await this.feesCalculator.setStateUpdator(updator, { from: admin })

    await expectRevert(
      this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, { from: bob }),
      'Not allowed',
    )
    await expectRevert(
      this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, { from: admin }),
      'Not allowed',
    )
    await this.feesCalculator.updateTurbulenceIndicatorPercent(5, 3, 50000, 50000, { from: updator })
  })

  it('updates adjusted timestamp only by state udpator', async () => {
    await expectRevert(this.feesCalculator.updateAdjustedTimestamp(3000, 2000, { from: updator }), 'Not allowed')
    await expectRevert(this.feesCalculator.updateAdjustedTimestamp(3000, 2000, { from: admin }), 'Not allowed')
    await expectRevert(this.feesCalculator.updateAdjustedTimestamp(3000, 2000, { from: bob }), 'Not allowed')

    await expectRevert(this.feesCalculator.setStateUpdator(admin, { from: bob }), 'Ownable: caller is not the owner')
    await this.feesCalculator.setStateUpdator(updator, { from: admin })

    await expectRevert(this.feesCalculator.updateAdjustedTimestamp(3000, 2000, { from: bob }), 'Not allowed')
    await expectRevert(this.feesCalculator.updateAdjustedTimestamp(3000, 2000, { from: admin }), 'Not allowed')
    await this.feesCalculator.updateAdjustedTimestamp(3000, 2000, { from: updator })
  })

  it('updates close adjusted timestamp only by state udpator', async () => {
    await expectRevert(this.feesCalculator.updateCloseAdjustedTimestamp(1000, 2000, { from: updator }), 'Not allowed')
    await expectRevert(this.feesCalculator.updateCloseAdjustedTimestamp(1000, 2000, { from: admin }), 'Not allowed')
    await expectRevert(this.feesCalculator.updateCloseAdjustedTimestamp(1000, 2000, { from: bob }), 'Not allowed')

    await expectRevert(this.feesCalculator.setStateUpdator(admin, { from: bob }), 'Ownable: caller is not the owner')
    await this.feesCalculator.setStateUpdator(updator, { from: admin })

    await expectRevert(this.feesCalculator.updateCloseAdjustedTimestamp(1000, 2000, { from: bob }), 'Not allowed')
    await expectRevert(this.feesCalculator.updateCloseAdjustedTimestamp(1000, 2000, { from: admin }), 'Not allowed')
    await this.feesCalculator.updateCloseAdjustedTimestamp(1000, 2000, { from: updator })
  })

  it.skip('updates adjusted timestamp properly when time window was exceeded', async () => {})

  it.skip('updates adjusted timestamp properly inside time window but without exceeding current block timestamp', async () => {})

  it.skip('updates adjusted timestamp properly inside time window with exceeding current block timestamp', async () => {})

  it.skip('updates close adjusted timestamp properly when time window was exceeded', async () => {})

  it.skip('updates close adjusted timestamp properly inside time window but without exceeding current block timestamp', async () => {})

  it.skip('updates close adjusted timestamp properly inside time window with exceeding current block timestamp', async () => {})

  it.skip('sets state updator properly', async () => {})

  it.skip('reverts when updating adjusted timestamp and new collateral is smaller than old collateral', async () => {})

  it.skip('reverts when updating close adjusted timestamp and new collateral is larger than old collateral', async () => {})

  it('calculate turbulence indicator percent capped by CVI values relative difference', async () => {
    let totalTime = new BN(3).mul(toBN(55 * 60))
    let newRounds = new BN(5)
    let lastCVIValue = 10000
    let currCVIValue = 11500

    expect(
      await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalTime, newRounds, lastCVIValue, currCVIValue),
    ).to.be.bignumber.equal(new BN(200)) //2%
    currCVIValue = 10200
    expect(
      await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalTime, newRounds, lastCVIValue, currCVIValue),
    ).to.be.bignumber.equal(new BN(0))
    currCVIValue = 12500
    totalTime = new BN(2).mul(toBN(55 * 60))
    expect(
      await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalTime, newRounds, lastCVIValue, currCVIValue),
    ).to.be.bignumber.equal(new BN(300))
    currCVIValue = 10500
    expect(
      await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalTime, newRounds, lastCVIValue, currCVIValue),
    ).to.be.bignumber.equal(new BN(100))
    lastCVIValue = 5000
    currCVIValue = 5250
    expect(
      await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalTime, newRounds, lastCVIValue, currCVIValue),
    ).to.be.bignumber.equal(new BN(100))
    currCVIValue = 5000
    lastCVIValue = 5350
    expect(
      await this.feesCalculator.calculateTurbulenceIndicatorPercent(totalTime, newRounds, lastCVIValue, currCVIValue),
    ).to.be.bignumber.equal(new BN(100))
  })

  it.skip('updates and calculates turbulence fee correctly', async () => {
    // Create auto-calculation with values for different cases (instead of commented test below)
    /*it('updates turbelence fee correctly', async () => {
            await this.feesCalculator.setTurbulenceUpdator(updator, {from: admin});
            expect(await this.feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(new BN(0));
            await validateTurbulenceUpdate([]);
            await validateTurbulenceUpdate([SECONDS_PER_HOUR]);
            await validateTurbulenceUpdate([SECONDS_PER_HOUR + 1, SECONDS_PER_HOUR + 2, SECONDS_PER_HOUR + 3]);
            await validateTurbulenceUpdate([SECONDS_PER_HOUR - 1]);
            await validateTurbulenceUpdate([SECONDS_PER_HOUR, SECONDS_PER_HOUR, SECONDS_PER_HOUR]);
            await validateTurbulenceUpdate([SECONDS_PER_HOUR - 1, 1, SECONDS_PER_HOUR, 1000, SECONDS_PER_HOUR + 1]);
            await validateTurbulenceUpdate([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
        });*/
  })

  it.skip('calculates buying premium correctly with leverage', async () => {})

  it.skip('calculates buying premium correctly with addendum, with leverage', async () => {})

  it('calculates mapped buying premium fee correctly (no volume fee)', async () => {
    await testBuyingPremiumMapping(COLLATERAL_TO_PREMIUM_FEE_RATIOS)
  })

  it('reverts when setting buying premium fee mapping with bad values number', async () => {
    const arrayTooSmall = []
    for (let i = 0; i < COLLATERAL_TO_PREMIUM_FEE_RATIOS.length - 1; i++) {
      arrayTooSmall.push(new BN(i))
    }

    await expectRevert(
      this.feesCalculator.setCollateralToBuyingPremiumMapping(arrayTooSmall, { from: admin }),
      'Bad mapping size',
    )

    const arrayTooBig = []
    for (let i = 0; i < COLLATERAL_TO_PREMIUM_FEE_RATIOS.length + 1; i++) {
      arrayTooBig.push(new BN(i))
    }

    await expectRevert(
      this.feesCalculator.setCollateralToBuyingPremiumMapping(arrayTooBig, { from: admin }),
      'Bad mapping size',
    )
  })

  it('sets buying premium fee mapping properly', async () => {
    const newMapping = []

    for (let i = 0; i < COLLATERAL_TO_PREMIUM_FEE_RATIOS.length; i++) {
      newMapping.push(
        new BN(
          COLLATERAL_TO_PREMIUM_FEE_RATIOS[i] < 1000
            ? COLLATERAL_TO_PREMIUM_FEE_RATIOS[i] + 1
            : COLLATERAL_TO_PREMIUM_FEE_RATIOS[i] - 1,
        ),
      )
    }

    await this.feesCalculator.setCollateralToBuyingPremiumMapping(newMapping, { from: admin })

    for (let i = 0; i < COLLATERAL_TO_PREMIUM_FEE_RATIOS.length; i++) {
      expect(await this.feesCalculator.collateralToBuyingPremiumMapping(i)).to.be.bignumber.equal(newMapping[i])
    }

    await this.feesCalculator.setBuyingPremiumThreshold(0, { from: admin })
    await testBuyingPremiumMapping(newMapping)
  })

  it('calculates buying premium fee correctly (no volume fee)', async () => {
    await this.feesCalculator.setStateUpdator(updator, { from: admin })

    for (let i = 0; i < premiumFeeTests.length; i++) {
      const test = premiumFeeTests[i]

      const timestamp = await time.latest()
      const { fee, feePercentage } = calculatePremiumFee(
        toBN(0),
        timestamp,
        test.units,
        test.ratio,
        test.lastRatio,
        new BN(0),
        LP_PREMIUM_FEE_PERCENTAGE,
        MIN_PREMIUM_COLLATERLA_FEE,
      )
      const result = await this.feesCalculator.calculateBuyingPremiumFee(
        test.units,
        1,
        test.ratio,
        test.lastRatio,
        false,
      )

      expect(result[0]).to.be.bignumber.equal(fee)
      expect(result[1]).to.be.bignumber.equal(feePercentage)
    }

    await time.increase(3000)
    await this.feesCalculator.updateTurbulenceIndicatorPercent(55 * 5 * 60, 6, 50000, 60000, { from: updator }) // Increases turbulence by 1 precent

    for (let i = 0; i < premiumFeeTests.length; i++) {
      const test = premiumFeeTests[i]
      const timestamp = await time.latest()
      const { fee, feePercentage } = calculatePremiumFee(
        toBN(0),
        timestamp,
        test.units,
        test.ratio,
        test.lastRatio,
        new BN(100),
        LP_PREMIUM_FEE_PERCENTAGE,
        MIN_PREMIUM_COLLATERLA_FEE,
      )

      const result = await this.feesCalculator.calculateBuyingPremiumFee(
        test.units,
        1,
        test.ratio,
        test.lastRatio,
        false,
      )

      expect(result[0]).to.be.bignumber.equal(fee)
      expect(result[1]).to.be.bignumber.equal(feePercentage)
    }
  })

  it.skip('calculates buying premium fee correctly (with volume fee)', async () => {})

  it.skip('calculates buying premium fee with addendum correctly', async () => {})

  it.skip('buying premium fee max is never exceeded', async () => {})

  it.skip('calculates closing premium fee correctly (no close volume fee)', async () => {})

  it.skip('calculates closing premium fee correctly (with close volume fee)', async () => {})

  it.skip('calculates closing premium fee with addendum correctly', async () => {})

  it.skip('closing premium fee max is never exceeded', async () => {})

  it.skip('updates snapshot correctly for first snapshot', async () => {})

  it.skip('updates snapshot correctly when block was already updated', async () => {})

  it.skip('updates snapshot correctly when no new oracle rounds from last update', async () => {})

  it.skip('updates snapshot correctly with several new oracle rounds from last update', async () => {})

  it.skip('reverts when updating snapshots and latest oracle round is bigger than current oracle round', async () => {})

  it.skip('returns withdraw percent properly from calculate method', async () => {})

  it.skip('returns open position fees properly', async () => {})

  it.skip('calculates close position fee correctly with no lock position address', async () => {})

  it.skip('calculates close position fee correctly when decay period is over', async () => {})

  it.skip('calculates close position fee correctly during decay period', async () => {})

  it('sets and gets deposit fee correctly', async () => {
    expect(await this.feesCalculator.depositFeePercent()).to.be.bignumber.equal(new BN(0))
    await expectRevert(this.feesCalculator.setDepositFee(new BN(10), { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.feesCalculator.setDepositFee(MAX_PERCENTAGE, { from: admin }), 'Fee exceeds maximum')
    await this.feesCalculator.setDepositFee(new BN(10), { from: admin })
    expect(await this.feesCalculator.depositFeePercent()).to.be.bignumber.equal(new BN(10))
  })

  it('sets and gets withdraw fee correctly', async () => {
    expect(await this.feesCalculator.withdrawFeePercent()).to.be.bignumber.equal(new BN(0))
    await expectRevert(
      this.feesCalculator.setWithdrawFee(new BN(10), { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(this.feesCalculator.setWithdrawFee(MAX_PERCENTAGE, { from: admin }), 'Fee exceeds maximum')
    await this.feesCalculator.setWithdrawFee(new BN(10), { from: admin })
    expect(await this.feesCalculator.withdrawFeePercent()).to.be.bignumber.equal(new BN(10))
  })

  it('sets and gets open position fee correctly', async () => {
    expect(await this.feesCalculator.openPositionFeePercent()).to.be.bignumber.equal(new BN(15))
    await expectRevert(
      this.feesCalculator.setOpenPositionFee(new BN(40), { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(this.feesCalculator.setOpenPositionFee(MAX_PERCENTAGE, { from: admin }), 'Fee exceeds maximum')
    await this.feesCalculator.setOpenPositionFee(new BN(40), { from: admin })
    expect(await this.feesCalculator.openPositionFeePercent()).to.be.bignumber.equal(new BN(40))
  })

  it('sets and gets close position fee correctly', async () => {
    expect(await this.feesCalculator.closePositionFeePercent()).to.be.bignumber.equal(new BN(30))
    await expectRevert(
      this.feesCalculator.setClosePositionFee(new BN(40), { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(this.feesCalculator.setClosePositionFee(MAX_PERCENTAGE, { from: admin }), 'Fee exceeds maximum')
    await this.feesCalculator.setClosePositionFee(new BN(40), { from: admin })
    expect(await this.feesCalculator.closePositionFeePercent()).to.be.bignumber.equal(new BN(40))
  })

  it.skip('sets and gets open position LP fee correctly', async () => {})

  it.skip('sets and gets close position LP fee correctly', async () => {})

  it.skip('sets close position max fee properly', async () => {})

  it.skip('sets close position fee decay properly', async () => {})

  it.skip('sets close position fee decay properly', async () => {})

  it.skip('sets oracle heartbeat properly', async () => {})

  it.skip('sets buying premium fee max properly', async () => {})

  it.skip('sets buying premium threshold properly', async () => {})

  it.skip('sets closing premium fee max properly', async () => {})

  it.skip('sets funding fee constant rate properly', async () => {})

  it.skip('sets turbulence step properly', async () => {})

  it.skip('sets max turbulence trim fee properly', async () => {})

  it.skip('sets turbulence deviation threshold properly', async () => {})

  it.skip('sets turbulence deviation properly', async () => {})

  it.skip('sets volume time window properly', async () => {})

  it.skip('sets volume fee time window properly', async () => {})

  it.skip('sets max volume fee delta collateral properly', async () => {})

  it.skip('sets mid volume fee properly', async () => {})

  it.skip('sets max volume fee properly', async () => {})

  it.skip('sets close volume time window properly', async () => {})

  it.skip('sets close volume fee time window properly', async () => {})

  it.skip('sets close max volume fee delta collateral properly', async () => {})

  it.skip('sets close mid volume fee properly', async () => {})

  it.skip('sets close max volume fee properly', async () => {})

  //TODO: Make general for every margin
  it('calculates single unit funding fee properly (not collateral dependant)', async () => {
    const allValues = []
    let allValuesResult = new BN(0)
    for (let i = 0; i < FUNDING_FEE_TESTS.length; i++) {
      let result = calculateSingleUnitFee(FUNDING_FEE_TESTS[i][0].cviValue * 2, FUNDING_FEE_TESTS[i][0].period, 0, 2)
      const params = [{period: FUNDING_FEE_TESTS[i][0].period, cviValue: FUNDING_FEE_TESTS[i][0].cviValue * 2}]
      expect(await this.feesCalculator.calculateSingleUnitFundingFee(params, 0, 0)).to.be.bignumber.equal(result)
      allValuesResult = allValuesResult.add(result)
      allValues.push(FUNDING_FEE_TESTS[i][0])
    }

    expect(await this.feesCalculator.calculateSingleUnitFundingFee(allValues, 0, 0)).to.be.bignumber.equal(allValuesResult)
  })

  //TODO: Test funding fee when collateral is larger than 100%

  it('calculates single unit funding fee properly (collateral dependant)', async () => {
    const collateralExtraFees = []

    for (let i = 0; i < 101; i++) {
      collateralExtraFees.push(toBN(10000 * i))
    }

    await this.feesCalculator.setCollateralToExtraFundingFeeMapping(collateralExtraFees, { from: admin })

    const allValues = []
    let allValuesResult = new BN(0)
    for (let i = 0; i < FUNDING_FEE_TESTS.length; i++) {
      for (let j = 0; j < MAX_PERCENTAGE; j += 1000) {
        let result = calculateSingleUnitFee(FUNDING_FEE_TESTS[i][0].cviValue, FUNDING_FEE_TESTS[i][0].period, j)
        expect(
          await this.feesCalculator.calculateSingleUnitFundingFee(
            [{ cviValue: FUNDING_FEE_TESTS[i][0].cviValue, period: FUNDING_FEE_TESTS[i][0].period }],
            j,
          ),
        ).to.be.bignumber.equal(result)
        allValuesResult = allValuesResult.add(result)
        allValues.push(FUNDING_FEE_TESTS[i][0])
      }
    }

    expect(await this.feesCalculator.calculateSingleUnitFundingFee(allValues, 0)).to.be.bignumber.equal(allValuesResult)
  })

  it.skip('reverts when overflowing exponent while calculating single unit funding fee', async () => {})

  it.skip('sets collateral to extra funding fee mapping properly', async () => {})
})
