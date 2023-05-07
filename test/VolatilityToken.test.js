/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, expectEvent, time, BN, balance } = require('@openzeppelin/test-helpers')

const chai = require('chai')

const { ORACLE_MARGINS_TO_TEST } = require('./utils/TestUtils')
const { toBN, toUSD, toCVI } = require('./utils/BNUtils')
const { print } = require('./utils/DebugUtils')
const {
  deployFullPlatform,
  deployVolToken,
  deployPlatformHelper,
  getContracts,
  getAccounts,
  setupVolTokenContracts,
  setupLiquidityProviders,
  ZERO_ADDRESS,
  INITIAL_VOL_RATE,
} = require('./utils/DeployUtils')
const {
  createState,
  depositAndValidate,
  calculateDepositAmounts,
  calculateMintAmount,
  calculateBurnAmount,
  calculatePositionBalance,
  calculateFundingFees,
  calculateFundingFeesWithSnapshot,
  calculatePendingFee,
  calculateLiquidationDays,
  validateEmptyPosition,
  validatePosition,
  validateLPState,
  updateSnapshots,
  calculateOpenPositionAmounts,
  MAX_FEE,
  GAS_PRICE,
  ALL_FEES,
  NO_FEES,
} = require('./utils/PlatformUtils.js')

const RequestFeesCalculator = artifacts.require('RequestFeesCalculator')
const KeepersFeeVault = artifacts.require('KeepersFeeVault')
const RequestFulfiller = artifacts.require('RequestFulfiller')
const VolatilityToken = artifacts.require('VolatilityToken')
const VolatilityTokenTest = artifacts.require('VolatilityTokenTest')

const expect = chai.expect

const TOKEN_PRICE_DECIMALS = toBN(1, 6)

const SECONDS_PER_HOUR = 60 * 60
const SECONDS_PER_DAY = new BN(60 * 60 * 24)

const MIN_TIME_DELAY = SECONDS_PER_HOUR
const MAX_TIME_DELAY = 3 * SECONDS_PER_HOUR

const MAX_TIME_DELAY_FEE = new BN(100)
const MIN_TIME_DELAY_FEE = new BN(0)

const MIN_WAIT_TIME = new BN(15 * 60)

const KEEPERS_FEE_PERCENTAGE = new BN(100)
const MAX_FEE_PERCENTAGE = new BN(10000)
const MAX_KEEPERS_FEE = toBN(4, 6)

const MIN_PENALTY_FEE = new BN(300)
const MAX_PENALTY_FEE = new BN(500)
const MID_PENALTY_FEE = new BN(300)

const FINDERS_FEE = new BN(5000)

const MID_PENALTY_TIME = new BN(1 * SECONDS_PER_HOUR)
const MAX_PENALTY_TIME = new BN(12 * SECONDS_PER_HOUR)

const MAX_TOTAL_REQUESTS_AMOUNT = toBN(1, 11)

const MAX_REQUESTS_INCREASE = 30

const MINT_REQUEST_TYPE = 1
const BURN_REQUEST_TYPE = 2

const DELAYS_TO_TEST = [SECONDS_PER_HOUR, 2 * SECONDS_PER_HOUR, 3 * SECONDS_PER_HOUR]

let admin, bob, alice, carol, dave, keeper
let accountsUsed

const setAccounts = async () => {
  ;[admin, bob, alice, carol, dave, keeper] = await getAccounts()
  accountsUsed = [admin, bob, alice, carol, dave, keeper]
}

const deployPlatform = async margin => {
  await setAccounts()
  await deployFullPlatform(false, margin)

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
  setupLiquidityProviders(accountsUsed)
}

const beforeEachToken = async (margin, isTest = false) => {
  await deployPlatform(margin)
  setupVolTokenContracts()

  await deployVolToken(this.state, margin, isTest)
  this.requestFulfiller = getContracts().requestFulfiller
  this.volToken = getContracts().volToken
  this.keepersFeeVault = getContracts().keepersFeeVault
}

const beforeEachTokenAllMargins = async () => {
  await deployPlatform()
  setupVolTokenContracts()

  for (let margin of ORACLE_MARGINS_TO_TEST) {
    await deployVolToken(this.state, margin)
  }

  this.volToken = getContracts().volToken
  this.keepersFeeVault = getContracts().keepersFeeVault
}

const calculateTimeDelayFeePercentage = (
  timeDelay,
  minDelayTime = MIN_TIME_DELAY,
  maxDelayTime = MAX_TIME_DELAY,
  minDelayFee = MIN_TIME_DELAY_FEE,
  maxDelayFee = MAX_TIME_DELAY_FEE,
) => {
  return maxDelayFee.sub(
    new BN(timeDelay)
      .sub(new BN(minDelayTime))
      .mul(maxDelayFee.sub(minDelayFee))
      .div(new BN(maxDelayTime).sub(new BN(minDelayTime))),
  )
}

const calculateTimePenaltyFeePercentage = (now, requestTime, targetTime) => {
  if (now.lt(targetTime)) {
    return targetTime.sub(now).mul(MIN_PENALTY_FEE).div(targetTime.sub(requestTime).sub(MIN_WAIT_TIME))
  } else if (now.lt(targetTime.add(MID_PENALTY_TIME))) {
    return now.sub(targetTime).mul(MID_PENALTY_FEE).div(MID_PENALTY_TIME)
  } else if (now.lt(targetTime.add(MAX_PENALTY_TIME))) {
    return MID_PENALTY_FEE.add(
      now
        .sub(targetTime)
        .sub(MID_PENALTY_TIME)
        .mul(MAX_PENALTY_FEE.sub(MID_PENALTY_FEE))
        .div(MAX_PENALTY_TIME.sub(MID_PENALTY_TIME)),
    )
  }

  return MAX_PENALTY_FEE
}

const calculateKeepersFee = amount => {
  const keepersFee = amount.mul(KEEPERS_FEE_PERCENTAGE).div(MAX_FEE_PERCENTAGE)

  if (keepersFee.gt(MAX_KEEPERS_FEE)) {
    return MAX_KEEPERS_FEE
  }

  return keepersFee
}

const validateState = async margin => {
  expect(await this.volToken[margin.toString()].totalSupply()).to.be.bignumber.equal(
    this.state[margin.toString()].volTokenSupply,
  )
  expect((await this.platform.positions(this.volToken[margin.toString()].address))[0]).to.be.bignumber.equal(
    this.state[margin.toString()].volTokenPositionUnits,
  )
  expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(
    this.state[margin.toString()].totalRequestsAmount,
  )
  expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(
    this.state[margin.toString()].minRequestId,
  )
  expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(
    this.state[margin.toString()].nextRequestId,
  )
  expect(await this.token.balanceOf(this.keepersFeeVault[margin.toString()].address)).to.be.bignumber.equal(
    this.state[margin.toString()].keepersFeeVaultBalance,
  )

  if (this.state[margin.toString()].volTokenSupply.eq(toBN(0))) {
    await expectRevert(
      getContracts().platformHelper.volTokenIntrinsicPrice(this.volToken[margin.toString()].address),
      'No supply',
    )
  } else {
    const intrinsicPrice = await getContracts().platformHelper.volTokenIntrinsicPrice(
      this.volToken[margin.toString()].address,
    )
    const timestamp = await time.latest()
    const stateTokenPrice = await getStateTokenPrice(margin)
    //expect(intrinsicPrice).to.be.bignumber.equal(stateTokenPrice)
  }

  for (let currId = 0; currId < this.state[margin.toString()].nextRequestId; currId++) {
    const stateRequest = this.state[margin.toString()].requests[currId]

    if (stateRequest === undefined) {
      const request = await this.volToken[margin.toString()].requests(currId)
      validateEmptyRequest(request)
    } else {
      const request = await this.volToken[margin.toString()].requests(currId)
      validateRequest(request, stateRequest)
    }
  }
}

const liquidateAndValidate = async (
  requestId,
  request,
  liquidator,
  margin,
  shouldValidateState = true,
  useKeepers = false,
) => {
  const beforeBalance = await this.token.balanceOf(liquidator)
  const beforeOwnerBalance = await this.token.balanceOf(request.owner)

  const beforeContractVolTokenBalance = await this.volToken[margin.toString()].balanceOf(
    this.volToken[margin.toString()].address,
  )
  const beforeContractBalance = getContracts().isETH
    ? await balance.current(this.volToken[margin.toString()].address, 'wei')
    : await getContracts().token.balanceOf(this.volToken[margin.toString()].address)
  const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit()

  if (shouldValidateState) {
    await validateState(margin)
  }

  const result = await this.volToken[margin.toString()].liquidateRequest.call(requestId, { from: liquidator })
  const { latestTimestamp: timestampCall, snapshot: snapshotCall } = await updateSnapshots(this.state, false)
  const tx = await this.volToken[margin.toString()].liquidateRequest(requestId, { from: liquidator })

  const { latestTimestamp: timestamp } = await updateSnapshots(this.state)

  const maxPenaltyFees = request.tokenAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE)
  const timeDelayFees = request.tokenAmount.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE)
  let leftAmount = useKeepers ? request.tokenAmount : maxPenaltyFees.add(timeDelayFees)

  const isBurn = request.requestType.eq(new BN(BURN_REQUEST_TYPE))

  let extraFeesFromBurn = new BN(0)
  let leftAmountCall = leftAmount
  if (isBurn) {
    const { tokensReceived, closeFees, positionUnitsClosed } = await calculateBurnAmount(
      this.state,
      leftAmount,
      timestamp,
      1,
    )
    const { tokensReceived: tokensReceivedCall } = await calculateBurnAmount(
      this.state,
      leftAmount,
      timestampCall,
      1,
      snapshotCall,
    )

    extraFeesFromBurn = extraFeesFromBurn.add(closeFees)
    leftAmountCall = tokensReceivedCall

    this.state[margin.toString()].volTokenSupply = this.state[margin.toString()].volTokenSupply.sub(leftAmount)
    leftAmount = tokensReceived
    this.state[margin.toString()].volTokenPositionUnits =
      this.state[margin.toString()].volTokenPositionUnits.sub(positionUnitsClosed)
  } else {
    this.state[margin.toString()].totalRequestsAmount = this.state[margin.toString()].totalRequestsAmount.sub(
      request.tokenAmount,
    )
  }

  const findersFeePercentage = useKeepers ? KEEPERS_FEE_PERCENTAGE : FINDERS_FEE
  const finderFeesAmount = leftAmount.mul(findersFeePercentage).div(MAX_FEE_PERCENTAGE)
  const finderFeesCallAmount = leftAmountCall.mul(findersFeePercentage).div(MAX_FEE_PERCENTAGE)

  expect(result).to.be.bignumber.equal(finderFeesCallAmount)

  const afterBalance = await this.token.balanceOf(liquidator)
  const afterOwnerBalance = await this.token.balanceOf(request.owner)
  expect(afterBalance.sub(beforeBalance)).to.be.bignumber.equal(finderFeesAmount)
  expect(afterOwnerBalance.sub(beforeOwnerBalance)).to.be.bignumber.equal(
    useKeepers ? leftAmount.sub(finderFeesAmount) : toBN(0),
  )

  const afterContractBalance = getContracts().isETH
    ? await balance.current(this.volToken[margin.toString()].address, 'wei')
    : await getContracts().token.balanceOf(this.volToken[margin.toString()].address)
  const afterContractVolTokenBalance = await this.volToken[margin.toString()].balanceOf(
    this.volToken[margin.toString()].address,
  )
  expect(beforeContractBalance.sub(afterContractBalance)).to.be.bignumber.equal(isBurn ? new BN(0) : leftAmount)
  expect(beforeContractVolTokenBalance.sub(afterContractVolTokenBalance)).to.be.bignumber.equal(
    isBurn ? (useKeepers ? request.tokenAmount : maxPenaltyFees.add(timeDelayFees)) : new BN(0),
  )

  const afterFeesCollectorBalance = await this.fakeFeesCollector.getProfit()

  expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(
    useKeepers ? extraFeesFromBurn : leftAmount.sub(finderFeesAmount).add(extraFeesFromBurn),
  )

  await expectEvent(tx, 'LiquidateRequest', {
    requestId: new BN(requestId),
    requestType: request.requestType,
    account: request.owner,
    liquidator,
    findersFeeAmount: finderFeesAmount,
    useKeepers,
  })

  removeRequest(requestId, margin)

  await validateState(margin)
}

const removeRequest = (requestId, margin) => {
  this.state[margin.toString()].requests[requestId] = undefined
  let currRequestId = this.state[margin.toString()].minRequestId
  const nextRequestId = this.state[margin.toString()].nextRequestId

  for (let i = 0; i < MAX_REQUESTS_INCREASE; i++) {
    if (
      currRequestId.eq(nextRequestId) ||
      (this.state[margin.toString()].requests[currRequestId] !== undefined &&
        this.state[margin.toString()].requests[currRequestId].useKeepers)
    ) {
      break
    }
    currRequestId = this.state[margin.toString()].minRequestId.add(toBN(i + 1))
  }
  this.state[margin.toString()].minRequestId = currRequestId
}

const fulfillMintAndValidate = async (
  requestId,
  request,
  timeDelayFees,
  account,
  margin,
  isCollateralized = false, //TODO: Remove
  shouldAbort = false,
  keepersCalled = false,
  maxOpenPremiumFeePercentage = MAX_FEE_PERCENTAGE,
  shouldFulfill = true,
  multipleKeeperAccount = keeper,
) => {
  return fulfillAndValidate(
    requestId,
    request,
    timeDelayFees,
    account,
    margin,
    isCollateralized,
    shouldAbort,
    keepersCalled,
    maxOpenPremiumFeePercentage,
    shouldFulfill,
    multipleKeeperAccount,
  )
}

const fulfillBurnAndValidate = async (
  requestId,
  request,
  timeDelayFee,
  account,
  margin,
  keepersCalled = false,
  multipleKeeperAccount = keeper,
) => {
  return fulfillAndValidate(
    requestId,
    request,
    timeDelayFee,
    account,
    margin,
    undefined,
    undefined,
    keepersCalled,
    undefined,
    undefined,
    multipleKeeperAccount,
  )
}

const fulfillAndValidate = async (
  originalRequestId,
  request,
  originalTimeDelayFee,
  originalAccount,
  margin,
  isCollateralized = false, //TODO: Remove
  shouldAbort = false,
  keepersCalled = false,
  maxOpenPremiumFeePercentage = MAX_FEE_PERCENTAGE,
  originalShouldFulfill = true,
  multipleKeeperAccount = keeper,
) => {
  const oracleMargin = getContracts().oracleLeverage
  const isMultiple = Array.isArray(originalRequestId)

  let requestIds, accounts, shouldFulfills, timeDelayFees
  let expectedPosition = this.state.positions[this.volToken[oracleMargin.toString()].address]

  if (isMultiple) {
    requestIds = originalRequestId
    accounts = originalAccount
    shouldFulfills = originalShouldFulfill
    timeDelayFees = originalTimeDelayFee
  } else {
    requestIds = [originalRequestId]
    accounts = [originalAccount]
    shouldFulfills = [originalShouldFulfill]
    timeDelayFees = [originalTimeDelayFee]
  }

  // Gather information
  const cviValue = (await getContracts().fakeOracle.getCVILatestRoundData()).cviValue
  let afterContractTokens = getContracts().isETH
    ? await balance.current(this.volToken[oracleMargin.toString()].address, 'wei')
    : await getContracts().token.balanceOf(this.volToken[oracleMargin.toString()].address)
  let afterContractVolTokens = await this.volToken[oracleMargin.toString()].balanceOf(
    this.volToken[oracleMargin.toString()].address,
  )

  const afterBalances = {}
  const afterLPTokensBalances = {}
  const afterVolTokensBalances = {}

  let i
  for (i = 0; i < requestIds.length; i++) {
    const account = accounts[i]
    const requestId = requestIds[i]

    afterBalances[account] = await this.token.balanceOf(account)
    afterLPTokensBalances[account] = await this.platform.balanceOf(account)
    afterVolTokensBalances[account] = await this.volToken[oracleMargin.toString()].balanceOf(account)
  }

  let tx, lpTokensCall, mintedTokensCall, timestampCall, snapshotCall, totalFundingFeesCall, tokensReceivedCall

  // Make call or calls
  if (isMultiple) {
    tx = await this.requestFulfiller[oracleMargin.toString()].performUpkeep(0, { from: multipleKeeperAccount })
    print('FULFILL: ' + tx.receipt.gasUsed.toString())
  } else {
    const isMint = this.state[oracleMargin.toString()].requests[requestIds[0]].requestType == MINT_REQUEST_TYPE

    if (isMint) {
      let result = await this.volToken[oracleMargin.toString()].fulfillMintRequest.call(
        requestIds[0],
        maxOpenPremiumFeePercentage,
        keepersCalled,
        { from: keepersCalled ? keeper : accounts[0] },
      )
      mintedTokensCall = result.tokensMinted
      expect(result.success).to.equal(shouldFulfills[0])

      result = await updateSnapshots(this.state, false)
      timestampCall = result.latestTimestamp
      snapshotCall = result.snapshot
      totalFundingFeesCall = result.totalFundingFees

      tx = await this.volToken[oracleMargin.toString()].fulfillMintRequest(
        requestIds[0],
        maxOpenPremiumFeePercentage,
        keepersCalled,
        { from: keepersCalled ? keeper : accounts[0] },
      )

      print('MINT: ' + tx.receipt.gasUsed.toString())
    } else {
      tokensReceivedCall = await this.volToken[oracleMargin.toString()].fulfillBurnRequest.call(
        requestIds[0],
        keepersCalled,
        { from: keepersCalled ? keeper : accounts[0] },
      )

      const result = await updateSnapshots(this.state, false)
      timestampCall = result.latestTimestamp
      snapshotCall = result.snapshot

      tx = await this.volToken[oracleMargin.toString()].fulfillBurnRequest(requestIds[0], keepersCalled, {
        from: keepersCalled ? keeper : accounts[0],
      })

      print('BURN: ' + tx.receipt.gasUsed.toString())
    }
  }

  // Test results
  const previousTotalFundingFees = this.state.totalFundingFees
  const {
    latestTimestamp: timestamp,
    snapshot,
    latestCVIRound,
    totalFundingFees,
    turbulence,
  } = await updateSnapshots(this.state)

  for (i = 0; i < requestIds.length; i++) {
    const account = accounts[i]
    const requestId = requestIds[i]
    const timeDelayFee = timeDelayFees[i]
    const request = this.state[oracleMargin.toString()].requests[requestId]

    const isMint = request.requestType.toNumber() === MINT_REQUEST_TYPE

    const shouldFulfill = shouldFulfills[i]
    const tokensAmount = request.tokenAmount

    let keepersFee

    // For burn requests only
    if (!isMint) {
      let tokensReceivedCallExpected

      if (!isMultiple) {
        const result = await calculateBurnAmount(this.state, tokensAmount, timestampCall, 1, snapshotCall)
        tokensReceivedCallExpected = result.tokensReceived
      }

      const {
        tokensReceived: tokensReceivedBeforeFees,
        positionUnitsClosed,
        closeFees,
        fundingFees,
        positionBalance,
        marginDebt,
      } = await calculateBurnAmount(this.state, tokensAmount, timestamp, 1)

      const timeDelayFees = tokensReceivedBeforeFees.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE)
      const penaltyPercentage =
        request.useKeepers && timestamp.gte(request.targetTimestamp)
          ? toBN(0)
          : calculateTimePenaltyFeePercentage(timestamp, request.requestTimestamp, request.targetTimestamp)
      const penaltyFees = tokensReceivedBeforeFees.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE)
      keepersFee = keepersCalled ? calculateKeepersFee(tokensReceivedBeforeFees) : toBN(0)
      const tokensReceived = tokensReceivedBeforeFees.sub(penaltyFees).sub(timeDelayFees).sub(keepersFee)

      if (!isMultiple) {
        const timeDelayFeesCall = tokensReceivedCallExpected
          .mul(request.timeDelayRequestFeesPercent)
          .div(MAX_FEE_PERCENTAGE)
        const penaltyPercentageCall =
          request.useKeepers && timestampCall.gte(request.targetTimestamp)
            ? toBN(0)
            : calculateTimePenaltyFeePercentage(timestampCall, request.requestTimestamp, request.targetTimestamp)
        const penaltyFeesCall = tokensReceivedCallExpected.mul(penaltyPercentageCall).div(MAX_FEE_PERCENTAGE)
        const keepersFeeCall = keepersCalled
          ? tokensReceivedCallExpected.mul(KEEPERS_FEE_PERCENTAGE).div(MAX_FEE_PERCENTAGE)
          : toBN(0)
        expect(tokensReceivedCall).to.be.bignumber.equal(
          tokensReceivedCallExpected.sub(penaltyFeesCall).sub(timeDelayFeesCall).sub(keepersFeeCall),
        )
      }

      const totalFees = closeFees.add(fundingFees)

      await expectEvent.inTransaction(tx.tx, getContracts().platform, 'ClosePosition', {
        account: this.volToken[oracleMargin.toString()].address,
        tokenAmount: positionBalance.sub(marginDebt),
        feeAmount: totalFees,
        positionUnitsAmount:
          this.state.positions[this.volToken[oracleMargin.toString()].address].positionUnitsAmount.sub(
            positionUnitsClosed,
          ),
        leverage: new BN(1),
        cviValue,
      })

      const expectedFulfillRequestEvent = {
        requestId: new BN(requestId),
        account,
        fulfillFeesAmount: penaltyFees.add(keepersFee),
        isAborted: false, //TODO: Remove
        useKeepers: request.useKeepers,
        keepersCalled,
        fulfiller: isMultiple
          ? this.requestFulfiller[oracleMargin.toString()].address
          : keepersCalled
          ? keeper
          : account,
      }
      const expectedBurnEvent = {
        account,
        requestId,
        tokenAmountBeforeFees: tokensReceivedBeforeFees,
        tokenAmount: tokensReceived,
        burnedTokens: tokensAmount,
      }
      if (isMultiple) {
        await expectEvent.inTransaction(
          tx.tx,
          this.volToken[oracleMargin.toString()],
          'FulfillRequest',
          expectedFulfillRequestEvent,
        )
        await expectEvent.inTransaction(tx.tx, this.volToken[oracleMargin.toString()], 'Burn', expectedBurnEvent)
      } else {
        await expectEvent(tx, 'FulfillRequest', expectedFulfillRequestEvent)
        await expectEvent(tx, 'Burn', expectedBurnEvent)
      }

      expectedPosition.positionUnitsAmount = expectedPosition.positionUnitsAmount.sub(positionUnitsClosed)

      this.state.totalPositionUnits = this.state.totalPositionUnits.sub(positionUnitsClosed)
      if (this.state.totalFundingFees.sub(fundingFees).lt(new BN(0))) {
        this.state.totalFundingFees = new BN(0)
      } else {
        this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees)
      }

      if (this.state.totalPositionUnits.eq(new BN(0))) {
        this.state.totalFundingFees = new BN(0)
      }

      this.state.totalFeesSent = this.state.totalFeesSent.add(closeFees).add(penaltyFees).add(timeDelayFees)
      this.state.sharedPool = this.state.sharedPool.sub(positionBalance).add(fundingFees)
      this.state.totalMarginDebt = this.state.totalMarginDebt.sub(marginDebt)

      this.state[oracleMargin.toString()].volTokenSupply =
        this.state[oracleMargin.toString()].volTokenSupply.sub(tokensAmount)
      this.state[oracleMargin.toString()].volTokenPositionUnits =
        this.state[oracleMargin.toString()].volTokenPositionUnits.sub(positionUnitsClosed)

      afterBalances[account] = afterBalances[account].add(tokensReceived)

      const volTokenMaxPenaltyFees = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE)
      const volTokenTimeDelayFees = tokensAmount.mul(request.timeDelayRequestFeesPercent).div(MAX_FEE_PERCENTAGE)
      afterVolTokensBalances[account] = afterVolTokensBalances[account].sub(
        keepersCalled ? toBN(0) : tokensAmount.sub(volTokenMaxPenaltyFees).sub(volTokenTimeDelayFees),
      )

      afterContractVolTokens = afterContractVolTokens.sub(
        request.useKeepers ? tokensAmount : volTokenMaxPenaltyFees.add(volTokenTimeDelayFees),
      )

      // For mint requests only
    } else {
      const penaltyPercentage =
        request.useKeepers && timestamp.gte(request.targetTimestamp)
          ? toBN(0)
          : calculateTimePenaltyFeePercentage(timestamp, request.requestTimestamp, request.targetTimestamp)
      const penaltyFees = tokensAmount.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE)
      const maxPenaltyFees = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE)

      const penaltyPercentageCall = !isMultiple
        ? request.useKeepers && timestampCall.gte(request.targetTimestamp)
          ? toBN(0)
          : calculateTimePenaltyFeePercentage(timestampCall, request.requestTimestamp, request.targetTimestamp)
        : toBN(0)
      const penaltyFeesCall = !isMultiple ? tokensAmount.mul(penaltyPercentageCall).div(MAX_FEE_PERCENTAGE) : toBN(0)

      keepersFee = keepersCalled ? calculateKeepersFee(tokensAmount) : toBN(0)

      const fulfillAmount = tokensAmount.sub(timeDelayFee).sub(penaltyFees).sub(keepersFee)

      const mintAmount = fulfillAmount
      const depositAmount = fulfillAmount.sub(mintAmount)

      const fulfillAmountCall = !isMultiple
        ? tokensAmount.sub(timeDelayFee).sub(penaltyFeesCall).sub(keepersFee)
        : toBN(0)

      const mintAmountCallExpected = fulfillAmountCall
      const depositAmountCallExpected = !isMultiple ? fulfillAmountCall.sub(mintAmountCallExpected) : toBN(0)

      let lpTokens
      const amounts = await calculateDepositAmounts(this.state, depositAmount)
      lpTokens = amounts.lpTokens

      let isAborted = false

      if (shouldFulfill) {
        this.state.turbulence = turbulence
        this.state.latestRound = latestCVIRound
        this.state.latestSnapshotTimestamp = timestamp.toNumber()
        this.state.snapshots[timestamp.toNumber()] = snapshot
      }

      const {
        openPositionTokensFees,
        openPositionPremiumFees,
        openPositionTokensMinusFees,
        openPositionLeveragedTokens,
        positionUnits,
      } = await calculateOpenPositionAmounts(this.state, timestamp, mintAmount, ALL_FEES, 1)
      const { positionedTokenAmount, volTokens } = await calculateMintAmount(
        this.state,
        mintAmount,
        openPositionPremiumFees,
        new BN(1),
        snapshot,
      )

      // No return values when performing upkeep in multiple requests scenario
      if (!isMultiple) {
        const { openPositionPremiumFees: openPositionPremiumFeesCall } = await calculateOpenPositionAmounts(
          this.state,
          timestampCall,
          mintAmountCallExpected,
          ALL_FEES,
          1,
        )
        const { volTokens: volTokensCall } = await calculateMintAmount(
          this.state,
          mintAmountCallExpected,
          openPositionPremiumFeesCall,
          new BN(1),
          snapshotCall,
        )
        expect(mintedTokensCall).to.be.bignumber.equal(!isAborted && shouldFulfill ? volTokensCall : toBN(0))
      }

      const expectedMintEvent = {
        requestId,
        account,
        tokenAmount: mintAmount,
        positionedTokenAmount,
        mintedTokens: volTokens,
      }

      if (shouldFulfill) {
        if (isMultiple) {
          await expectEvent.inTransaction(tx.tx, this.volToken[oracleMargin.toString()], 'Mint', expectedMintEvent)
        } else {
          await expectEvent(tx, 'Mint', expectedMintEvent)
        }
      } else {
        if (isMultiple) {
          let didFindEvent = true
          try {
            await expectEvent.inTransaction(tx.tx, this.volToken[oracleMargin.toString()], 'Mint', expectedMintEvent)
          } catch (e) {
            didFindEvent = false
          }
          expect(didFindEvent).to.be.false
        } else {
          await expectEvent.notEmitted(tx, 'Mint', expectedMintEvent)
        }
      }

      const expectedFulfillEvent = {
        requestId: new BN(requestId),
        account,
        fulfillFeesAmount: penaltyFees.add(keepersFee),
        isAborted,
        useKeepers: request.useKeepers,
        keepersCalled,
        fulfiller: isMultiple
          ? this.requestFulfiller[oracleMargin.toString()].address
          : keepersCalled
          ? keeper
          : account,
      }

      if (shouldFulfill) {
        if (isMultiple) {
          await expectEvent.inTransaction(
            tx.tx,
            this.volToken[oracleMargin.toString()],
            'FulfillRequest',
            expectedFulfillEvent,
          )
        } else {
          await expectEvent(tx, 'FulfillRequest', expectedFulfillEvent)
        }
      } else {
        if (isMultiple) {
          let didFindEvent = true
          try {
            await expectEvent.inTransaction(
              tx.tx,
              this.volToken[oracleMargin.toString()],
              'FulfillRequest',
              expectedFulfillEvent,
            )
          } catch (e) {
            didFindEvent = false
          }
          expect(didFindEvent).to.be.false
        } else {
          await expectEvent.notEmitted(tx, 'FulfillRequest', expectedFulfillEvent)
        }
      }

      let finalPositionUnits = positionUnits
      let positionUnitsAdded = finalPositionUnits

      const isMerge = expectedPosition !== undefined

      if (!isAborted && shouldFulfill) {
        if (isMerge) {
          const oldPositionUnits =
            this.state.positions[this.volToken[oracleMargin.toString()].address].positionUnitsAmount
          const fundingFees = calculateFundingFees(
            this.state,
            timestamp,
            this.volToken[oracleMargin.toString()].address,
            this.state.positions[this.volToken[oracleMargin.toString()].address].positionUnitsAmount,
          )

          const marginDebt = this.state.positions[this.volToken[oracleMargin.toString()].address].positionUnitsAmount
            .mul(this.state.positions[this.volToken[oracleMargin.toString()].address].openCVIValue)
            .mul(this.state.positions[this.volToken[oracleMargin.toString()].address].leverage.sub(new BN(1)))
            .div(getContracts().maxCVIValue)
            .div(this.state.positions[this.volToken[oracleMargin.toString()].address].leverage)
          const positionBalance = this.state.positions[
            this.volToken[oracleMargin.toString()].address
          ].positionUnitsAmount
            .mul(cviValue)
            .div(getContracts().maxCVIValue)
            .sub(fundingFees)
            .sub(marginDebt)
          finalPositionUnits = positionBalance
            .add(openPositionTokensMinusFees)
            .mul(new BN(1)) // margin
            .mul(getContracts().maxCVIValue)
            .div(cviValue)

          positionUnitsAdded = new BN(0)
          if (oldPositionUnits.lt(finalPositionUnits)) {
            positionUnitsAdded = finalPositionUnits.sub(oldPositionUnits)
          }

          this.state.totalFundingFees = this.state.totalFundingFees.sub(fundingFees)
          this.state.totalPositionUnits = this.state.totalPositionUnits.sub(
            this.state.positions[this.volToken[oracleMargin.toString()].address].positionUnitsAmount,
          )
          this.state.sharedPool = this.state.sharedPool
            .sub(positionBalance)
            .sub(marginDebt)
            .add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(1)))
            .add(openPositionPremiumFees)
          this.state.totalMarginDebt = this.state.totalMarginDebt
            .sub(marginDebt)
            .add(positionBalance.add(openPositionTokensMinusFees).mul(new BN(1).sub(new BN(1))))

          if (this.state.totalPositionUnits.eq(toBN(0))) {
            this.state.totalFundingFees = toBN(0)
          }
        } else {
          this.state.sharedPool = this.state.sharedPool.add(openPositionLeveragedTokens).add(openPositionPremiumFees)
          this.state.totalMarginDebt = this.state.totalMarginDebt.add(
            openPositionLeveragedTokens.sub(openPositionTokensMinusFees),
          )
        }

        await expectEvent.inTransaction(tx.tx, getContracts().platform, 'OpenPosition', {
          account: this.volToken[oracleMargin.toString()].address,
          tokenAmount: mintAmount,
          feeAmount: openPositionTokensFees.add(openPositionPremiumFees),
          positionUnitsAmount: finalPositionUnits,
          leverage: new BN(1),
          cviValue: cviValue,
        })

        if (!isMerge) {
          expectedPosition = {
            positionUnitsAmount: finalPositionUnits,
            creationTimestamp: timestamp,
            openCVIValue: cviValue,
            leverage: new BN(1),
            originalCreationTimestamp: timestamp,
          }
          this.state.positions[this.volToken[oracleMargin.toString()].address] = expectedPosition
        } else {
          expectedPosition.positionUnitsAmount = finalPositionUnits
          expectedPosition.creationTimestamp = timestamp
          expectedPosition.openCVIValue = cviValue
        }

        this.state.totalPositionUnits = this.state.totalPositionUnits.add(finalPositionUnits)
        this.state.totalFeesSent = this.state.totalFeesSent
          .add(timeDelayFee)
          .add(penaltyFees)
          .add(openPositionTokensFees)
      }

      if (isAborted) {
        afterBalances[account] = afterBalances[account].add(maxPenaltyFees.add(timeDelayFee))
      } else {
        afterBalances[account] = afterBalances[account].sub(
          request.useKeepers ? toBN(0) : tokensAmount.sub(timeDelayFee).sub(maxPenaltyFees),
        )
      }

      afterContractTokens = afterContractTokens.sub(
        !shouldFulfill
          ? toBN(0)
          : request.useKeepers
          ? tokensAmount
          : isAborted
          ? maxPenaltyFees.add(timeDelayFee)
          : timeDelayFee.add(maxPenaltyFees),
      )
      afterVolTokensBalances[account] = afterVolTokensBalances[account].add(
        isAborted || !shouldFulfill ? new BN(0) : volTokens,
      )

      if (!isAborted && shouldFulfill) {
        this.state[oracleMargin.toString()].volTokenSupply =
          this.state[oracleMargin.toString()].volTokenSupply.add(volTokens)
        this.state[oracleMargin.toString()].volTokenPositionUnits = finalPositionUnits
      }
    }

    if (shouldFulfill || !isMint) {
      if (isMint) {
        this.state[oracleMargin.toString()].totalRequestsAmount =
          this.state[oracleMargin.toString()].totalRequestsAmount.sub(tokensAmount)
      }

      this.state[oracleMargin.toString()].keepersFeeVaultBalance =
        this.state[oracleMargin.toString()].keepersFeeVaultBalance.add(keepersFee)
      removeRequest(requestId, oracleMargin)
    }
  }

  const afterActualContractTokens = await getContracts().token.balanceOf(this.volToken[oracleMargin.toString()].address)
  expect(afterActualContractTokens).to.be.bignumber.equal(afterContractTokens)

  i = 0
  for (i = 0; i < requestIds.length; i++) {
    const account = accounts[i]
    const requestId = requestIds[i]

    const currAccountBalance = await this.token.balanceOf(account)
    const currAcountLPTokensBalance = await this.platform.balanceOf(account)
    const currAcountVolTokensBalance = await this.volToken[oracleMargin.toString()].balanceOf(account)

    expect(currAccountBalance).to.be.bignumber.equal(afterBalances[account])
    expect(currAcountLPTokensBalance).to.be.bignumber.equal(afterLPTokensBalances[account])
    expect(currAcountVolTokensBalance).to.be.bignumber.equal(afterVolTokensBalances[account])

    i++
  }

  const actualPosition = await getContracts().platform.positions(this.volToken[oracleMargin.toString()].address)

  if (expectedPosition === undefined || expectedPosition.positionUnitsAmount.toNumber() === 0) {
    validateEmptyPosition(actualPosition)
    delete this.state.positions[this.volToken[oracleMargin.toString()].address]
  } else {
    validatePosition(actualPosition, expectedPosition)
  }

  await validateLPState(this.state)
  await validateState(oracleMargin)
}

const validateRequest = (actual, expected) => {
  expect(actual.requestType).to.be.bignumber.equal(expected.requestType)
  expect(actual.tokenAmount).to.be.bignumber.equal(expected.tokenAmount)
  expect(actual.timeDelayRequestFeesPercent).to.be.bignumber.equal(expected.timeDelayRequestFeesPercent)
  expect(actual.maxRequestFeesPercent).to.be.bignumber.equal(expected.maxRequestFeesPercent)
  expect(actual.owner).to.be.bignumber.equal(expected.owner)
  expect(actual.requestTimestamp).to.be.bignumber.equal(expected.requestTimestamp)
  expect(actual.targetTimestamp).to.be.bignumber.equal(expected.targetTimestamp)
  expect(actual.useKeepers).to.equal(expected.useKeepers)
  expect(actual.maxBuyingPremiumFeePercentage).to.be.bignumber.equal(expected.maxBuyingPremiumFeePercentage)
}

const validateEmptyRequest = (actual, expected) => {
  expect(actual.requestType).to.be.bignumber.equal(toBN(0))
  expect(actual.tokenAmount).to.be.bignumber.equal(toBN(0))
  expect(actual.timeDelayRequestFeesPercent).to.be.bignumber.equal(toBN(0))
  expect(actual.maxRequestFeesPercent).to.be.bignumber.equal(toBN(0))
  expect(actual.owner).to.be.bignumber.equal(ZERO_ADDRESS)
  expect(actual.requestTimestamp).to.be.bignumber.equal(toBN(0))
  expect(actual.targetTimestamp).to.be.bignumber.equal(toBN(0))
  expect(actual.useKeepers).to.equal(false)
  expect(actual.maxBuyingPremiumFeePercentage).to.be.bignumber.equal(toBN(0))
}

const submitAndValidate = async (
  requestType,
  tokensAmount,
  delayTime,
  owner,
  margin,
  useKeepers = false,
  maxBuyingPremiumFeePercentage = toBN(1000),
) => {
  const oracleMargin = getContracts().oracleLeverage
  if (requestType === BURN_REQUEST_TYPE) {
    const allowance = await this.volToken[oracleMargin.toString()].allowance(
      owner,
      this.volToken[oracleMargin.toString()].address,
    )
    await this.volToken[oracleMargin.toString()].approve(
      this.volToken[oracleMargin.toString()].address,
      allowance.add(tokensAmount),
      { from: owner },
    )
  } else {
    await this.token.transfer(owner, tokensAmount, { from: admin })
    const allowance = await this.token.allowance(owner, this.volToken[oracleMargin.toString()].address)
    await this.token.approve(this.volToken[oracleMargin.toString()].address, allowance.add(tokensAmount), {
      from: owner,
    })
  }

  const beforeSubmitTokenBalance = await this.token.balanceOf(owner)
  const beforeSubmitVolTokenBalance = await this.volToken[oracleMargin.toString()].balanceOf(owner)
  const beforeContractTokenBalance = await this.token.balanceOf(this.volToken[oracleMargin.toString()].address)
  const beforeContractVolTokenBalance = await this.volToken[oracleMargin.toString()].balanceOf(
    this.volToken[oracleMargin.toString()].address,
  )
  const beforeFeesCollectorBalance = await this.fakeFeesCollector.getProfit()

  let tx
  if (requestType === MINT_REQUEST_TYPE) {
    if (useKeepers) {
      tx = await this.volToken[oracleMargin.toString()].submitKeepersMintRequest(
        tokensAmount,
        delayTime,
        maxBuyingPremiumFeePercentage,
        { from: owner },
      )
    } else {
      tx = await this.volToken[oracleMargin.toString()].submitMintRequest(tokensAmount, delayTime, { from: owner })
    }
  } else if (requestType === BURN_REQUEST_TYPE) {
    if (useKeepers) {
      tx = await this.volToken[oracleMargin.toString()].submitKeepersBurnRequest(tokensAmount, delayTime, {
        from: owner,
      })
    } else {
      tx = await this.volToken[oracleMargin.toString()].submitBurnRequest(tokensAmount, delayTime, { from: owner })
    }
  } else {
    assert.fail('request type does not exist')
  }

  const now = await time.latest()
  const targetTimestamp = now.add(new BN(delayTime))

  const afterSubmitTokenBalance = await this.token.balanceOf(owner)
  const afterSubmitVolTokenBalance = await this.volToken[oracleMargin.toString()].balanceOf(owner)
  const afterContractTokenBalance = await this.token.balanceOf(this.volToken[oracleMargin.toString()].address)
  const afterContractVolTokenBalance = await this.volToken[oracleMargin.toString()].balanceOf(
    this.volToken[oracleMargin.toString()].address,
  )
  const afterFeesCollectorBalance = await this.fakeFeesCollector.getProfit()
  const timeDelayFeePercentage = calculateTimeDelayFeePercentage(delayTime)
  const timeDelayFee = tokensAmount.mul(timeDelayFeePercentage).div(MAX_FEE_PERCENTAGE)
  const maxFeeAmount = tokensAmount.mul(MAX_PENALTY_FEE).div(MAX_FEE_PERCENTAGE)

  if (requestType === BURN_REQUEST_TYPE) {
    expect(beforeSubmitVolTokenBalance.sub(afterSubmitVolTokenBalance)).to.be.bignumber.equal(
      useKeepers ? tokensAmount : maxFeeAmount.add(timeDelayFee),
    )
    expect(afterContractVolTokenBalance.sub(beforeContractVolTokenBalance)).to.be.bignumber.equal(
      useKeepers ? tokensAmount : maxFeeAmount.add(timeDelayFee),
    )
    expect(beforeSubmitTokenBalance.sub(afterSubmitTokenBalance)).to.be.bignumber.equal(new BN(0))
    expect(afterContractTokenBalance.sub(beforeContractTokenBalance)).to.be.bignumber.equal(new BN(0))
  } else {
    expect(beforeSubmitTokenBalance.sub(afterSubmitTokenBalance)).to.be.bignumber.equal(
      useKeepers ? tokensAmount : maxFeeAmount.add(timeDelayFee),
    )
    expect(afterContractTokenBalance.sub(beforeContractTokenBalance)).to.be.bignumber.equal(
      useKeepers ? tokensAmount : maxFeeAmount.add(timeDelayFee),
    )
    expect(beforeSubmitVolTokenBalance.sub(afterSubmitVolTokenBalance)).to.be.bignumber.equal(new BN(0))
    expect(afterContractVolTokenBalance.sub(beforeContractVolTokenBalance)).to.be.bignumber.equal(new BN(0))

    this.state[oracleMargin.toString()].totalRequestsAmount =
      this.state[oracleMargin.toString()].totalRequestsAmount.add(tokensAmount)
  }

  expect(afterFeesCollectorBalance.sub(beforeFeesCollectorBalance)).to.be.bignumber.equal(new BN(0)) // Note: fees are collected only on fulfill / liquidate

  await expectEvent(tx, 'SubmitRequest', {
    requestId: new BN(this.state[oracleMargin.toString()].nextRequestId),
    requestType: new BN(requestType),
    account: owner,
    tokenAmount: tokensAmount,
    submitFeesAmount: timeDelayFee,
    targetTimestamp,
    useKeepers,
  })

  const requestId = this.state[oracleMargin.toString()].nextRequestId
  const request = await this.volToken[oracleMargin.toString()].requests(requestId)

  const newExpectedRequest = {
    requestType: new BN(requestType),
    tokenAmount: tokensAmount,
    maxRequestFeesPercent: MAX_PENALTY_FEE,
    timeDelayRequestFeesPercent: timeDelayFeePercentage,
    owner,
    requestTimestamp: now,
    targetTimestamp,
    useKeepers,
    maxBuyingPremiumFeePercentage:
      useKeepers && requestType === MINT_REQUEST_TYPE ? maxBuyingPremiumFeePercentage : toBN(0),
  }

  validateRequest(request, newExpectedRequest)
  this.state[oracleMargin.toString()].requests[requestId] = newExpectedRequest

  this.state[oracleMargin.toString()].nextRequestId = this.state[oracleMargin.toString()].nextRequestId.add(toBN(1))

  await validateState(oracleMargin)

  return { requestId, timeDelayFee, request }
}

const submitMintFulfillAndValidate = async (
  amount,
  delay,
  account,
  margin,
  timeUntilFulfill = MIN_WAIT_TIME,
  isCollateralized = false, //TODO: Remove
  shouldAbort = false,
  useKeepers = false,
) => {
  const { requestId, timeDelayFee, request } = await submitAndValidate(
    MINT_REQUEST_TYPE,
    amount,
    delay,
    account,
    margin,
    useKeepers,
  )
  await time.increase(timeUntilFulfill)
  await fulfillMintAndValidate(
    requestId,
    request,
    timeDelayFee,
    account,
    margin,
    isCollateralized,
    shouldAbort,
    useKeepers,
  )
}

const submitBurnFulfillAndValidate = async (
  amount,
  delay,
  account,
  margin,
  timeUntilFulfill = MIN_WAIT_TIME,
  useKeepers = false,
) => {
  const { requestId, timeDelayFee, request } = await submitAndValidate(
    BURN_REQUEST_TYPE,
    amount,
    delay,
    account,
    margin,
    useKeepers,
  )
  await time.increase(timeUntilFulfill)
  await fulfillBurnAndValidate(requestId, request, timeDelayFee, account, margin, useKeepers)
}

const submitAndLiquidate = async (
  type,
  amount,
  delay,
  account,
  liquidator,
  margin,
  timeUtnilLiquidate = MAX_PENALTY_TIME,
  useKeepers = false,
) => {
  const { requestId, request } = await submitAndValidate(type, amount, delay, account, margin, useKeepers)
  await time.increase(new BN(delay).add(new BN(timeUtnilLiquidate)).add(new BN(1)))
  await liquidateAndValidate(requestId, request, liquidator, margin, true, useKeepers)
}

const initFirstRebase = async (minter, mintAmount, margin, deposit = false) => {
  await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(margin)), bob)

  await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
  await this.volToken[margin.toString()].setCappedRebase(false, { from: admin })

  await submitMintFulfillAndValidate(mintAmount, SECONDS_PER_HOUR, minter, margin, SECONDS_PER_HOUR)
  await this.volToken[margin.toString()].rebaseCVI({ from: admin })
  await this.volToken[margin.toString()].setCappedRebase(true, { from: admin })
}

const getTokenPrice = async margin => {
  const balance = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))
    .currentPositionBalance
  const totalSupply = await this.volToken[margin.toString()].totalSupply()

  return balance.mul(TOKEN_PRICE_DECIMALS).mul(INITIAL_VOL_RATE).div(totalSupply)
}

const getStateTokenPrice = async margin => {
  const fundingFees = await calculatePendingFee(
    this.state,
    this.volToken[margin.toString()].address,
    this.state[margin.toString()].volTokenPositionUnits,
  )
  const balance = await calculatePositionBalance(this.state[margin.toString()].volTokenPositionUnits)
  const totalSupply = this.state[margin.toString()].volTokenSupply

  return balance.sub(fundingFees).mul(TOKEN_PRICE_DECIMALS).mul(INITIAL_VOL_RATE).div(totalSupply)
}

const testSubmitRequest = async (requestType, margin, useKeepers = false, maxBuyingPremiumFeePercentage = toBN(0)) => {
  const amounts = [500, 1000, 2500, 20000]
  const delays = [
    SECONDS_PER_HOUR,
    (SECONDS_PER_HOUR * 3) / 2,
    2 * SECONDS_PER_HOUR,
    (SECONDS_PER_HOUR * 5) / 2,
    3 * SECONDS_PER_HOUR,
  ]

  for (let amount of amounts) {
    for (let delay of delays) {
      await submitAndValidate(
        requestType,
        new BN(amount),
        delay,
        bob,
        margin,
        useKeepers,
        maxBuyingPremiumFeePercentage,
      )
    }
  }
}

const testRequestLiquidation = async (type, amount, margin, useKeepers) => {
  for (let delay of DELAYS_TO_TEST) {
    await submitAndLiquidate(type, amount, delay, bob, alice, margin, undefined, useKeepers)
  }
}

const testFulfillDeducesRequestsTotal = async margin => {
  await depositAndValidate(this.state, margin * 5000 * 2, alice)

  await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)), SECONDS_PER_HOUR, bob, margin)
  await submitAndValidate(
    MINT_REQUEST_TYPE,
    MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(1000)),
    SECONDS_PER_HOUR,
    bob,
    margin,
  )
  const { requestId, timeDelayFee, request } = await submitAndValidate(
    MINT_REQUEST_TYPE,
    new BN(1000),
    SECONDS_PER_HOUR,
    bob,
    margin,
  )

  await expectRevert(
    submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
    'Total requests amount exceeded',
  )

  await time.increase(SECONDS_PER_HOUR)
  await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)

  await expectRevert(
    submitAndValidate(MINT_REQUEST_TYPE, toBN(1001), SECONDS_PER_HOUR, bob, margin),
    'Total requests amount exceeded',
  )
  await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin)
}

for (let margin of [1, 2, 3]) {
  //ORACLE_MARGINS_TO_TEST) {
  describe(`VolatilityToken (margin = ${margin})`, () => {
    beforeEach(async () => {
      await beforeEachToken(margin)
      await deployPlatformHelper(ZERO_ADDRESS, ZERO_ADDRESS)
      await this.volToken[margin.toString()].setFulfiller(keeper, { from: admin })
    })

    it('reverts when submitting requests for zero tokens', async () => {
      await expectRevert.unspecified(this.volToken[margin.toString()].submitMintRequest(0, SECONDS_PER_HOUR))
      await expectRevert.unspecified(this.volToken[margin.toString()].submitBurnRequest(0, SECONDS_PER_HOUR))
    })

    it('reverts when sumbtting reuqests with delay too small', async () => {
      await expectRevert(
        this.volToken[margin.toString()].submitMintRequest(1000, MIN_TIME_DELAY - 2),
        'Time delay too small',
      )
      await expectRevert(
        this.volToken[margin.toString()].submitBurnRequest(1000, MIN_TIME_DELAY - 2),
        'Time delay too small',
      )
    })

    it('reverts when sumbtting reuqests with delay too big', async () => {
      await expectRevert(
        this.volToken[margin.toString()].submitMintRequest(1000, MAX_TIME_DELAY + 1),
        'Time delay too big',
      )
      await expectRevert(
        this.volToken[margin.toString()].submitBurnRequest(1000, MAX_TIME_DELAY + 1),
        'Time delay too big',
      )
    })

    it('reverts when fulfilling mint reuqests of different owner', async () => {
      const { requestId } = await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await expectRevert.unspecified(
        this.volToken[margin.toString()].fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, false, { from: alice }),
      )
      await expectRevert.unspecified(
        this.volToken[margin.toString()].fulfillMintRequest(requestId, MAX_FEE_PERCENTAGE, false, { from: admin }),
      )
    })

    it('reverts when fulfilling burn request of different owner', async () => {
      await depositAndValidate(this.state, margin * 5000 * 10, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const { requestId } = await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await expectRevert.unspecified(
        this.volToken[margin.toString()].fulfillBurnRequest(requestId, false, { from: alice }),
      )
      await expectRevert.unspecified(
        this.volToken[margin.toString()].fulfillBurnRequest(requestId, false, { from: admin }),
      )
    })

    it('reverts when fulfilling reuqests with an invalid id', async () => {
      await expectRevert.unspecified(
        this.volToken[margin.toString()].fulfillMintRequest(0, MAX_FEE_PERCENTAGE, false, { from: bob }),
      )
      await expectRevert.unspecified(this.volToken[margin.toString()].fulfillBurnRequest(7, false, { from: bob }))

      await expectRevert.unspecified(
        this.volToken[margin.toString()].fulfillMintRequest(0, MAX_FEE_PERCENTAGE, true, { from: bob }),
      )
      await expectRevert.unspecified(this.volToken[margin.toString()].fulfillBurnRequest(7, true, { from: bob }))
    })

    it('reverts when fulfilling mint reuqests of other types', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const { requestId: burnRequestId } = await submitAndValidate(
        BURN_REQUEST_TYPE,
        new BN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        this.volToken[margin.toString()].fulfillMintRequest(burnRequestId, MAX_FEE_PERCENTAGE, false, { from: bob }),
        'Wrong request type',
      )
    })

    it.skip('reverts when fulfilling keepers mint reuqests of other types', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const { requestId: mintRequestId } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        this.volToken[margin.toString()].fulfillBurnRequest(mintRequestId, false, { from: bob }),
        'Wrong request type',
      )
    })

    it('reverts when fulfilling burn reuqests of other types', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const { requestId: mintRequestId } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        this.volToken[margin.toString()].fulfillBurnRequest(mintRequestId, false, { from: bob }),
        'Wrong request type',
      )
    })

    it.skip('reverts when fulfilling keepers burn reuqests of other types', async () => {})

    it('reverts when fulfilling request ahead of time', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await expectRevert(
        submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin, MIN_WAIT_TIME.sub(new BN(2))),
        'Min wait time not over',
      )
      //YOFO: Sff vollsyrtsl mint test

      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin, MIN_WAIT_TIME)
      await expectRevert(
        submitBurnFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin, MIN_WAIT_TIME.sub(new BN(2))),
        'Min wait time not over',
      )
    })

    it('reverts when submitting a mint request and total requests amount is exceeded', async () => {
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
    })

    it('submits a mint request properly when total requests amount nearly exceeded', async () => {
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(10)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await submitAndValidate(MINT_REQUEST_TYPE, new BN(10), SECONDS_PER_HOUR, bob, margin)
    })

    it.skip('reverts when submitting a mint keepers request with too small amount', async () => {})

    it.skip('does not revert when submitting a mint request with too small amount for keepers', async () => {})

    it.skip('reverts when submitting a burn keepers request with too small amount', async () => {})

    it.skip('does not revert when submitting a burn request with too small amount for keepers', async () => {})

    it.skip('reverts when fulfilling a keepers mint request not by fulfiller (nor owner)', async () => {})

    it.skip('reverts when fulfilling a keepers burn request not by fulfiller (nor owner)', async () => {})

    it.skip('reverts when token amount is a uint168, but underlying amount exceeds it causing an overflow', async () => {
      // Request reverts if token amount is close to uint168 but not over, so that underlying amount is indeed over uint168 (in that case you should split to several burns)
    })

    it('submits a burn request properly when total requests amount is exceeded', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT, SECONDS_PER_HOUR, bob, margin)
      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await submitAndValidate(BURN_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin)
    })

    it('does not count burn requests in total requests amount', async () => {
      await depositAndValidate(this.state, MAX_TOTAL_REQUESTS_AMOUNT.mul(new BN(6)).mul(new BN(margin)), alice)
      await submitMintFulfillAndValidate(MAX_TOTAL_REQUESTS_AMOUNT, 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      expect(volTokens).to.be.bignumber.above(MAX_TOTAL_REQUESTS_AMOUNT)
      await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin)

      await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT, SECONDS_PER_HOUR, bob, margin)
    })

    it('allows submitting a request after maxed out by liquidating an existing request', async () => {
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.div(new BN(2)).sub(new BN(1000)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      const { requestId, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await time.increase(new BN(SECONDS_PER_HOUR).add(new BN(MAX_PENALTY_TIME)).add(new BN(1)))
      await liquidateAndValidate(requestId, request, alice, margin)

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1001), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
      await submitAndValidate(MINT_REQUEST_TYPE, new BN(1000), SECONDS_PER_HOUR, bob, margin)
    })

    it('allows submitting a request after maxed out by fulfilling an existing mint request', async () => {
      await testFulfillDeducesRequestsTotal(margin)
    })

    it('sets verify total requests amount properly', async () => {
      expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.true
      await this.volToken[margin.toString()].setVerifyTotalRequestsAmount(false, { from: admin })
      expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.false

      await submitAndValidate(
        MINT_REQUEST_TYPE,
        MAX_TOTAL_REQUESTS_AMOUNT.sub(new BN(1)),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
      const { requestId, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        new BN(1000),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      await this.volToken[margin.toString()].setVerifyTotalRequestsAmount(true, { from: admin })
      expect(await this.volToken[margin.toString()].verifyTotalRequestsAmount()).to.be.true

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await time.increase(new BN(SECONDS_PER_HOUR).add(new BN(MAX_PENALTY_TIME)).add(new BN(1)))
      await liquidateAndValidate(requestId, request, alice, margin)

      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(2), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
      await submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin)
    })

    it('sets max total requests amount properly', async () => {
      expect(await this.volToken[margin.toString()].maxTotalRequestsAmount()).to.be.bignumber.equal(
        MAX_TOTAL_REQUESTS_AMOUNT,
      )

      await submitAndValidate(MINT_REQUEST_TYPE, MAX_TOTAL_REQUESTS_AMOUNT, SECONDS_PER_HOUR, bob, margin)
      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )

      await this.volToken[margin.toString()].setMaxTotalRequestsAmount(MAX_TOTAL_REQUESTS_AMOUNT.add(new BN(1)), {
        from: admin,
      })
      await expectRevert(
        submitAndValidate(MINT_REQUEST_TYPE, toBN(2), SECONDS_PER_HOUR, bob, margin),
        'Total requests amount exceeded',
      )
      await submitAndValidate(MINT_REQUEST_TYPE, toBN(1), SECONDS_PER_HOUR, bob, margin)
    })

    it('submits a mint request properly', async () => {
      await testSubmitRequest(MINT_REQUEST_TYPE, margin)
    })

    it('submits a keepers mint request properly', async () => {
      await testSubmitRequest(MINT_REQUEST_TYPE, margin, true, toBN(1000))
    })

    it('submits a burn request properly', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      await testSubmitRequest(BURN_REQUEST_TYPE, margin)
    })

    it('submits a keepers burn request properly', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      await testSubmitRequest(BURN_REQUEST_TYPE, margin, true)
    })

    it('mints tokens properly for first user', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await time.increase(MIN_WAIT_TIME)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)
    })

    it('mints tokens properly by keepers', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
    })

    it.skip('mints tokens properly by keepers with max keepers fee activated', async () => {
      // Test keepers fee of 4$ in case of 0.1% more than that (max keepers fee)
    })

    it.skip('reverts when trying to mint tokens with no delay not by minter', async () => {})

    it.skip('mints tokens properly with no delay', async () => {})

    it('advances min request id properly to skip already fulfilled requests', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        1,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      for (let i = 0; i < 5; i++) {
        await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, 1, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(7))
    })

    it('advances min request id properly to skip non-keepers non-fulfilled requests', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      for (let i = 0; i < 5; i++) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(7))
    })

    it('advances min request id properly to skip non-keepers non-fulfilled requests and fulfilled requests', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) {
          await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
        } else {
          await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
        }

        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(7))
    })

    it('advances min request id properly to skip non-keepers non-fulfilled requests and fulfilled requests but hangs on non-fulfilled keeper request', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))

      let secondRequestData = null

      for (let i = 0; i < 5; i++) {
        if (i === 2) {
          secondRequestData = await submitAndValidate(
            MINT_REQUEST_TYPE,
            toBN(1000),
            2 * SECONDS_PER_HOUR,
            bob,
            margin,
            true,
            toBN(1000),
          )
        } else {
          if (i % 2 === 0) {
            await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
          } else {
            await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
          }
        }

        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(4))

      await fulfillMintAndValidate(
        secondRequestData.requestId,
        secondRequestData.request,
        secondRequestData.timeDelayFee,
        bob,
        margin,
        false,
        false,
        true,
      )
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(7))
    })

    it('advances min request id but up to maximum only', async () => {
      await depositAndValidate(this.state, margin * 50000 * 10, alice)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000),
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2))
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      for (let i = 0; i < 40; i++) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
        expect(await this.volToken[margin.toString()].nextRequestId()).to.be.bignumber.equal(toBN(2 + i + 1))
        expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(1))
      }

      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
      expect(await this.volToken[margin.toString()].minRequestId()).to.be.bignumber.equal(toBN(31))
    })

    it('mints tokens properly by keepers without penalty fee, even if delayed', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(3 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
    })

    it.skip('burns tokens properly by keepers without penalty fee, even if delayed', async () => {})

    it('allows fulfilling mint request by owner before target timestamp with penalty fee', async () => {
      const amount = toUSD(100000)
      await depositAndValidate(this.state, amount.mul(toBN(margin * 5 * 2)), bob)

      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(2 * SECONDS_PER_HOUR - 60)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)
    })

    it.skip('allows fulfilling burn request by owner before target timestamp with penalty fee', async () => {})

    it('allows fulfilling mint request by owner after target timestamp without penalty fee', async () => {
      const amount = toUSD(100000)
      await depositAndValidate(this.state, amount.mul(toBN(margin * 5 * 2)), bob)

      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(2 * SECONDS_PER_HOUR + 30)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)
    })

    it.skip('allows fulfilling burn request by owner after target timestamp without penalty fee', async () => {})

    it('reverts when fulfilling mint request by keepers before target timestamp', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      const requestTimestamp = await time.latest()
      await time.increaseTo(requestTimestamp.add(toBN(2 * SECONDS_PER_HOUR).sub(toBN(3))))

      await expectRevert(
        fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true),
        'Target time not reached',
      )
    })

    it.skip('reverts when fulfilling burn request by keepers before target timestamp', async () => {})

    it('reverts when fulfilling mint request by keepers of a not use keepers request', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await time.increase(2 * SECONDS_PER_HOUR)

      await expectRevert.unspecified(
        fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true),
      )
    })

    it.skip('reverts when fulfilling burn request by keepers of a not use keepers request', async () => {})

    it('catches revert when fulfilling mint request by keepers when max premium fee is exceeded (transaction succeeds, but fulfill is not done)', async () => {
      await depositAndValidate(this.state, 2000 * 2, bob) // Small deposit to cause premium fee

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(10),
      )
      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true, toBN(10), false)
    })

    it('catches revert when fulfilling mint request by keepers when not enough platform liquidity (transaction succeeds, but fulfill is not done)', async () => {
      await depositAndValidate(this.state, toUSD(600), bob)

      const amount = toUSD(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true, toBN(1000), false)
    })

    it('mints and burns tokens properly when there is a premium fee', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(11000), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin)
    })

    it.skip('mints and burns tokens properly when there is a volume fee (not charging it)', async () => {})

    it('mints tokens properly collateralized without charging premium fee', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(11000), 2 * SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
    })

    it('mints tokens properly for multi users when time and cvi changes', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await time.increase(60 * 60)
      await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol, margin)
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await time.increase(60 * 70)
      await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave, margin)
      await time.increase(60 * 80)
      await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob, margin)
    })

    it('mints tokens proportionaly', async () => {
      await depositAndValidate(this.state, margin * toUSD(20000 * 2), alice)
      await submitMintFulfillAndValidate(toUSD(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await submitMintFulfillAndValidate(toUSD(2000), 2 * SECONDS_PER_HOUR, carol, margin)
      await submitMintFulfillAndValidate(toUSD(3000), 2 * SECONDS_PER_HOUR, dave, margin)

      const bobVolTokens = await this.volToken[margin.toString()].balanceOf(bob)
      const carolVolTokens = await this.volToken[margin.toString()].balanceOf(carol)
      const daveVolTokens = await this.volToken[margin.toString()].balanceOf(dave)

      expect(carolVolTokens.mul(toBN(1000)).div(bobVolTokens)).to.be.bignumber.at.least(toBN(2000))
      expect(carolVolTokens.mul(toBN(1000)).div(bobVolTokens)).to.be.bignumber.at.most(toBN(2010))

      expect(daveVolTokens.mul(toBN(1000)).div(bobVolTokens)).to.be.bignumber.at.least(toBN(3000))
      expect(daveVolTokens.mul(toBN(1000)).div(bobVolTokens)).to.be.bignumber.at.most(toBN(3010))
    })

    //TODO: Not needed anymore?
    it.skip('mints tokens properly collateralized (position gain + position loss)', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(9900))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(10500))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
      await this.fakePriceProvider.setPrice(toCVI(11000))
      await submitMintFulfillAndValidate(toBN(50000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR, true)
    })

    it.skip('mints and burns tokens properly for multi users', async () => {})

    it('burns tokens properly for single user', async () => {
      await depositAndValidate(this.state, margin * 10000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      await submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin)
    })

    it('burns tokens properly by keepers', async () => {
      await depositAndValidate(this.state, margin * 10000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        BURN_REQUEST_TYPE,
        volTokens,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
      )
      await time.increase(2 * SECONDS_PER_HOUR)
      await fulfillBurnAndValidate(requestId, request, timeDelayFee, bob, margin, true)
    })

    it.skip('reverts when trying to burn tokens with no delay not by minter', async () => {})

    it.skip('burn tokens properly with no delay', async () => {})

    it.skip('burns dust tokens without reverting and without rewarding any tokens', async () => {})

    it('burns tokens properly for multi users when time and cvi changes', async () => {
      await depositAndValidate(this.state, margin * 20000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)
      await submitMintFulfillAndValidate(new BN(700), 2 * SECONDS_PER_HOUR, carol, margin)
      await submitMintFulfillAndValidate(new BN(200), 2 * SECONDS_PER_HOUR, dave, margin)
      await submitMintFulfillAndValidate(new BN(500), 2 * SECONDS_PER_HOUR, bob, margin)

      const volTokensBob = await this.volToken[margin.toString()].balanceOf(bob)
      await submitBurnFulfillAndValidate(volTokensBob.div(toBN(2)), 2 * SECONDS_PER_HOUR, bob, margin)
      await time.increase(60 * 60)
      const volTokensCarol = await this.volToken[margin.toString()].balanceOf(carol)
      await submitBurnFulfillAndValidate(volTokensCarol, SECONDS_PER_HOUR, carol, margin)
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await time.increase(60 * 70)
      const volTokensDave = await this.volToken[margin.toString()].balanceOf(dave)
      await submitBurnFulfillAndValidate(volTokensDave, 2 * SECONDS_PER_HOUR, dave, margin)
      await time.increase(60 * 80)
      await submitBurnFulfillAndValidate(volTokensBob.div(toBN(2)), 3 * SECONDS_PER_HOUR, bob, margin)
    })

    it('reverts when trying to liquidate before max request fulfill time passed', async () => {
      for (let delay of DELAYS_TO_TEST) {
        await expectRevert(
          submitAndLiquidate(
            MINT_REQUEST_TYPE,
            new BN(1000),
            delay,
            bob,
            alice,
            margin,
            MAX_PENALTY_FEE.sub(new BN(2)),
          ),
          'Not liquidable',
        )
      }
    })

    it('reverts when trying to mint/burn/rebase when position balance is negative', async () => {
      await this.fakePriceProvider.setPrice(toCVI(11000))

      await depositAndValidate(this.state, margin * 10000 * 2, alice)
      await submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin)

      const daysToLiquidation = await calculateLiquidationDays(
        this.state,
        this.volToken[margin.toString()].address,
        11000 * getContracts().oracleLeverage,
        true,
      )
      await time.increase(SECONDS_PER_DAY.mul(daysToLiquidation))

      const result = await this.platform.calculatePositionBalance(this.volToken[margin.toString()].address)
      expect(result.isPositive).to.be.false

      await expectRevert(
        submitMintFulfillAndValidate(new BN(1000), 2 * SECONDS_PER_HOUR, bob, margin),
        'Negative balance',
      )
      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      await expectRevert(submitBurnFulfillAndValidate(volTokens, 2 * SECONDS_PER_HOUR, bob, margin), 'Negative balance')
      await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Negative balance')
    })

    it('reverts when liquidating a non-existent request id', async () => {
      await expectRevert(this.volToken[margin.toString()].liquidateRequest(2, { from: bob }), 'Request id not found')
    })

    it('allows mint request liquidation properly', async () => {
      await testRequestLiquidation(MINT_REQUEST_TYPE, new BN(1000), margin)
    })

    it('allows keepers mint request liquidation properly', async () => {
      await testRequestLiquidation(MINT_REQUEST_TYPE, new BN(1000), margin, true)
    })

    it('allows burn request liquidation properly', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, margin * 30000, alice)
      await submitMintFulfillAndValidate(new BN(5000), 2 * SECONDS_PER_HOUR, bob, margin)

      await testRequestLiquidation(BURN_REQUEST_TYPE, toBN(1000, 12), margin)
    })

    it('allows keepers burn request liquidation properly', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, margin * 30000, alice)
      await submitMintFulfillAndValidate(new BN(5000), 2 * SECONDS_PER_HOUR, bob, margin)

      await testRequestLiquidation(BURN_REQUEST_TYPE, toBN(1000, 12), margin, true)
    })

    //TODO: Fix validateState discrepancy in vol token intrinsic price because of balance calculated with addendum
    it('liquidates burn request properly when close fees of left amount are positive', async () => {
      await depositAndValidate(this.state, toUSD(30000).mul(new BN(margin)), alice)
      await submitMintFulfillAndValidate(toUSD(5000), 2 * SECONDS_PER_HOUR, bob, margin)

      await submitAndLiquidate(
        BURN_REQUEST_TYPE,
        toUSD(1000).mul(INITIAL_VOL_RATE),
        2 * SECONDS_PER_HOUR,
        bob,
        alice,
        margin,
      )
    })

    it.skip('liquidates when fulfilling a liquidable mint request', async () => {})

    it.skip('liquidates when fulfilling a liquidable burn request', async () => {})

    it.skip('reverts when rebasing not by rebaser', async () => {})

    it('reverts when rebasing and deviation is not high enough', async () => {
      await this.fakePriceProvider.setPrice(toCVI(5000))
      await initFirstRebase(bob, toBN(2000, 6), margin)

      await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Not enough deviation')

      // Funding fees are 10% per day, so after 10th of a day deviation should be enough, which is 2.4 hours
      await time.increase(toBN(SECONDS_PER_HOUR))
      await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Not enough deviation')
      await time.increase(toBN(SECONDS_PER_HOUR))
      await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Not enough deviation')
      await time.increase(toBN(SECONDS_PER_HOUR).div(toBN(2)))
      await this.volToken[margin.toString()].rebaseCVI({ from: admin })
    })

    it('reverts when rebasing and deviation is too high (first rebase)', async () => {
      await this.fakePriceProvider.setPrice(toCVI(201))
      await depositAndValidate(this.state, toBN(500000, 6).mul(new BN(margin)), bob)

      await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
      await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR)

      // From 1$ to 2+$ is more than 50% (out of 2+)
      await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Deviation too big')
    })

    if (margin === 1) {
      it('reverts when rebasing and deviation is too high (subsequent rebase)', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000))
        await initFirstRebase(bob, toBN(2000, 6), margin)

        // After 5 days, deviation is 50% for margin 1 (for margin 2 and on position will be nagative, so can't test for margin > 1)
        const timeUntilDeviation = SECONDS_PER_DAY.mul(toBN(5))
        await time.increase(timeUntilDeviation)

        await expectRevert(this.volToken[margin.toString()].rebaseCVI({ from: admin }), 'Deviation too big')
      })

      it('does not revert when rebasing and deviation is almost too high (subsequent rebase)', async () => {
        await this.fakePriceProvider.setPrice(toCVI(5000))
        await initFirstRebase(bob, toBN(2000, 6), margin)

        // After 5 days, deviation is 50% for margin 1 (for margin 2 and on position will be nagative, so can't test for margin > 1)
        const timeUntilDeviation = SECONDS_PER_DAY.mul(toBN(5)).sub(toBN(60))
        await time.increase(timeUntilDeviation)

        await this.volToken[margin.toString()].rebaseCVI({ from: admin })
      })
    }

    it.skip('rebases to price properly with different calculated rebase lag values', async () => {
      //for (rebaseLag of REBASE_LAGS_TO_TEST) {}
    })

    it('rebases to price correctly on first rebase (capped rebase off)', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(margin)), bob)

      await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
      await this.volToken[margin.toString()].setCappedRebase(false, { from: admin })

      await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR)

      const priceBeforeRebase = await getTokenPrice(margin)
      expect(priceBeforeRebase).to.be.bignumber.equal(TOKEN_PRICE_DECIMALS.mul(toBN(1))) // Initial price is always 1$
      await this.volToken[margin.toString()].rebaseCVI({ from: admin })
      const priceAfterRebase = await getTokenPrice(margin)
      expect(priceAfterRebase).to.be.bignumber.equal(
        TOKEN_PRICE_DECIMALS.mul(toBN(100 * getContracts().oracleLeverage)),
      ) // CVI is 100
    })

    it.skip('cvi move reflects correctly in token price', async () => {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(margin)), bob)

      await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
      await this.volToken[margin.toString()].setCappedRebase(false, { from: admin })

      await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR)

      const priceBeforeRebase = await getTokenPrice(margin)
      //expect(priceBeforeRebase).to.be.bignumber.equal(TOKEN_PRICE_DECIMALS.mul(toBN(1))) // Initial price is always 1$
      //await this.volToken[margin.toString()].rebaseCVI({ from: admin })
      const priceAfterRebase = await getTokenPrice(margin)
      //expect(priceAfterRebase).to.be.bignumber.equal(TOKEN_PRICE_DECIMALS.mul(toBN(100 * margin))) // CVI is 100

      let balance = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))
        .currentPositionBalance
      console.log('balance b: ' + balance.toString())
      await this.fakePriceProvider.setPrice(toCVI(20000))
      balance = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))
        .currentPositionBalance
      const price = await getTokenPrice(margin)
      console.log('price: ' + price.toString())
      console.log('balance a: ' + balance.toString())
    })

    //TODO: CalculatePositionBalance from DeployUtils or not?...

    it.skip('rebases to price correctly with enough deviation (not first rebase)', async () => {
      // NOTE: Add expects that actually test the rebase result...

      await this.fakePriceProvider.setPrice(toCVI(10000))
      await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(margin)), bob)

      await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
      await this.volToken[margin.toString()].setCappedRebase(false, { from: admin })

      await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, bob, margin, SECONDS_PER_HOUR)

      let balance = (
        await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address)
      )[0]
      let bobTokens = await this.volToken[margin.toString()].balanceOf(bob)

      const decimals = toBN(1, 6)

      await this.volToken[margin.toString()].rebaseCVI({ from: admin })
      bobTokens = await this.volToken[margin.toString()].balanceOf(bob)
      balance = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))[0]
      //console.log('balance2', balance2.toString());

      /*await submitMintFulfillAndValidate(toBN(2000, 6), SECONDS_PER_HOUR, alice, margin, SECONDS_PER_HOUR);

            const balance3 = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))[0];
            //console.log('balance3', balance3.toString());

            //console.log('balance-after-mint-bob', (await this.volToken[margin.toString()].balanceOf(bob)).toString());
            //console.log('balance-after-mint-alice', (await this.volToken[margin.toString()].balanceOf(alice)).toString());

            await this.fakePriceProvider.setPrice(toCVI(10000));

            //await submitBurnFulfillAndValidate((await this.volToken[margin.toString()].balanceOf(bob)), 2 * SECONDS_PER_HOUR, bob, margin);

            //console.log('totalSupply-before', (await this.volToken[margin.toString()].totalSupply()).toString());
            //console.log('scalingFactor-before', (await this.volToken[margin.toString()].scalingFactor()).toString());

            await this.volToken[margin.toString()].rebaseCVI({from: admin});

            const balance4 = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))[0];
            //console.log('balance4', balance4.toString());

            //console.log('totalSupply-after', (await this.volToken[margin.toString()].totalSupply()).toString());
            //console.log('scalingFactor-after', (await this.volToken[margin.toString()].scalingFactor()).toString());

            await time.increase(60 * 60 * 24 * 4);

            const balance5 = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))[0];
            //console.log('balance5', balance5.toString());

            await this.fakePriceProvider.setPrice(toCVI(10000));

            const balance6 = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))[0];
            //console.log('balance6', balance6.toString());

            await this.volToken[margin.toString()].setRebaseLag(2, {from: admin});
            await this.volToken[margin.toString()].rebaseCVI({from: admin});
            //await this.volToken[margin.toString()].rebaseCVI({from: admin});

            const balance7 = (await getContracts().platform.calculatePositionBalance(this.volToken[margin.toString()].address))[0];
            //console.log('balance7', balance7.toString());

            //console.log('totalSupply-after', (await this.volToken[margin.toString()].totalSupply()).toString());
            //console.log('scalingFactor-after', (await this.volToken[margin.toString()].scalingFactor()).toString());

            //console.log('alice-balance', (await this.volToken[margin.toString()].balanceOf(alice)).toString());
            //console.log('bob-balance', (await this.volToken[margin.toString()].balanceOf(bob)).toString());*/
    })

    it.skip('fulfills mint request properly, when rebase occurs between request submit and fulfill', async () => {
      // NOTE: Calculate rebase on js, have rebaseAndValidate, keep factor at hand...
    })

    it.skip('fulfills burn request properly, when rebase occurs between request submit and fulfill', async () => {})

    it.skip('liquidates mint request properly, when rebase occurs between request submit and liquidation', async () => {})

    it.skip('liquidates burn request properly, when rebase occurs between request submit and liquidation', async () => {})

    it('allows fulfilling when totalRequestsAmount becomes negative (zeroes it instead)', async () => {
      await beforeEachToken(margin, true)
      await deployPlatformHelper(ZERO_ADDRESS, ZERO_ADDRESS)
      await depositAndValidate(this.state, toBN(100000, 6), bob)

      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000, 6),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      // Zero out totalRequestsAmount
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(1000, 6))
      await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(0), { from: admin })
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))

      await time.increase(SECONDS_PER_HOUR)

      // Should pass properly
      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))

      const {
        requestId: requestId2,
        timeDelayFee: timeDelayFee2,
        request: request2,
      } = await submitAndValidate(MINT_REQUEST_TYPE, toBN(2000, 6), SECONDS_PER_HOUR, bob, margin)

      // Subtract 1 from totalRequestsAmount
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6))
      await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(2000, 6).sub(toBN(1)), { from: admin })
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(
        toBN(2000, 6).sub(toBN(1)),
      )

      await time.increase(SECONDS_PER_HOUR)

      // Should pass properly
      await fulfillMintAndValidate(requestId2, request2, timeDelayFee2, bob, margin)
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))
    })

    it('allows liquidating when totalRequestsAmount becomes negative (zeroes it instead)', async () => {
      await beforeEachToken(margin, true)
      await deployPlatformHelper(ZERO_ADDRESS, ZERO_ADDRESS)
      await depositAndValidate(this.state, toBN(100000, 6), bob)

      const { requestId, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000, 6),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      // Zero out totalRequestsAmount
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(1000, 6))
      await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(0), { from: admin })
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))

      await time.increase(toBN(MAX_PENALTY_TIME).add(toBN(SECONDS_PER_HOUR).add(toBN(1))))

      // Should pass properly
      await liquidateAndValidate(requestId, request, alice, margin, false)
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))

      const { requestId: requestId2, request: request2 } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(2000, 6),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )

      // Subtract 1 from totalRequestsAmount
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(2000, 6))
      await this.volToken[margin.toString()].setTotalRequestsAmount(toBN(2000, 6).sub(toBN(1)), { from: admin })
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(
        toBN(2000, 6).sub(toBN(1)),
      )

      await time.increase(toBN(MAX_PENALTY_TIME).add(toBN(SECONDS_PER_HOUR).add(toBN(1))))

      // Should pass properly
      await liquidateAndValidate(requestId2, request2, alice, margin, false)
      expect(await this.volToken[margin.toString()].totalRequestsAmount()).to.be.bignumber.equal(toBN(0))
    })

    it.skip('sets minter properly', async () => {})

    it.skip('sets platform properly', async () => {
      // Make sure it makes sense business-wise
    })

    it.skip('sets fees calculator properly', async () => {
      // Make sure it's not best to get it from platform...
    })

    it.skip('sets fees collector properly', async () => {})

    it.skip('sets request fees calculator properly', async () => {})

    it.skip('sets oracle properly', async () => {
      // Make sure it's not best to get it from platform...
    })

    it.skip('sets is rebase capped properly', async () => {})

    it.skip('sets min request id properly', async () => {})

    it.skip('sets max min request increments properly', async () => {})

    it.skip('sets fulfiller properly', async () => {})

    it.skip('sets keepers fee vault address properly', async () => {})

    it.skip('sets min keepers mint amount properly', async () => {})

    it.skip('sets min keepers burn amount properly', async () => {})

    it.skip('sets deviation per single rebase lag properly', async () => {})

    it.skip('sets rebase min deviation percent properly', async () => {})

    it.skip('sets rebase max deviation percent properly', async () => {})

    const validateCalculateMint = async (tokensAmount, margin, timeWindow, isKeepers, requestId = 0) => {
      const result = await getContracts().platformHelper.calculatePreMint(
        this.volToken[margin.toString()].address,
        isKeepers,
        tokensAmount,
        timeWindow,
      )
      const { latestTimestamp, snapshot } = await updateSnapshots(this.state, false)

      const timeWindowFeePercentage = calculateTimeDelayFeePercentage(timeWindow)
      const timeWindowFee = tokensAmount.mul(timeWindowFeePercentage).div(MAX_FEE_PERCENTAGE)
      console.log('test time window fee: ' + timeWindowFee.toString())

      const penaltyPercentage = toBN(0)
      if (!isKeepers) {
        const request = this.state.requests[requestId]
        const penaltyPercentage = calculateTimePenaltyFeePercentage(
          latestTimestamp,
          request.requestTimestamp,
          request.targetTimestamp,
        )
      }

      const penaltyFees = tokensAmount.mul(penaltyPercentage).div(MAX_FEE_PERCENTAGE)
      const keepersFee = isKeepers ? calculateKeepersFee(tokensAmount) : toBN(0)

      const mintAmount = tokensAmount.sub(timeWindowFee).sub(penaltyFees).sub(keepersFee)
      console.log('test keepers: ' + keepersFee.toString())
      console.log('test penalty: ' + penaltyFees.toString())
      console.log('test mint: ' + mintAmount.toString())

      const { openPositionPremiumFees, premiumPercentage } = await calculateOpenPositionAmounts(
        this.state,
        latestTimestamp,
        mintAmount,
        ALL_FEES,
        1,
      )
      console.log('test premium: ' + openPositionPremiumFees.toString())
      const { positionedTokenAmount, volTokens } = await calculateMintAmount(
        this.state,
        mintAmount,
        openPositionPremiumFees,
        new BN(1),
        snapshot,
      )
      console.log('test positioned: ' + positionedTokenAmount.toString())

      expect(result.buyingPremiumFeePercentage).to.be.bignumber.equal(premiumPercentage)
      expect(result.expectedVolTokensAmount).to.be.bignumber.equal(volTokens)
      expect(result.netMintAmount).to.be.bignumber.equal(positionedTokenAmount)
    }

    it('helper calculates supposed minted tokens properly for first user', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      await validateCalculateMint(amount, margin, MIN_TIME_DELAY, true, undefined)

      /*const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
      )
      await time.increase(MIN_WAIT_TIME)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin)*/
    })

    it('helper calculates supposed minted tokens properly by keepers (for first user)', async () => {
      await depositAndValidate(this.state, margin * 5000 * 2, bob)

      const amount = new BN(1000)
      const { requestId, timeDelayFee, request } = await submitAndValidate(
        MINT_REQUEST_TYPE,
        amount,
        2 * SECONDS_PER_HOUR,
        bob,
        margin,
        true,
        toBN(1000),
      )
      await time.increase(2 * SECONDS_PER_HOUR)

      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false, true)
    })
  })
}

describe('RequestFulfiller', () => {
  beforeEach(async () => {
    await beforeEachToken(1)
    await deployPlatformHelper(ZERO_ADDRESS, ZERO_ADDRESS)
    this.requestFulfiller['1'].setFulfillerAddress(keeper, true)
    this.volToken['1'].setFulfiller(this.requestFulfiller['1'].address, { from: admin })
  })

  it('shows no upkeep when no requests exist', async () => {
    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it('shows no upkeep when all requests are non-keepers (and after target timestamp)', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      } else {
        await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      }
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it('shows no upkeep when all keepers requests are already fulfilled', async () => {
    await depositAndValidate(this.state, toBN(500000, 6), bob)

    this.volToken['1'].setFulfiller(keeper, { from: admin })

    for (let i = 0; i < 5; i++) {
      await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR, false, false, true)
      await this.fakePriceProvider.setPrice(toCVI(10000))
    }

    for (let i = 0; i < 5; i++) {
      await submitBurnFulfillAndValidate(
        (await this.volToken['1'].balanceOf(bob)).div(toBN(5)),
        2 * SECONDS_PER_HOUR,
        bob,
        1,
        true,
      )
    }

    this.volToken['1'].setFulfiller(this.requestFulfiller['1'].address, { from: admin })

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it('shows no upkeep when all keepers requests are already fulfilled and existing requests are non-keepers (and after target timestamp)', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    this.volToken['1'].setFulfiller(keeper, { from: admin })

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      } else {
        await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      }
    }

    for (let i = 0; i < 5; i++) {
      await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR, false, false, true)
      await this.fakePriceProvider.setPrice(toCVI(10000))
    }

    for (let i = 0; i < 5; i++) {
      await submitBurnFulfillAndValidate(
        (await this.volToken['1'].balanceOf(bob)).div(toBN(5)),
        2 * SECONDS_PER_HOUR,
        bob,
        1,
      )
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    this.volToken['1'].setFulfiller(this.requestFulfiller['1'].address, { from: admin })

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it('shows no upkeep when keepers requests exist but target timestamp has not passed yet', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)
      } else {
        await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)
      }
    }

    await time.increase(2 * SECONDS_PER_HOUR - 20)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.false
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'No fulfillable requests')
  })

  it('shows upkeep when only burn keepers requests exist', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    for (let i = 0; i < 5; i++) {
      await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.true
    await this.requestFulfiller['1'].performUpkeep(0, { from: keeper })
  })

  it('shows upkeep when only mint keepers requests exist', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    for (let i = 0; i < 5; i++) {
      await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.true
    await this.requestFulfiller['1'].performUpkeep(0, { from: keeper })
  })

  it('shows upkeep when only one keeper request exist and other requests are non-keepers', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)

    await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1, true)

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      } else {
        await submitAndValidate(BURN_REQUEST_TYPE, toBN(1000), 2 * SECONDS_PER_HOUR, bob, 1)
      }
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    expect((await this.requestFulfiller['1'].checkUpkeep(0)).upkeepNeeded).to.be.true
    await this.requestFulfiller['1'].performUpkeep(0, { from: keeper })
  })

  it('fulfills properly both mint and burn requests when performing upkeep', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, dave, 1, SECONDS_PER_HOUR)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      2 * SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )

    const accounts = [bob]
    const requestIds = [requestId]
    const timeDelayFees = [timeDelayFee]
    const shouldFulfill = [true]

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        const account = i >= 2 ? alice : carol
        const { requestId, timeDelayFee } = await submitAndValidate(
          MINT_REQUEST_TYPE,
          toBN(1000),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      } else {
        const account = i >= 2 ? bob : dave
        const { requestId, timeDelayFee } = await submitAndValidate(
          BURN_REQUEST_TYPE,
          (await this.volToken['1'].balanceOf(account)).div(toBN(10)),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      }

      shouldFulfill.push(true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)

    await fulfillAndValidate(
      requestIds,
      undefined,
      timeDelayFees,
      accounts,
      1,
      false,
      false,
      true,
      undefined,
      shouldFulfill,
    )
  })

  it('passes max premium fee correctly to fulfill request when performing upkeep', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      alice,
      1,
      true,
      toBN(200),
    )
    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      carol,
      1,
      true,
      toBN(110),
    )

    await time.increase(SECONDS_PER_HOUR)

    // Cause turbulence so premium fee is 0.25%
    await this.fakePriceProvider.setPrice(toCVI(11000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(12000))

    const currTurbulence = await this.platform.calculateLatestTurbulenceIndicatorPercent()
    expect(currTurbulence).to.be.bignumber.equal(toBN(100)) // So total is 1.15%

    // Make sure first request fulfills and second does not
    await fulfillMintAndValidate(
      [requestId, requestId2],
      undefined,
      [timeDelayFee, timeDelayFee2],
      [alice, carol],
      1,
      false,
      false,
      true,
      undefined,
      [true, false],
    )
  })

  it('reverts upkeep when all pending requests fail because of too high premium fee or not enough liquidity', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    // Two will revert on max premium fee
    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      alice,
      1,
      true,
      toBN(100),
    )
    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      carol,
      1,
      true,
      toBN(110),
    )

    // And one on not enough liquidity
    const { requestId: requestId3, timeDelayFee: timeDelayFee3 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(70000, 6),
      SECONDS_PER_HOUR,
      dave,
      1,
      true,
      toBN(1000),
    )

    await time.increase(SECONDS_PER_HOUR)

    // Cause turbulence so premium fee is 1.15%
    await this.fakePriceProvider.setPrice(toCVI(11000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(12000))

    const currTurbulence = await this.platform.calculateLatestTurbulenceIndicatorPercent()
    expect(currTurbulence).to.be.bignumber.equal(toBN(100)) // So total is 1.15%

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: keeper }), 'Failed to fulfill requests')
  })

  it('does not fulfill too high premium fee and not enough liquidity requests, but fulfills others (transacion does not fail)', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    // Will revert on maximum premium fee
    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      alice,
      1,
      true,
      toBN(100),
    )

    // Should fulfill
    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      carol,
      1,
      true,
      toBN(300),
    )

    // And one on not enough liquidity
    const { requestId: requestId3, timeDelayFee: timeDelayFee3 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(70000, 6),
      SECONDS_PER_HOUR,
      dave,
      1,
      true,
      toBN(1000),
    )

    await time.increase(SECONDS_PER_HOUR)

    // Cause turbulence so premium fee is 1.15%
    await this.fakePriceProvider.setPrice(toCVI(11000))
    await time.increase(1)
    await this.fakePriceProvider.setPrice(toCVI(12000))

    const currTurbulence = await this.platform.calculateLatestTurbulenceIndicatorPercent()
    expect(currTurbulence).to.be.bignumber.equal(toBN(100)) // So total is 1.15%

    await fulfillMintAndValidate(
      [requestId, requestId2, requestId3],
      undefined,
      [timeDelayFee, timeDelayFee2, timeDelayFee3],
      [alice, carol, dave],
      1,
      false,
      false,
      true,
      undefined,
      [false, true, false],
    )
  })

  it('checks requests from minRequestId to nextRequestId only (and not before minRequestId)', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, dave, 1, SECONDS_PER_HOUR)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      2 * SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )

    // Does not include first request
    const accounts = []
    const requestIds = []
    const timeDelayFees = []
    const shouldFulfill = []

    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) {
        const account = i >= 2 ? alice : carol
        const { requestId, timeDelayFee } = await submitAndValidate(
          MINT_REQUEST_TYPE,
          toBN(1000),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      } else {
        const account = i >= 2 ? bob : dave
        const { requestId, timeDelayFee } = await submitAndValidate(
          BURN_REQUEST_TYPE,
          (await this.volToken['1'].balanceOf(account)).div(toBN(10)),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )
        accounts.push(account)
        timeDelayFees.push(timeDelayFee)
        requestIds.push(requestId)
      }

      shouldFulfill.push(true)
    }

    await time.increase(2 * SECONDS_PER_HOUR)
    await this.volToken['1'].setMinRequestId(requestId.add(toBN(1))) // Should skip first request
    this.state['1'].minRequestId = requestId.add(toBN(1))

    await fulfillAndValidate(
      requestIds,
      undefined,
      timeDelayFees,
      accounts,
      1,
      false,
      false,
      true,
      undefined,
      shouldFulfill,
    )

    // Make sure request still exists
    const request = await this.volToken['1'].requests(requestId)
    expect(request.requestType).to.be.bignumber.equal(toBN(MINT_REQUEST_TYPE))
  })

  it('checks requests from minRequestId to up to maxMinRequestIncrements only', async () => {
    expect(await this.volToken['1'].maxMinRequestIncrements()).to.be.bignumber.equal(toBN(30))

    await depositAndValidate(this.state, toBN(50000, 6), bob)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, bob, 1, SECONDS_PER_HOUR)
    await submitMintFulfillAndValidate(toBN(1000, 6), SECONDS_PER_HOUR, dave, 1, SECONDS_PER_HOUR)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      2 * SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )

    // Does not include first request
    const accounts = [bob]
    const requestIds = [requestId]
    const timeDelayFees = [timeDelayFee]
    const shouldFulfill = [true]

    const extraAccounts = []
    const extraRequestIds = []
    const extraTimeDelayFees = []
    const extraShouldFulfill = []

    for (let i = 0; i < 35; i++) {
      if (i % 2 === 0) {
        const account = i >= 2 ? alice : carol
        const { requestId, timeDelayFee } = await submitAndValidate(
          MINT_REQUEST_TYPE,
          toBN(1000),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )

        if (i < 29) {
          accounts.push(account)
          timeDelayFees.push(timeDelayFee)
          requestIds.push(requestId)
          shouldFulfill.push(true)
        } else {
          extraAccounts.push(account)
          extraTimeDelayFees.push(timeDelayFee)
          extraRequestIds.push(requestId)
          extraShouldFulfill.push(true)
        }
      } else {
        const account = i >= 2 ? bob : dave
        const { requestId, timeDelayFee } = await submitAndValidate(
          BURN_REQUEST_TYPE,
          (await this.volToken['1'].balanceOf(account)).div(toBN(30)),
          2 * SECONDS_PER_HOUR,
          account,
          1,
          true,
        )

        if (i < 29) {
          accounts.push(account)
          timeDelayFees.push(timeDelayFee)
          requestIds.push(requestId)
          shouldFulfill.push(true)
        } else {
          extraAccounts.push(account)
          extraTimeDelayFees.push(timeDelayFee)
          extraRequestIds.push(requestId)
          extraShouldFulfill.push(true)
        }
      }
    }

    await time.increase(2 * SECONDS_PER_HOUR)
    await fulfillAndValidate(
      requestIds,
      undefined,
      timeDelayFees,
      accounts,
      1,
      false,
      false,
      true,
      undefined,
      shouldFulfill,
    )

    // Make sure requests in indices 33 to 37 still exists, and others are fulfilled or non-existent
    for (let i = 1; i < 40; i++) {
      const request = await this.volToken['1'].requests(toBN(i))

      if (i >= 39) {
        expect(request.requestType).to.be.bignumber.equal(toBN(0))
      } else if (i >= 33) {
        expect(request.requestType).to.be.bignumber.not.equal(toBN(0))
      } else {
        expect(request.requestType).to.be.bignumber.equal(toBN(0))
      }
    }

    await fulfillAndValidate(
      extraRequestIds,
      undefined,
      extraTimeDelayFees,
      extraAccounts,
      1,
      false,
      false,
      true,
      undefined,
      extraShouldFulfill,
    )

    // Make sure all remaining requests are now fulfilled
    for (let i = 1; i < 40; i++) {
      const request = await this.volToken['1'].requests(toBN(i))
      expect(request.requestType).to.be.bignumber.equal(toBN(0))
    }
  })

  it('allows upkeep from any address when whitelist is disabled', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    await this.requestFulfiller['1'].setEnableWhitelist(false, { from: admin })

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate([requestId], undefined, [timeDelayFee], [bob], 1, false, false, true, undefined, [
      true,
    ])

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate([requestId2], undefined, [timeDelayFee2], [bob], 1, false, false, true, undefined, [
      true,
    ])

    const { requestId: requestId3, timeDelayFee: timeDelayFee3 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate([requestId3], undefined, [timeDelayFee3], [bob], 1, false, false, true, undefined, [
      true,
    ])
  })

  it('reverts when trying to upkeep from non-whitelisted address and whitelist is enabled', async () => {
    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: bob }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: admin }), 'Not allowed')
  })

  it('allows multiple addresses whiltelisting', async () => {
    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await depositAndValidate(this.state, toBN(50000, 6), bob)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setFulfillerAddress(alice, true, { from: admin })
    await this.requestFulfiller['1'].setFulfillerAddress(carol, true, { from: admin })

    await fulfillMintAndValidate(
      [requestId],
      undefined,
      [timeDelayFee],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      alice,
    )

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate(
      [requestId2],
      undefined,
      [timeDelayFee2],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      carol,
    )
  })

  it('sets whitelisted addresses properly', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setFulfillerAddress(alice, true, { from: admin })

    await fulfillMintAndValidate(
      [requestId],
      undefined,
      [timeDelayFee],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      alice,
    )

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)
    await this.requestFulfiller['1'].setFulfillerAddress(alice, false, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: alice }), 'Not allowed')
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setFulfillerAddress(carol, true, { from: admin })

    await fulfillMintAndValidate(
      [requestId2],
      undefined,
      [timeDelayFee2],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      carol,
    )
  })

  it.skip('sets vol token properly', async () => {})

  it('sets whitelist enabled properly', async () => {
    await depositAndValidate(this.state, toBN(50000, 6), bob)

    const { requestId, timeDelayFee } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })
    await this.requestFulfiller['1'].setFulfillerAddress(alice, true, { from: admin })

    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await this.requestFulfiller['1'].setEnableWhitelist(false, { from: admin })

    await fulfillMintAndValidate(
      [requestId],
      undefined,
      [timeDelayFee],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      carol,
    )

    const { requestId: requestId2, timeDelayFee: timeDelayFee2 } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
      true,
    )
    await time.increase(SECONDS_PER_HOUR)

    await this.requestFulfiller['1'].setEnableWhitelist(true, { from: admin })
    await expectRevert(this.requestFulfiller['1'].performUpkeep(0, { from: carol }), 'Not allowed')

    await fulfillMintAndValidate(
      [requestId2],
      undefined,
      [timeDelayFee2],
      [bob],
      1,
      false,
      false,
      true,
      undefined,
      [true],
      alice,
    )
  })

  it.skip('handles requests with different type submitted by same address', () => {
    // Create mint, keepers mint, burn and keepers burn requests from same address and fulfill them properly
  })
})

describe('Multi-margin VolatilityToken on same platform', () => {
  beforeEach(async () => {
    await beforeEachTokenAllMargins()
  })

  it('cannot fulfill requests with same id from one margin on a different margin', async () => {
    await depositAndValidate(this.state, toBN(40000), bob)

    const { requestId, timeDelayFee, request } = await submitAndValidate(
      MINT_REQUEST_TYPE,
      toBN(1000),
      SECONDS_PER_HOUR,
      bob,
      1,
    )

    await expectRevert.unspecified(this.volToken['2'].fulfillMintRequest(requestId, toBN(1000), false))

    const {
      requestId: requestId2,
      timeDelayFee: timeDelayFee2,
      request: request2,
    } = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), SECONDS_PER_HOUR, bob, 3)
    await expectRevert.unspecified(this.volToken['4'].fulfillMintRequest(requestId, toBN(1000), false))

    await time.increase(SECONDS_PER_HOUR)

    await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, 1)
    await fulfillMintAndValidate(requestId2, request2, timeDelayFee2, bob, 3, true)
  })

  it('holds spearate total requests amount per margin', async () => {
    for (let margin of ORACLE_MARGINS_TO_TEST) {
      await this.fakePriceProvider.setPrice(toCVI(10000))
      await testFulfillDeducesRequestsTotal(margin)
    }
  })

  it('cannot liquidate a request with same id on a different margin', async () => {
    const { requestId, request } = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000), SECONDS_PER_HOUR, bob, 1)
    await time.increase(toBN(SECONDS_PER_HOUR).add(MAX_PENALTY_TIME).add(new BN(1)))
    await expectRevert(liquidateAndValidate(requestId, request, alice, 2), 'Request id not found')
    await liquidateAndValidate(requestId, request, alice, 1)
  })

  it('allows multi mint and burn on all margins concurrently properly', async () => {
    await depositAndValidate(this.state, toBN(400000), bob)

    const requests = []

    for (let margin of ORACLE_MARGINS_TO_TEST) {
      const result = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(1000 + margin),
        SECONDS_PER_HOUR,
        accountsUsed[margin % accountsUsed.length],
        margin,
      )
      requests[margin] = result
    }

    await time.increase(SECONDS_PER_HOUR)

    for (let margin of ORACLE_MARGINS_TO_TEST) {
      await fulfillMintAndValidate(
        requests[margin].requestId,
        requests[margin].request,
        requests[margin].timeDelayFee,
        accountsUsed[margin % accountsUsed.length],
        margin,
        margin % 2 === 0,
      )
    }

    for (let margin of ORACLE_MARGINS_TO_TEST) {
      const tokensAmount = await this.volToken[margin.toString()].balanceOf(accountsUsed[margin % accountsUsed.length])
      const result = await submitAndValidate(
        BURN_REQUEST_TYPE,
        tokensAmount,
        SECONDS_PER_HOUR,
        accountsUsed[margin % accountsUsed.length],
        margin,
      )
      requests[margin] = result
    }

    await time.increase(SECONDS_PER_HOUR)

    for (let margin of ORACLE_MARGINS_TO_TEST) {
      await fulfillBurnAndValidate(
        requests[margin].requestId,
        requests[margin].request,
        requests[margin].timeDelayFee,
        accountsUsed[margin % accountsUsed.length],
        margin,
      )
    }
  })

  it('allows submitting and fulfilling requests on multiple margins by same address', async () => {
    await depositAndValidate(this.state, toBN(400000), bob)

    const requests = []

    for (let margin of ORACLE_MARGINS_TO_TEST) {
      const result = await submitAndValidate(MINT_REQUEST_TYPE, toBN(1000 + margin), SECONDS_PER_HOUR, bob, margin)
      requests[margin] = result
    }

    await time.increase(SECONDS_PER_HOUR)

    for (let margin of ORACLE_MARGINS_TO_TEST) {
      await fulfillMintAndValidate(
        requests[margin].requestId,
        requests[margin].request,
        requests[margin].timeDelayFee,
        bob,
        margin,
        margin % 2 === 0,
      )
    }
  })

  it.skip('rebases times margin on maringed tokens compared to non-margined token after same funding fees on a set amount of time', async () => {
    // NOTE: Make sure this answers businses test (cross leverage): bob mints x of margin 1, alice mints x of margin 3, cvi is 60, a day passes, burning + position balance is down by 2.5% for bob and 7.5% for alice, and rebasing is down by same percentage
    // NOTE: Make sure underlying balance is saved in request (after making sure to save scalingFactor and have a rebaseAndValidate function)

    await this.fakePriceProvider.setPrice(toCVI(5000))
    await depositAndValidate(this.state, toBN(50000, 6).mul(new BN(6)), bob)

    // Mint on same time for all margins

    const margins = [1, 2, 3]
    for (let margin of margins) {
      await this.volToken[margin.toString()].setRebaser(admin, { from: admin })
      await this.volToken[margin.toString()].setCappedRebase(false, { from: admin })
    }

    const requestResults = []
    for (let margin of margins) {
      requestResults[margin.toString()] = await submitAndValidate(
        MINT_REQUEST_TYPE,
        toBN(2000, 6),
        SECONDS_PER_HOUR,
        bob,
        margin,
      )
    }

    await time.increase(SECONDS_PER_HOUR)

    for (let margin of margins) {
      const { requestId, timeDelayFee, request } = requestResults[margin.toString()]
      await fulfillMintAndValidate(requestId, request, timeDelayFee, bob, margin, false, false)
    }

    // First rebase on all margins
    for (let margin of margins) {
      await this.volToken[margin.toString()].rebaseCVI({ from: admin })
      this.state[margin.toString()].volTokenSupply = await this.volToken[margin.toString()].totalSupply()
    }

    // Gather funding fees
    await time.increase(SECONDS_PER_DAY.sub(toBN(SECONDS_PER_HOUR * 3)))

    for (let margin of margins) {
      let volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      requestResults[margin.toString()] = await submitAndValidate(
        BURN_REQUEST_TYPE,
        volTokens,
        3 * SECONDS_PER_HOUR,
        bob,
        margin,
      )
      volTokens = await this.volToken[margin.toString()].balanceOf(bob)
    }

    await time.increase(SECONDS_PER_HOUR * 3)

    const priceBeforeRebase = await getTokenPrice(1)
    const price2BeforeRebase = await getTokenPrice(2)
    const price3BeforeRebase = await getTokenPrice(3)

    // Rebase for each expected deviation (10%+, 20%+, 30%+)
    for (let margin of margins) {
      await this.volToken[margin.toString()].rebaseCVI({ from: admin })
      this.state[margin.toString()].volTokenSupply = await this.volToken[margin.toString()].totalSupply()
    }

    // Get balance again
    const priceAfterRebase = await getTokenPrice(1)
    const price2AfterRebase = await getTokenPrice(2)
    const price3AfterRebase = await getTokenPrice(3)

    // Burn and save amounts
    for (let margin of margins) {
      const { requestId, timeDelayFee, request } = requestResults[margin.toString()]
      const volTokens = await this.volToken[margin.toString()].balanceOf(bob)
      const beforeTokens = await this.token.balanceOf(bob)
      const tokensReceived = await fulfillBurnAndValidate(requestId, request, timeDelayFee, bob, margin)
      const afterTokens = await this.token.balanceOf(bob)
    }

    expect(priceAfterRebase).to.be.bignumber.at.most(toBN(50, 6))
    expect(price2AfterRebase).to.be.bignumber.at.most(toBN(50, 6))
    expect(price3AfterRebase).to.be.bignumber.at.most(toBN(50, 6))

    expect(priceAfterRebase).to.be.bignumber.at.least(toBN(49, 6).sub(toBN(1000)))
    expect(price2AfterRebase).to.be.bignumber.at.least(toBN(49, 6).sub(toBN(1000)))
    expect(price3AfterRebase).to.be.bignumber.at.least(toBN(49, 6).sub(toBN(1000)))

    expect(priceBeforeRebase.mul(toBN(10000)).div(priceAfterRebase)).to.be.bignumber.at.most(toBN(9000))
    expect(priceBeforeRebase.mul(toBN(10000)).div(priceAfterRebase)).to.be.bignumber.at.least(toBN(8999))

    expect(price2BeforeRebase.mul(toBN(10000)).div(price2AfterRebase)).to.be.bignumber.at.most(toBN(8000))
    expect(price2BeforeRebase.mul(toBN(10000)).div(price2AfterRebase)).to.be.bignumber.at.least(toBN(7999))

    expect(price3BeforeRebase.mul(toBN(10000)).div(price3AfterRebase)).to.be.bignumber.at.most(toBN(7000))
    expect(price3BeforeRebase.mul(toBN(10000)).div(price3AfterRebase)).to.be.bignumber.at.least(toBN(6999))
  })
})
