/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const chai = require('chai')
const expect = chai.expect

const { expectRevert, expectEvent, time, BN, balance } = require('@openzeppelin/test-helpers')
const { getContracts, getAccounts } = require('./DeployUtils.js')
const { toBN } = require('./BNUtils.js')
const {
  calculateSingleUnitFee,
  calculateSingleUnitFeeRatePercent,
  calculateNextAverageTurbulence,
  calculatePremiumFee,
  calculateClosePositionFeePercent,
  MAX_PERCENTAGE,
} = require('./FeesUtils.js')
const { print } = require('./DebugUtils')

const PRECISION_DECIMALS = toBN(1, 10)
const MAX_FEE = new BN(10000)
const HEARTBEAT = new BN(55 * 60)
const GAS_PRICE = toBN(1, 10)

const SECONDS_PER_DAY = 24 * 60 * 60

const MIN_PREMIUM_COLLATERLA_FEE = 6500

const MAX_FEE_DELTA_COLLATERAL = new BN(400)

const INITIAL_VOL_RATE = toBN(1, 12)

const LIQUIDATION_MIN_REWARD_PERCENTAGE = toBN(5)
const LEVERAGE_TO_THRESHOLD = [
  new BN(50),
  new BN(50),
  new BN(100),
  new BN(100),
  new BN(150),
  new BN(150),
  new BN(200),
  new BN(200),
]
const LIQUIDATION_MAX_FEE_PERCENTAGE = new BN(1000)
const LEVERAGE_TO_MAX = [new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30), new BN(30)]

const ALL_FEES = 0
const NO_FEES = 1

let admin

const setAccounts = async () => {
  ;[admin] = await getAccounts()
}

const getBNFee = (bigNumber, fee) => {
  return bigNumber.mul(fee).div(MAX_FEE)
}

const getFee = (amount, fee) => {
  return getBNFee(toBN(amount), fee)
}

const getAccountBalance = async account => {
  return getContracts().isETH ? await balance.current(account, 'wei') : await getContracts().token.balanceOf(account)
}

const getFeesBalance = async feesCollector => {
  return getContracts().isETH ? await balance.current(feesCollector.address, 'wei') : await feesCollector.getProfit()
}

const createState = accountsUsed => {
  const lpBalances = {}

  for (let account of accountsUsed) {
    lpBalances[account] = new BN(0)
  }

  return {
    lpTokensSupply: new BN(0),
    sharedPool: new BN(0),
    totalMarginDebt: new BN(0),
    totalFeesSent: new BN(0),
    totalPositionUnits: new BN(0),
    totalFundingFees: new BN(0),
    positions: {},
    snapshots: {},
    latestRound: undefined,
    latestSnapshotTimestamp: undefined,
    turbulence: new BN(0),
    lpBalances,
  }
}

const subtractTotalPositionUnits = (state, positionUnits, fundingFees) => {
  state.totalPositionUnits = state.totalPositionUnits.sub(positionUnits)
  if (state.totalFundingFees.lt(fundingFees)) {
    state.totalFundingFees = new BN(0)
  } else {
    state.totalFundingFees = state.totalFundingFees.sub(fundingFees)
  }
}

const calculateBalance = async (state, totalFundingFees) => {
  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue
  return state.sharedPool
    .sub(state.totalPositionUnits.mul(cviValue).div(getContracts().maxCVIValue))
    .add(totalFundingFees === undefined ? state.totalFundingFees : totalFundingFees)
}

const validateLPState = async state => {
  const feesBalance = await getFeesBalance(getContracts().fakeFeesCollector)
  expect(feesBalance).to.be.bignumber.equal(state.totalFeesSent)
  expect(await getContracts().platform.totalSupply()).to.be.bignumber.equal(state.lpTokensSupply)

  const contractBalance = await getAccountBalance(getContracts().platform.address)

  expect(contractBalance).to.be.bignumber.equal(state.sharedPool.sub(state.totalMarginDebt))

  const totalLeveragedTokens = await getContracts().platform.totalLeveragedTokensAmount()
  expect(totalLeveragedTokens).to.be.bignumber.equal(state.sharedPool)

  expect(await getContracts().platform.totalPositionUnitsAmount()).to.be.bignumber.equal(state.totalPositionUnits)
  expect(await getContracts().platform.totalFundingFeesAmount()).to.be.bignumber.equal(state.totalFundingFees)

  for (let account of Object.keys(state.lpBalances)) {
    expect(await getContracts().platform.balanceOf(account)).to.be.bignumber.equal(state.lpBalances[account])
  }

  expect(await getContracts().feesCalculator.turbulenceIndicatorPercent()).to.be.bignumber.equal(state.turbulence)

  const totalBalance = await calculateBalance(state)
  expect(await getContracts().platform.totalBalance(false)).to.be.bignumber.equal(totalBalance)

  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue
  const expectedCollateral = state.sharedPool.eq(toBN(0))
    ? MAX_PERCENTAGE
    : state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool)

  expect(await getContracts().platformHelper.collateralRatio(getContracts().platform.address)).to.be.bignumber.equal(
    expectedCollateral,
  )

  expect(await getContracts().platformHelper.dailyFundingFee(getContracts().platform.address)).to.be.bignumber.equal(
    calculateSingleUnitFeeRatePercent(cviValue, SECONDS_PER_DAY, expectedCollateral, getContracts().oracleLeverage),
  )
}

const updateSnapshots = async (state, saveSnapshot = true) => {
  const latestTimestamp = await time.latest()
  const timestamp = latestTimestamp.toNumber()

  let turbulence = state.turbulence
  let totalFundingFees = state.totalFundingFees

  if (state.snapshots[timestamp] !== undefined) {
    return {
      latestTimestamp,
      snapshot: state.snapshots[timestamp],
      latestCVIRound: state.latestRound,
      totalFundingFees,
      turbulence,
    }
  }

  const latestCVIRound = (await getContracts().fakeOracle.getCVILatestRoundData()).cviRoundId.toNumber()
  let snapshot

  if (state.latestSnapshotTimestamp === undefined) {
    snapshot = PRECISION_DECIMALS
  } else {
    let nextSnapshot = state.snapshots[state.latestSnapshotTimestamp]
    const lastTime = state.latestSnapshotTimestamp
    const lastCVIRound = await getContracts().fakeOracle.getCVIRoundData(state.latestRound)
    const lastCVI = lastCVIRound.cviValue.toNumber()
    const lastTimestamp = lastCVIRound.cviTimestamp.toNumber()
    let fundingFeesPerUnit

    if (latestCVIRound === state.latestRound) {
      fundingFeesPerUnit = calculateSingleUnitFee(lastCVI, timestamp - lastTime, undefined, getContracts().oracleLeverage)
      nextSnapshot = nextSnapshot.add(fundingFeesPerUnit)
    } else {
      const currCVI = await getContracts().fakeOracle.getCVIRoundData(latestCVIRound)
      const currTimestamp = currCVI.cviTimestamp.toNumber()
      const currCVIValue = currCVI.cviValue.toNumber()

      fundingFeesPerUnit = calculateSingleUnitFee(lastCVI, currTimestamp - lastTime, undefined, getContracts().oracleLeverage).add(
        calculateSingleUnitFee(currCVIValue, timestamp - currTimestamp, undefined, getContracts().oracleLeverage),
      )
      nextSnapshot = nextSnapshot.add(fundingFeesPerUnit)

      turbulence = calculateNextAverageTurbulence(
        state.turbulence,
        new BN(currTimestamp - lastTimestamp),
        HEARTBEAT,
        latestCVIRound - state.latestRound,
        new BN(lastCVI),
        new BN(currCVIValue),
      )
      if (saveSnapshot) {
        state.turbulence = turbulence
      }
    }

    totalFundingFees = totalFundingFees.add(fundingFeesPerUnit.mul(state.totalPositionUnits).div(PRECISION_DECIMALS))
    if (saveSnapshot) {
      state.totalFundingFees = totalFundingFees
    }

    snapshot = nextSnapshot
  }

  if (saveSnapshot) {
    state.latestSnapshotTimestamp = timestamp
    state.latestRound = latestCVIRound
    state.snapshots[timestamp] = snapshot
  }

  return { latestTimestamp, snapshot, latestCVIRound, totalFundingFees, turbulence }
}

const calculateFundingFees = (state, currTime, account, positionUnitsAmount) => {
  const position = state.positions[account]
  return state.snapshots[currTime.toNumber()]
    .sub(state.snapshots[position.creationTimestamp.toNumber()])
    .mul(positionUnitsAmount)
    .div(PRECISION_DECIMALS)
}

const calculateFundingFeesWithSnapshot = (state, currSnapshot, account, positionUnitsAmount) => {
  const position = state.positions[account]
  return currSnapshot
    .sub(state.snapshots[position.creationTimestamp.toNumber()])
    .mul(positionUnitsAmount)
    .div(PRECISION_DECIMALS)
}

const calculateFundingFeesWithTwoSnapshots = (prevSnapshot, currSnapshot, positionUnitsAmount) => {
  return currSnapshot.sub(prevSnapshot).mul(positionUnitsAmount).div(PRECISION_DECIMALS)
}

//TODO: Use in all cases
const calculatePendingFee = async (state, account, positionUnits) => {
  const { snapshot: pendingFeesSnapshot } = await updateSnapshots(state, false)

  const feesUpToLatestSnapshot = calculateFundingFeesWithSnapshot(
    state,
    state.snapshots[state.latestSnapshotTimestamp],
    account,
    positionUnits,
  )

  const feesFromLatestSnapshot = calculateFundingFeesWithTwoSnapshots(
    state.snapshots[state.latestSnapshotTimestamp],
    pendingFeesSnapshot,
    positionUnits,
  )

  return feesUpToLatestSnapshot.add(feesFromLatestSnapshot)
}

const calculateMarginDebt = (state, account) => {
  return state.positions[account].positionUnitsAmount
    .mul(state.positions[account].openCVIValue)
    .mul(state.positions[account].leverage.sub(new BN(1)))
    .div(getContracts().maxCVIValue)
    .div(state.positions[account].leverage)
}

const calculateEntirePositionBalance = async (state, account, snapshot) => {
  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue
  const position = state.positions[account]

  let updatedSnapshot = snapshot
  if (updatedSnapshot === undefined) {
    updatedSnapshot = (await updateSnapshots(state, false)).snapshot
  }

  const fundingFees = calculateFundingFeesWithSnapshot(state, updatedSnapshot, account, position.positionUnitsAmount)
  const marginDebt = calculateMarginDebt(state, account)

  const positionBalancePositive = state.positions[account].positionUnitsAmount
    .mul(cviValue)
    .div(getContracts().maxCVIValue)
  const positionBalanceNegative = fundingFees.add(marginDebt)

  if (positionBalanceNegative.gt(positionBalancePositive)) {
    return {
      positionBalance: positionBalanceNegative.sub(positionBalancePositive),
      isPositive: false,
      fundingFees,
      marginDebt,
    }
  }

  return {
    positionBalance: positionBalancePositive.sub(positionBalanceNegative),
    isPositive: true,
    fundingFees,
    marginDebt,
  }
}

const isLiquidable = (positionBalance, isPositive, position) => {
  const leverage = position.leverage
  const openCVIValue = position.openCVIValue

  const liquidationBalance = position.positionUnitsAmount
    .mul(LEVERAGE_TO_THRESHOLD[leverage.toNumber() - 1])
    .mul(openCVIValue)
    .div(getContracts().maxCVIValue)
    .div(leverage)
    .div(LIQUIDATION_MAX_FEE_PERCENTAGE)

  return { liquidable: !isPositive || positionBalance.lt(liquidationBalance), liquidationBalance }
}

const calculateLiquidationCVI = async (state, account) => {
  const { positionBalance, isPositive } = await calculateEntirePositionBalance(state, account)

  const position = state.positions[account]

  const { liquidable, liquidationBalance } = isLiquidable(positionBalance, isPositive, position)
  if (liquidable) {
    return null
  } else {
    const leftToLose = positionBalance.sub(liquidationBalance)

    // LeftToLose <= (openCVI - currCVI) * PU / maxCVI => currCVI <= openCVI - LeftToLose * maxCVI / PU
    let loseCVI = position.openCVIValue.sub(
      leftToLose.mul(getContracts().maxCVIValue).div(position.positionUnitsAmount),
    )

    while (
      leftToLose.gte(
        position.openCVIValue.sub(loseCVI).mul(position.positionUnitsAmount).div(getContracts().maxCVIValue),
      )
    ) {
      loseCVI = loseCVI.sub(new BN(10))
    }
    return loseCVI
  }
}

const calculateLiquidationDays = async (state, account, cviValue, negativeOnly = false) => {
  const { positionBalance, isPositive } = await calculateEntirePositionBalance(state, account)
  const position = state.positions[account]

  const { liquidable, liquidationBalance } = isLiquidable(positionBalance, isPositive, position)
  if (liquidable) {
    return null
  } else {
    const leftToLose = negativeOnly ? positionBalance : positionBalance.sub(liquidationBalance)

    const singlePositionUnitDaiilyFee = calculateSingleUnitFee(cviValue, 3600 * 24, undefined, getContracts().oracleLeverage)
    const daiilyFundingFee = position.positionUnitsAmount.mul(singlePositionUnitDaiilyFee).div(toBN(1, 10))

    return leftToLose.div(daiilyFundingFee).add(new BN(1))
  }
}

const getLiquidationReward = (positionBalance, isPositive, position) => {
  const positionUnitsAmount = position.positionUnitsAmount
  const openCVIValue = position.openCVIValue
  const leverage = position.leverage

  const balance = positionUnitsAmount
    .mul(new BN(openCVIValue))
    .div(getContracts().maxCVIValue)
    .sub(
      positionUnitsAmount
        .mul(new BN(openCVIValue))
        .div(getContracts().maxCVIValue)
        .mul(leverage.sub(new BN(1)))
        .div(position.leverage),
    )

  if (
    !isPositive ||
    toBN(positionBalance).lt(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE))
  ) {
    return toBN(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE))
  }

  if (
    isPositive &&
    toBN(positionBalance).gte(balance.mul(LIQUIDATION_MIN_REWARD_PERCENTAGE).div(LIQUIDATION_MAX_FEE_PERCENTAGE)) &&
    toBN(positionBalance).lte(
      toBN(balance)
        .mul(LEVERAGE_TO_MAX[leverage.toNumber() - 1])
        .div(LIQUIDATION_MAX_FEE_PERCENTAGE),
    )
  ) {
    return toBN(positionBalance)
  }

  return balance.mul(LEVERAGE_TO_MAX[leverage.toNumber() - 1]).div(LIQUIDATION_MAX_FEE_PERCENTAGE)
}

const calculateLPTokens = async (state, tokens, totalFundingFees) => {
  const balance = await calculateBalance(state, totalFundingFees)

  if (balance.eq(new BN(0)) || state.lpTokensSupply.eq(new BN(0))) {
    return tokens.mul(getContracts().initialRate)
  }

  return tokens.mul(state.lpTokensSupply).div(balance)
}

const calculateDepositAmounts = async (state, amount, totalFundingFees, hasFees = true) => {
  const depositFees = await getContracts().feesCalculator.depositFeePercent()

  const depositTokens = new BN(amount)
  const depositTokenFees = hasFees ? getFee(amount, depositFees) : toBN(0)
  const depositTokenMinusFees = depositTokens.sub(depositTokenFees)
  const lpTokens = await calculateLPTokens(state, depositTokenMinusFees, totalFundingFees)
  return { depositTokens, depositTokenFees, depositTokenMinusFees, lpTokens }
}

const calculateWithdrawAmounts = async (state, amount, totalFundingFees) => {
  const withdrawFees = await getContracts().feesCalculator.withdrawFeePercent()

  const withdrawTokens = new BN(amount)
  const withdrawTokenFees = getFee(amount, withdrawFees)
  const withdrawTokenMinusFees = withdrawTokens.sub(withdrawTokenFees)

  const burnedLPTokens = withdrawTokens
    .mul(state.lpTokensSupply)
    .sub(new BN(1))
    .div(await calculateBalance(state, totalFundingFees))
    .add(new BN(1))

  return { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens }
}

const calculateTokensByBurntLPTokensAmount = async (state, burnAmount, totalFundingFees) => {
  return burnAmount.mul(await calculateBalance(state, totalFundingFees)).div(state.lpTokensSupply)
}

const calculateOpenPositionAmounts = async (
  state,
  timestamp,
  amount,
  noPremiumFee,
  leverage = 1,
  saveState = true,
) => {
  const openPositionFeePercent = await getContracts().feesCalculator.openPositionFeePercent()
  const openPositionLPFeePercent = await getContracts().feesCalculator.openPositionLPFeePercent()
  const turbulencePercent = state.turbulence

  const openPositionTokens = new BN(amount)
  const openPositionTokensFees =
    noPremiumFee === NO_FEES ? toBN(0) : getFee(openPositionTokens.mul(new BN(leverage)), openPositionFeePercent)

  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue
  const expectedPositionUnits = openPositionTokens
    .sub(openPositionTokensFees)
    .mul(new BN(leverage))
    .mul(getContracts().maxCVIValue)
    .div(cviValue)
  const expectedCollateral = state.totalPositionUnits
    .add(expectedPositionUnits)
    .mul(PRECISION_DECIMALS)
    .div(state.sharedPool.add(openPositionTokens.sub(openPositionTokensFees).mul(new BN(leverage))))
  const lastCollateral = state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool)

  const result = calculatePremiumFee(
    timestamp,
    expectedPositionUnits,
    expectedCollateral,
    lastCollateral,
    turbulencePercent,
    undefined,
    MIN_PREMIUM_COLLATERLA_FEE,
    undefined,
  )
  const premiumPercent = result.feePercentage

  const openPositionPremiumFees =
    noPremiumFee === NO_FEES ? toBN(0) : getFee(openPositionTokens.mul(new BN(leverage)), premiumPercent)
  const openPositionTokensMinusFees = openPositionTokens.sub(openPositionTokensFees).sub(openPositionPremiumFees)
  const openPositionLeveragedTokens = openPositionTokensMinusFees.mul(new BN(leverage))

  const positionUnits = openPositionLeveragedTokens.mul(getContracts().maxCVIValue).div(cviValue)

  return {
    openPositionTokens,
    openPositionTokensFees,
    openPositionPremiumFees,
    premiumPercentage: noPremiumFee == NO_FEES ? toBN(0) : premiumPercent,
    openPositionTokensMinusFees,
    openPositionLeveragedTokens,
    positionUnits,
    volumeFeePercentage: result.volumeFeePercentage,
  }
}

const calculatePositionBalance = async positionUnits => {
  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue
  return positionUnits.mul(cviValue).div(getContracts().maxCVIValue)
}

const calculateMintAmount = async (
  state,
  amount,
  premiumFees,
  margin,
  snapshot,
  lastLatestSnapshotTimestamp,
  chargeFees = true,
) => {
  const oracleMargin = getContracts().oracleLeverage
  const openFees = await getContracts().feesCalculator.openPositionFeePercent()

  const openFeesAmount = chargeFees ? amount.mul(margin).mul(openFees).div(MAX_FEE) : toBN(0)
  const positionedTokenAmount = amount.sub(openFeesAmount).sub(premiumFees)

  // Note: must split to up to latest snapshot time and from latest snapshot, unless no latest snapshot timestamp
  let fundingFees = toBN(0)
  if (state.positions[getContracts().volToken[oracleMargin.toString()].address] !== undefined) {
    if (lastLatestSnapshotTimestamp === undefined) {
      fundingFees = await calculateFundingFeesWithSnapshot(
        state,
        snapshot,
        getContracts().volToken[oracleMargin.toString()].address,
        state[oracleMargin.toString()].volTokenPositionUnits,
      )
    } else {
      fundingFees =
        state.positions[getContracts().volToken[oracleMargin.toString()].address] === undefined
          ? new BN(0)
          : await calculateFundingFeesWithSnapshot(
              state,
              snapshot,
              getContracts().volToken[oracleMargin.toString()].address,
              state[oracleMargin.toString()].volTokenPositionUnits,
            ) 
/*
          (
              await calculateFundingFees(
                state,
                toBN(lastLatestSnapshotTimestamp),
                getContracts().volToken[oracleMargin.toString()].address,
                state[oracleMargin.toString()].volTokenPositionUnits,
              )
            ).add(
              calculateFundingFeesWithTwoSnapshots(
                state.snapshots[lastLatestSnapshotTimestamp],
                snapshot,
                state[oracleMargin.toString()].volTokenPositionUnits,
              ),
            )*/
    }
  }

  const currPosition = state.positions[getContracts().volToken[oracleMargin.toString()].address]

  let marginDebt = new BN(0)
  if (currPosition !== undefined) {
    marginDebt = margin
      .sub(new BN(1))
      .mul(state[oracleMargin.toString()].volTokenPositionUnits)
      .mul(currPosition.openCVIValue)
      .div(getContracts().maxCVIValue)
      .div(margin)
  }

  const positionBalance = (await calculatePositionBalance(state[oracleMargin.toString()].volTokenPositionUnits))
    .sub(marginDebt)
    .sub(fundingFees)

  // positionAmount / positionBalance = mintedToken / totalySupply => mintedTokens = positionAmount * totalSupply / positionBalance
  const volTokens = state[oracleMargin.toString()].volTokenSupply.eq(new BN(0))
    ? positionedTokenAmount.mul(INITIAL_VOL_RATE)
    : positionedTokenAmount.mul(state[oracleMargin.toString()].volTokenSupply).div(positionBalance)

  return { positionedTokenAmount, volTokens }
}

const calculateBurnAmount = async (state, amount, time, margin, snapshot, chargeFees = true) => {
  const oracleMargin = getContracts().oracleLeverage
  const currPosition = state.positions[getContracts().volToken[oracleMargin.toString()].address]

  expect(currPosition.leverage.toString()).to.equal(margin.toString())

  const positionUnitsToBurn = amount
    .mul(state[oracleMargin.toString()].volTokenPositionUnits)
    .div(state[oracleMargin.toString()].volTokenSupply)
  const positionBalance = await calculatePositionBalance(positionUnitsToBurn)

  const marginDebt = currPosition.leverage
    .sub(new BN(1))
    .mul(positionUnitsToBurn)
    .mul(currPosition.openCVIValue)
    .div(getContracts().maxCVIValue)
    .div(currPosition.leverage)

  const fundingFees =
    snapshot === undefined
      ? await calculateFundingFees(state, time, getContracts().volToken[oracleMargin.toString()].address, positionUnitsToBurn)
      : calculateFundingFeesWithSnapshot(
          state,
          snapshot,
          getContracts().volToken[oracleMargin.toString()].address,
          positionUnitsToBurn,
        )

  const closeFeesPercent = chargeFees ? await getContracts().feesCalculator.closePositionFeePercent() : toBN(0)
  const closeFees = positionBalance.sub(fundingFees).sub(marginDebt).mul(closeFeesPercent).div(MAX_FEE)

  const tokensReceived = positionBalance.sub(marginDebt).sub(fundingFees).sub(closeFees)

  return {
    tokensReceived,
    positionBalance,
    closeFees,
    fundingFees,
    positionUnitsClosed: positionUnitsToBurn,
    marginDebt,
  }
}

const deposit = (tokens, minLPTokens, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.depositETH(minLPTokens, { value: tokens, from: account, gasPrice: GAS_PRICE })
  } else {
    return getContracts().platform.deposit(tokens, minLPTokens, { from: account })
  }
}

const callDeposit = (tokens, minLPTokens, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.depositETH.call(minLPTokens, { value: tokens, from: account, gasPrice: GAS_PRICE })
  } else {
    return getContracts().platform.deposit.call(tokens, minLPTokens, { from: account })
  }
}

const withdraw = (tokens, maxLPTokensBurn, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.withdraw(tokens, maxLPTokensBurn, { from: account, gasPrice: GAS_PRICE })
  } else {
    return getContracts().platform.withdraw(tokens, maxLPTokensBurn, { from: account })
  }
}

const withdrawLPTokens = (lpTokens, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.withdrawLPTokens(lpTokens, { from: account, gasPrice: GAS_PRICE })
  } else {
    return getContracts().platform.withdrawLPTokens(lpTokens, { from: account })
  }
}

const callWithdraw = (tokens, maxLPTokensBurn, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.withdraw.call(tokens, maxLPTokensBurn, { from: account, gasPrice: GAS_PRICE })
  } else {
    return getContracts().platform.withdraw.call(tokens, maxLPTokensBurn, { from: account })
  }
}

const callWithdrawLPTokens = (lpTokens, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.withdrawLPTokens.call(lpTokens, { from: account, gasPrice: GAS_PRICE })
  } else {
    return getContracts().platform.withdrawLPTokens.call(lpTokens, { from: account })
  }
}

const openPosition = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
  if (getContracts().isETH) {
    return getContracts().platform.openPositionETH(cviValue, maxBuyingPremiumPercent, leverage, {
      value: tokens,
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.openPosition(tokens, cviValue, maxBuyingPremiumPercent, leverage, { from: account })
  }
}

const callOpenPosition = (tokens, cviValue, account, maxBuyingPremiumPercent = 1000, leverage = 1) => {
  if (getContracts().isETH) {
    return getContracts().platform.openPositionETH.call(cviValue, maxBuyingPremiumPercent, leverage, {
      value: tokens,
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.openPosition.call(tokens, cviValue, maxBuyingPremiumPercent, leverage, {
      from: account,
    })
  }
}

const openPositionWithoutFee = (tokens, cviValue, account, leverage = 1) => {
  if (getContracts().isETH) {
    return getContracts().platform.openPositionWithoutFeeETH(cviValue, leverage, {
      value: tokens,
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.openPositionWithoutFee(tokens, cviValue, leverage, { from: account })
  }
}

const callOpenPositionWithoutFee = (tokens, cviValue, account, leverage = 1) => {
  if (getContracts().isETH) {
    return getContracts().platform.openPositionWithoutFeeETH.call(cviValue, leverage, {
      value: tokens,
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.openPositionWithoutFee.call(tokens, cviValue, leverage, { from: account })
  }
}

const closePosition = (positionUnits, cviValue, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.closePosition(positionUnits, cviValue, {
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.closePosition(positionUnits, cviValue, { from: account })
  }
}

const callClosePosition = (positionUnits, cviValue, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.closePosition.call(positionUnits, cviValue, {
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.closePosition.call(positionUnits, cviValue, {
      from: account,
    })
  }
}

const closePositionWithoutFee = (positionUnits, cviValue, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.closePositionWithoutFee(positionUnits, cviValue, {
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.closePositionWithoutFee(positionUnits, cviValue, { from: account })
  }
}

const callClosePositionWithoutFee = (positionUnits, cviValue, account) => {
  if (getContracts().isETH) {
    return getContracts().platform.closePositionWithoutFee.call(positionUnits, cviValue, {
      from: account,
      gasPrice: GAS_PRICE,
    })
  } else {
    return getContracts().platform.closePositionWithoutFee.call(positionUnits, cviValue, { from: account })
  }
}

const depositAndValidate = async (state, depositTokensNumber, account, totalFundingFees) => {
  const { depositTokens, depositTokenFees, depositTokenMinusFees } = await calculateDepositAmounts(
    state,
    depositTokensNumber,
  )

  if (!getContracts().isETH) {
    await getContracts().token.transfer(account, depositTokens, { from: admin })
    await getContracts().token.approve(getContracts().platform.address, depositTokens, { from: account })
  }

  const beforeBalance = await getAccountBalance(account)

  const result = await callDeposit(depositTokens, new BN(0), account)
  const { totalFundingFees: totalFundingFeesCall } = await updateSnapshots(state, false)

  const tx = await deposit(depositTokens, new BN(0), account)
  const { latestTimestamp: depositTimestamp } = await updateSnapshots(state)

  const { lpTokens } = await calculateDepositAmounts(state, depositTokensNumber)
  const { lpTokens: lpTokensCall } = await calculateDepositAmounts(state, depositTokensNumber, totalFundingFeesCall)

  expect(result).to.be.bignumber.equal(lpTokensCall)

  print('DEPOSIT: ' + tx.receipt.gasUsed.toString())

  await expectEvent(tx, 'Deposit', {
    account,
    tokenAmount: depositTokens,
    lpTokensAmount: lpTokens,
    feeAmount: depositTokenFees,
  })

  const afterBalance = await getAccountBalance(account)

  if (getContracts().isETH) {
    expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(
      depositTokens.add(new BN(tx.receipt.gasUsed).mul(GAS_PRICE)),
    )
  } else {
    expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(depositTokens)
  }

  state.lpTokensSupply = state.lpTokensSupply.add(lpTokens)
  state.sharedPool = state.sharedPool.add(depositTokenMinusFees)
  state.totalFeesSent = state.totalFeesSent.add(depositTokenFees)

  state.lpBalances[account] = state.lpBalances[account].add(lpTokens)

  await validateLPState(state)

  return { depositTimestamp, gasUsed: new BN(tx.receipt.gasUsed).mul(GAS_PRICE) }
}

const withdrawAndValidate = async (state, withdrawTokensNumber, account, lpTokens) => {
  let { withdrawTokens, withdrawTokenFees, withdrawTokenMinusFees, burnedLPTokens } = await calculateWithdrawAmounts(
    state,
    withdrawTokensNumber,
  )

  if (lpTokens !== undefined) {
    burnedLPTokens = lpTokens
  }

  const beforeBalance = await getAccountBalance(account)

  const result =
    lpTokens === undefined
      ? await callWithdraw(withdrawTokens, burnedLPTokens, account)
      : await callWithdrawLPTokens(burnedLPTokens, account)
  const { latestTimestamp: timestampCall, totalFundingFees: totalFundingFeesCall } = await updateSnapshots(state, false)

  const tx =
    lpTokens === undefined
      ? await withdraw(withdrawTokens, burnedLPTokens, account)
      : await withdrawLPTokens(burnedLPTokens, account)
  const { latestTimestamp: timestamp } = await updateSnapshots(state)

  let burnedLPTokensCall, withdrawTokensMinusFeesCall

  if (lpTokens === undefined) {
    const results = await calculateWithdrawAmounts(state, withdrawTokens)
    const resultsCall = await calculateWithdrawAmounts(state, withdrawTokens, totalFundingFeesCall)

    burnedLPTokens = results.burnedLPTokens
    withdrawTokenMinusFees = results.withdrawTokenMinusFees
    withdrawTokenFees = results.withdrawTokenFees

    burnedLPTokensCall = resultsCall.burnedLPTokens
    withdrawTokensMinusFeesCall = resultsCall.withdrawTokenMinusFees
  } else {
    burnedLPTokens = lpTokens
    burnedLPTokensCall = lpTokens

    withdrawTokens = await calculateTokensByBurntLPTokensAmount(state, burnedLPTokens)
    const withdrawTokensCall = await calculateTokensByBurntLPTokensAmount(state, burnedLPTokens, totalFundingFeesCall)

    const results = await calculateWithdrawAmounts(state, withdrawTokens)
    const resultsCall = await calculateWithdrawAmounts(state, withdrawTokensCall, totalFundingFeesCall)

    withdrawTokenFees = results.withdrawTokenFees
    withdrawTokenMinusFees = results.withdrawTokenMinusFees

    withdrawTokensMinusFeesCall = resultsCall.withdrawTokenMinusFees
  }

  expect(result.burntAmount).to.be.bignumber.equal(burnedLPTokensCall)
  expect(result.withdrawnAmount).to.be.bignumber.equal(withdrawTokensMinusFeesCall)

  await expectEvent(tx, 'Withdraw', {
    account,
    tokenAmount: withdrawTokens,
    lpTokensAmount: burnedLPTokens,
    feeAmount: withdrawTokenFees,
  })

  print('WITHDRAW: ' + tx.receipt.gasUsed.toString())

  const afterBalance = await getAccountBalance(account)

  state.totalFeesSent = state.totalFeesSent.add(withdrawTokenFees)
  state.lpTokensSupply = state.lpTokensSupply.sub(burnedLPTokens)
  state.sharedPool = state.sharedPool.sub(withdrawTokens)

  state.lpBalances[account] = state.lpBalances[account].sub(burnedLPTokens)

  await validateLPState(state)

  if (getContracts().isETH) {
    expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(
      withdrawTokenMinusFees.sub(new BN(tx.receipt.gasUsed).mul(GAS_PRICE)),
    )
  } else {
    expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(withdrawTokenMinusFees)
  }

  return { timestamp, gasUsed: new BN(tx.receipt.gasUsed).mul(GAS_PRICE) }
}

const validatePosition = (actualPosition, expectedPosition) => {
  expect(actualPosition.positionUnitsAmount).to.be.bignumber.equal(expectedPosition.positionUnitsAmount)
  expect(actualPosition.leverage).to.be.bignumber.equal(expectedPosition.leverage)
  expect(actualPosition.openCVIValue).to.be.bignumber.equal(expectedPosition.openCVIValue)
  expect(actualPosition.creationTimestamp).to.be.bignumber.equal(expectedPosition.creationTimestamp)
  expect(actualPosition.originalCreationTimestamp).to.be.bignumber.equal(expectedPosition.originalCreationTimestamp)
}

// NOTE: validateRewards is currently deprecated (might be used again in future)
const openPositionAndValidate = async (
  state,
  amount,
  account,
  validateRewards = true,
  noPremiumFee = ALL_FEES,
  leverage = 1,
  shouldLiquidate = false,
) => {
  const isMerge = state.positions[account] !== undefined
  const openPositionTokens = new BN(amount)

  if (!getContracts().isETH) {
    await getContracts().token.transfer(account, openPositionTokens, { from: admin })
    await getContracts().token.approve(getContracts().platform.address, openPositionTokens, { from: account })
  }

  const beforeBalance = await getAccountBalance(account)

  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue

  const result =
    noPremiumFee === NO_FEES
      ? await callOpenPositionWithoutFee(openPositionTokens, cviValue, account, leverage)
      : await callOpenPosition(openPositionTokens, cviValue, account, 1000, leverage)
  const { latestTimestamp: timestampCall, snapshot: snapshotCall } = await updateSnapshots(state, false)
  const tx =
    noPremiumFee === NO_FEES
      ? await openPositionWithoutFee(openPositionTokens, cviValue, account, leverage)
      : await openPosition(openPositionTokens, cviValue, account, 1000, leverage)
  const { latestTimestamp: timestamp } = await updateSnapshots(state)

  print('OPEN: ' + tx.receipt.gasUsed.toString())

  const { positionUnits: positionUnitsCall } = await calculateOpenPositionAmounts(
    state,
    timestampCall,
    amount,
    noPremiumFee,
    leverage,
    false,
  )

  const {
    openPositionTokensFees,
    openPositionPremiumFees,
    premiumPercentage,
    openPositionTokensMinusFees,
    openPositionLeveragedTokens,
    positionUnits,
    volumeFeePercentage,
  } = await calculateOpenPositionAmounts(state, timestamp, amount, noPremiumFee, leverage)

  let finalPositionUnits = positionUnits
  let finalPositionUnitsCall = positionUnitsCall
  let positionUnitsAdded = finalPositionUnits
  if (isMerge) {
    const oldPositionUnits = state.positions[account].positionUnitsAmount
    const fundingFees = calculateFundingFees(state, timestamp, account, state.positions[account].positionUnitsAmount)
    const fundingFeesCall = calculateFundingFeesWithSnapshot(
      state,
      snapshotCall,
      account,
      state.positions[account].positionUnitsAmount,
    )
    const marginDebt = state.positions[account].positionUnitsAmount
      .mul(state.positions[account].openCVIValue)
      .mul(state.positions[account].leverage.sub(new BN(1)))
      .div(getContracts().maxCVIValue)
      .div(state.positions[account].leverage)

    const positionBalance = state.positions[account].positionUnitsAmount
      .mul(cviValue)
      .div(getContracts().maxCVIValue)
      .sub(fundingFees)
      .sub(marginDebt)
    const positionBalanceCall = state.positions[account].positionUnitsAmount
      .mul(cviValue)
      .div(getContracts().maxCVIValue)
      .sub(fundingFeesCall)
      .sub(marginDebt)

    if (!shouldLiquidate) {
      finalPositionUnits = positionBalance
        .add(openPositionTokensMinusFees)
        .mul(new BN(leverage))
        .mul(getContracts().maxCVIValue)
        .div(cviValue)
      finalPositionUnitsCall = positionBalanceCall
        .add(openPositionTokensMinusFees)
        .mul(new BN(leverage))
        .mul(getContracts().maxCVIValue)
        .div(cviValue)

      positionUnitsAdded = new BN(0)
      if (oldPositionUnits.lt(finalPositionUnits)) {
        positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits)
      }
    } else {
      await expectEvent(tx, 'LiquidatePosition', {
        positionAddress: account,
        currentPositionBalance: positionBalance.mul(toBN(-1)),
        isBalancePositive: false,
        positionUnitsAmount: state.positions[account].positionUnitsAmount,
      })
    }

    subtractTotalPositionUnits(state, oldPositionUnits, fundingFees)

    if (shouldLiquidate) {
      state.sharedPool.sub(marginDebt)
      state.totalMarginDebt.sub(marginDebt)
    } else {
      state.sharedPool = state.sharedPool
        .sub(positionBalance)
        .sub(marginDebt)
        .add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(leverage)))
        .add(openPositionPremiumFees)
      state.totalMarginDebt = state.totalMarginDebt
        .sub(marginDebt)
        .add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(leverage).sub(new BN(1))))
    }
  }

  await expectEvent(tx, 'OpenPosition', {
    account,
    tokenAmount: openPositionTokens,
    leverage: toBN(leverage),
    feeAmount: openPositionTokensFees.add(openPositionPremiumFees),
    positionUnitsAmount: finalPositionUnits,
    cviValue,
  })

  const expectedPosition = {
    positionUnitsAmount: finalPositionUnits,
    creationTimestamp: timestamp,
    openCVIValue: cviValue,
    leverage: new BN(leverage),
    originalCreationTimestamp: isMerge ? state.positions[account].originalCreationTimestamp : timestamp,
  }
  const actualPosition = await getContracts().platform.positions(account)
  validatePosition(actualPosition, expectedPosition)

  expect(result.positionUnitsAmount).to.be.bignumber.equal(finalPositionUnitsCall)
  expect(result.positionedTokenAmount).to.be.bignumber.equal(openPositionLeveragedTokens)

  state.totalPositionUnits = state.totalPositionUnits.add(finalPositionUnits)
  state.positions[account] = expectedPosition

  state.totalFeesSent = state.totalFeesSent.add(openPositionTokensFees)

  if (!isMerge || shouldLiquidate) {
    state.sharedPool = state.sharedPool.add(openPositionLeveragedTokens).add(openPositionPremiumFees)
    state.totalMarginDebt = state.totalMarginDebt.add(openPositionLeveragedTokens.sub(openPositionTokensMinusFees))
  }

  await validateLPState(state)

  const afterBalance = await getAccountBalance(account)

  if (getContracts().isETH) {
    expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(
      openPositionTokens.add(new BN(tx.receipt.gasUsed).mul(GAS_PRICE)),
    )
  } else {
    expect(beforeBalance.sub(afterBalance)).to.be.bignumber.equal(openPositionTokens)
  }

  return {
    positionUnits: finalPositionUnits,
    timestamp,
    positionUnitsAdded,
    gasUsed: new BN(tx.receipt.gasUsed).mul(GAS_PRICE),
    volumeFeePercentage,
    premiumPercentage,
  }
}

const validateEmptyPosition = position => {
  expect(position.positionUnitsAmount).to.be.bignumber.equal(new BN(0))
  expect(position.creationTimestamp).to.be.bignumber.equal(new BN(0))
}

const closePositionAndValidate = async (
  state,
  positionUnits,
  account,
  shouldLiquidate = false,
  isNoLockPositionAddress = false,
  noFee = false,
) => {
  const currPosition = state.positions[account]
  const actualPositionUnits = shouldLiquidate ? currPosition.positionUnitsAmount : positionUnits
  const positionBalance = await calculatePositionBalance(actualPositionUnits)
  const closePositionFeePercent = await getContracts().feesCalculator.closePositionFeePercent()

  const marginDebt = currPosition.leverage
    .sub(new BN(1))
    .mul(actualPositionUnits)
    .mul(currPosition.openCVIValue)
    .div(getContracts().maxCVIValue)
    .div(currPosition.leverage)

  const beforeBalance = await getAccountBalance(account)

  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue

  const result = noFee
    ? await callClosePositionWithoutFee(positionUnits, cviValue, account)
    : await callClosePosition(positionUnits, cviValue, account)

  const { latestTimestamp: timestampCall, snapshot: snapshotCall } = await updateSnapshots(state, false)

  const tx = noFee
    ? await closePositionWithoutFee(positionUnits, cviValue, account)
    : await closePosition(positionUnits, cviValue, account)
  const { latestTimestamp: timestamp } = await updateSnapshots(state)

  print('CLOSE: ' + tx.receipt.gasUsed.toString())

  const fundingFees = calculateFundingFees(state, timestamp, account, actualPositionUnits)
  const fundingFeesCall = calculateFundingFeesWithSnapshot(state, snapshotCall, account, actualPositionUnits)

  const positionBalanceAfterFundingFees = positionBalance.sub(fundingFees)
  const positionBalanceAfterFundingFeesCall = positionBalance.sub(fundingFeesCall)

  const closeFees = calculateClosePositionFeePercent(
    timestamp,
    currPosition.creationTimestamp,
    isNoLockPositionAddress,
    closePositionFeePercent,
  )
  const closeFeesCall = await getContracts().feesCalculator.calculateClosePositionFeePercent(
    currPosition.creationTimestamp,
    isNoLockPositionAddress,
  )
  expect(closeFeesCall).to.be.bignumber.equal(closeFees)

  const closePositionTokensFees = getFee(positionBalanceAfterFundingFees.sub(marginDebt), closeFees)
  const closePositionTokensFeesCall = getFee(positionBalanceAfterFundingFeesCall.sub(marginDebt), closeFees)

  const afterBalance = await getAccountBalance(account)

  const originalPositionUnits = currPosition.positionUnitsAmount
  currPosition.positionUnitsAmount = currPosition.positionUnitsAmount.sub(actualPositionUnits)

  const finalPositionUnits = currPosition.positionUnitsAmount
  if (currPosition.positionUnitsAmount.eq(new BN(0))) {
    const actualPosition = await getContracts().platform.positions(account)
    validateEmptyPosition(actualPosition)
    delete state.positions[account]
  } else {
    const actualPosition = await getContracts().platform.positions(account)
    validatePosition(actualPosition, currPosition)
  }

  const lastCollateral = state.totalPositionUnits.mul(PRECISION_DECIMALS).div(state.sharedPool)
  subtractTotalPositionUnits(state, actualPositionUnits, fundingFees)
  const expectedCollateral = state.totalPositionUnits
    .mul(PRECISION_DECIMALS)
    .div(state.sharedPool.sub(positionBalance).add(fundingFees))

  const premiumFeeResult = calculatePremiumFee(
    timestamp,
    positionBalanceAfterFundingFees.sub(marginDebt),
    expectedCollateral,
    lastCollateral,
    toBN(0),
    toBN(0),
    undefined,
    undefined,
    false,
  )
  const premiumPercent = premiumFeeResult.feePercentage
  const premiumFee = premiumFeeResult.fee

  const premiumFeeResultCall = calculatePremiumFee(
    timestampCall,
    positionBalanceAfterFundingFeesCall.sub(marginDebt),
    expectedCollateral,
    lastCollateral,
    toBN(0),
    toBN(0),
    undefined,
    undefined,
    false,
  )
  const premiumFeeCall = premiumFeeResultCall.fee

  const totalFees = closePositionTokensFees.add(fundingFees).add(premiumFee)
  const totalFeesCall = closePositionTokensFeesCall.add(fundingFeesCall).add(premiumFeeCall)

  if (shouldLiquidate) {
    await expectEvent(tx, 'LiquidatePosition', {
      positionAddress: account,
      currentPositionBalance: positionBalanceAfterFundingFees.sub(marginDebt).mul(toBN(-1)),
      isBalancePositive: false,
      positionUnitsAmount: originalPositionUnits,
    })
  } else {
    await expectEvent(tx, 'ClosePosition', {
      account,
      tokenAmount: positionBalance.sub(marginDebt),
      feeAmount: totalFees,
      positionUnitsAmount: finalPositionUnits,
      cviValue,
    })
  }

  if (!shouldLiquidate) {
    state.totalFeesSent = state.totalFeesSent.add(closePositionTokensFees)
    state.sharedPool = state.sharedPool.sub(positionBalance).add(fundingFees).add(premiumFee)
  } else {
    state.sharedPool = state.sharedPool.sub(marginDebt)
  }

  state.totalMarginDebt = state.totalMarginDebt.sub(marginDebt)

  await validateLPState(state)

  if (getContracts().isETH) {
    expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(
      (shouldLiquidate ? toBN(0) : positionBalance.sub(totalFees).sub(marginDebt)).sub(
        new BN(tx.receipt.gasUsed).mul(GAS_PRICE),
      ),
    )
  } else {
    expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(
      shouldLiquidate ? toBN(0) : positionBalance.sub(totalFees).sub(marginDebt),
    )
  }

  expect(result.tokenAmount).to.be.bignumber.equal(shouldLiquidate ? toBN(0) : positionBalance.sub(totalFeesCall).sub(marginDebt))
  expect(result.closePositionFee).to.be.bignumber.equal(shouldLiquidate ? toBN(0) : closePositionTokensFeesCall)
  expect(result.closingPremiumFee).to.be.bignumber.equal(shouldLiquidate ? toBN(0) : premiumFeeCall)


  return {
    balance: positionBalance.sub(totalFees).sub(marginDebt),
    fundingFees,
    timestamp,
    gasUsed: toBN(tx.receipt.gasUsed).mul(GAS_PRICE),
    volumeFeePercentage: premiumFeeResult.volumeFeePercentage,
    volumeFee: premiumFee,
    closeFeePercentage: closeFees,
  }
}

const liquidateAndValidate = async (state, accounts, liquidator, shouldLiquidate) => {
  let expectedFinderFeeAmount = new BN(0)
  let expectedFinderFeeAmountCall = new BN(0)

  const expectLiquidation = Array.isArray(shouldLiquidate) || shouldLiquidate === true || shouldLiquidate === undefined

  if (expectLiquidation) {
    const beforeBalances = {}

    for (let account of accounts) {
      beforeBalances[account] = await getAccountBalance(account)
    }

    const liquidatorBeforeBalance = await getAccountBalance(liquidator)

    const result = await getContracts().platform.liquidatePositions.call(accounts, {
      from: liquidator,
      gasPrice: GAS_PRICE,
    })
    const { snapshot: snapshotCall } = await updateSnapshots(state, false)

    const tx = await getContracts().platform.liquidatePositions(accounts, { from: liquidator, gasPrice: GAS_PRICE })
    const { snapshot } = await updateSnapshots(state)

    const positionBalances = {}
    const positionBalancesCall = {}

    let accountIndex = 0
    for (let account of accounts) {
      const { positionBalance, isPositive, fundingFees, marginDebt } = await calculateEntirePositionBalance(
        state,
        account,
        snapshot,
      )
      positionBalances[account] = { positionBalance, isPositive, fundingFees, marginDebt }

      const {
        positionBalance: positionBalanceCall,
        isPositive: isPositiveCall,
        fundingFees: fundingFeesCall,
        marginDebt: marginDebtCall,
      } = await calculateEntirePositionBalance(state, account, snapshotCall)
      positionBalancesCall[account] = {
        positionBalance: positionBalanceCall,
        isPositive: isPositiveCall,
        fundingFees: fundingFeesCall,
        marginDebt: marginDebtCall,
      }

      const position = state.positions[account]

      const { liquidable } = await isLiquidable(positionBalance, isPositive, position)

      const expectLiquidationValue = Array.isArray(shouldLiquidate) ? shouldLiquidate[accountIndex] : expectLiquidation
      expect(liquidable === expectLiquidationValue).to.be.true

      accountIndex++
    }

    accountIndex = 0
    for (let account of accounts) {
      if (Array.isArray(shouldLiquidate) && !shouldLiquidate[accountIndex]) {
        continue
      }
      accountIndex++

      await expectEvent(tx, 'LiquidatePosition', {
        positionAddress: account,
        currentPositionBalance: positionBalances[account].positionBalance,
        isBalancePositive: positionBalances[account].isPositive,
        positionUnitsAmount: state.positions[account].positionUnitsAmount,
      })

      const expectedPosition = {
        positionUnitsAmount: toBN(0),
        leverage: toBN(0),
        openCVIValue: toBN(0),
        creationTimestamp: toBN(0),
        originalCreationTimestamp: toBN(0),
      }
      const actualPosition = await getContracts().platform.positions(account)
      validatePosition(actualPosition, expectedPosition)

      await expectRevert.unspecified(getContracts().platform.calculatePositionBalance(account, { from: admin }))

      const currExpectedFinderFeeAmount = getLiquidationReward(
        positionBalances[account].positionBalance,
        positionBalances[account].isPositive,
        state.positions[account],
      )
      const currExpectedFinderFeeAmountCall = getLiquidationReward(
        positionBalancesCall[account].positionBalance,
        positionBalancesCall[account].isPositive,
        state.positions[account],
      )

      subtractTotalPositionUnits(
        state,
        state.positions[account].positionUnitsAmount,
        positionBalances[account].fundingFees,
      )

      state.positions[account] = expectedPosition

      const currPosition = state.positions[account]
      currPosition.positionUnitsAmount = new BN(0)

      state.sharedPool = state.sharedPool.sub(currExpectedFinderFeeAmount).sub(positionBalances[account].marginDebt)
      state.totalMarginDebt = state.totalMarginDebt.sub(positionBalances[account].marginDebt)

      const afterBalance = await getAccountBalance(account)
      expect(afterBalance).to.be.bignumber.equal(beforeBalances[account])

      expectedFinderFeeAmount = expectedFinderFeeAmount.add(currExpectedFinderFeeAmount)
      expectedFinderFeeAmountCall = expectedFinderFeeAmountCall.add(currExpectedFinderFeeAmountCall)
    }

    expect(result).to.be.bignumber.equal(expectedFinderFeeAmountCall)

    const liquidatorAfterBalance = await getAccountBalance(liquidator)

    if (getContracts().isETH) {
      expect(liquidatorAfterBalance.sub(liquidatorBeforeBalance)).to.be.bignumber.equal(
        expectedFinderFeeAmount.sub(new BN(tx.receipt.gasUsed).mul(GAS_PRICE)),
      )
    } else {
      expect(liquidatorAfterBalance.sub(liquidatorBeforeBalance)).to.be.bignumber.equal(expectedFinderFeeAmount)
    }
  } else {
    await expectRevert(
      getContracts().platform.liquidatePositions(accounts, { from: liquidator }),
      'No liquidable position',
    )
  }

  await validateLPState(state)
  return expectedFinderFeeAmount
}

exports.deposit = deposit
exports.withdraw = withdraw
exports.withdrawLPTokens = withdrawLPTokens
exports.openPosition = openPosition
exports.closePosition = closePosition

exports.calculateDepositAmounts = calculateDepositAmounts
exports.calculateWithdrawAmounts = calculateWithdrawAmounts
exports.calculateMintAmount = calculateMintAmount
exports.calculateBurnAmount = calculateBurnAmount
exports.calculateTokensByBurntLPTokensAmount = calculateTokensByBurntLPTokensAmount
exports.calculatePositionBalance = calculatePositionBalance
exports.calculateFundingFees = calculateFundingFees
exports.calculateFundingFeesWithSnapshot = calculateFundingFeesWithSnapshot
exports.calculateFundingFeesWithTwoSnapshots = calculateFundingFeesWithTwoSnapshots
exports.calculatePendingFee = calculatePendingFee
exports.calculateMarginDebt = calculateMarginDebt
exports.calculateBalance = calculateBalance
exports.calculateOpenPositionAmounts = calculateOpenPositionAmounts
exports.calculateLiquidationCVI = calculateLiquidationCVI
exports.calculateLiquidationDays = calculateLiquidationDays

exports.updateSnapshots = updateSnapshots

exports.validatePosition = validatePosition
exports.validateLPState = validateLPState
exports.validateEmptyPosition = validateEmptyPosition

exports.createState = createState
exports.depositAndValidate = depositAndValidate
exports.withdrawAndValidate = withdrawAndValidate
exports.openPositionAndValidate = openPositionAndValidate
exports.closePositionAndValidate = closePositionAndValidate
exports.liquidateAndValidate = liquidateAndValidate

exports.getAccountBalance = getAccountBalance
exports.getFeesBalance = getFeesBalance

exports.MAX_FEE = MAX_FEE
exports.GAS_PRICE = GAS_PRICE
exports.MAX_FEE_DELTA_COLLATERAL = MAX_FEE_DELTA_COLLATERAL
exports.LEVERAGE_TO_THRESHOLD = LEVERAGE_TO_THRESHOLD
exports.LEVERAGE_TO_MAX = LEVERAGE_TO_MAX
exports.LIQUIDATION_MIN_REWARD_PERCENTAGE = LIQUIDATION_MIN_REWARD_PERCENTAGE
exports.LIQUIDATION_MAX_FEE_PERCENTAGE = LIQUIDATION_MAX_FEE_PERCENTAGE

exports.NO_FEES = NO_FEES
exports.ALL_FEES = ALL_FEES
