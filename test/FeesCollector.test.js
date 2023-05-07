/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, time, BN, balance, send, ether } = require('@openzeppelin/test-helpers')
const chai = require('chai')

const { toTokenAmount, toBN, toUSD } = require('./utils/BNUtils.js')
const { getAccounts, ZERO_ADDRESS, MAX_UINT256 } = require('./utils/DeployUtils.js')

const FeesCollector = artifacts.require('FeesCollector')
const FakeFeesCollector = artifacts.require('FakeFeesCollector')
const FakeERC20 = artifacts.require('FakeERC20')
const FakeWETH = artifacts.require('FakeWETH')
const FakeExchange = artifacts.require('FakeExchange')
const FakeArbitrumInbox = artifacts.require('FakeArbitrumInbox')
const FakePriceProvider = artifacts.require('FakePriceProvider')

const expect = chai.expect

const TO_WETH_RATE = toBN(1, 8)
const TO_GOVI_RATE = toBN(1, 6)
const GOVI_PRICE = toBN(100, 18) // By GOVI Rate of 1 ETH => 100 GOVI

const CONVERSION_PRECISION_DECIMALS = toBN(1, 4)
const USDC_TO_ETH_MULTIPLY = TO_WETH_RATE.div(CONVERSION_PRECISION_DECIMALS)
const ETH_TO_GOVI_MULTIPLY = TO_GOVI_RATE.div(CONVERSION_PRECISION_DECIMALS)
const SUBMISSION_COST = ether('0.001')
const SEND_PERCENTAGE = toBN(2000)
const TREASURY_PERCENTAGE = toBN(1500)
const MAX_PERCENTAGE = toBN(10000)

let admin, bob, alice, carol, fundsSender, treasury

const setAccounts = async () => {
  ;[admin, bob, alice, carol, fundsSender, treasury] = await getAccounts()
}

const beforeEachFeesCollector = async (sendToArbitrum, convertUSDC, buyBack, useNative) => {
  await setAccounts()

  this.wethToken = await FakeWETH.new('WETH', 'WETH', toTokenAmount(1000000000000000), 18, { from: admin })
  this.goviToken = await FakeERC20.new('GOVI', 'GOVI', toTokenAmount(1000000000000000), 18, { from: admin })
  this.usdcToken = await FakeERC20.new('USDC', 'USDC', toTokenAmount(1000000000), 6, { from: admin })
  this.arbitrumCollector = await FakeFeesCollector.new({ from: admin })
  this.staking = await FakeFeesCollector.new({ from: admin })
  this.stakingVault = await FakeFeesCollector.new({ from: admin })

  this.fakeExchange = await FakeExchange.new(this.wethToken.address, { from: admin })
  this.fakeExchange.setExchangeRate(TO_WETH_RATE, await this.fakeExchange.WETH())
  this.fakeExchange.setExchangeRate(TO_GOVI_RATE, this.goviToken.address)
  this.wethToken.transfer(this.fakeExchange.address, toTokenAmount(1000000000), { from: admin })
  this.goviToken.transfer(this.fakeExchange.address, toTokenAmount(1000000000), { from: admin })
  await send.ether(admin, this.wethToken.address, ether('1000'))

  this.fakeInbox = await FakeArbitrumInbox.new({ from: admin })

  this.fakePriceProvider = await FakePriceProvider.new(ether('0.00000001'), { from: admin })

  this.feesCollector = await FeesCollector.new({ from: admin })
  await this.feesCollector.initialize(
    this.usdcToken.address,
    this.goviToken.address,
    this.staking.address,
    this.stakingVault.address,
    this.arbitrumCollector.address,
    this.fakeExchange.address,
    this.fakePriceProvider.address,
    this.fakeInbox.address,
    treasury,
    this.wethToken.address,
    { from: admin },
  )

  await this.feesCollector.setAllowedSenderAddress(fundsSender, true, { from: admin })
  await this.feesCollector.setFundsSender(fundsSender, { from: admin })

  await this.feesCollector.setSendToArbitrum(sendToArbitrum, { from: admin })
  await this.feesCollector.setBuyBack(buyBack, { from: admin })
  await this.feesCollector.setConvertUSDC(convertUSDC, { from: admin })
  await this.feesCollector.setUseNative(useNative, { from: admin })
}

const sendProfitAndValidate = async (account, amount) => {
  const beforeSendBalance = await this.usdcToken.balanceOf(this.feesCollector.address)
  await this.usdcToken.transfer(account, amount, { from: admin })
  await this.usdcToken.approve(this.feesCollector.address, amount, { from: account })
  await this.feesCollector.sendProfit(amount, this.usdcToken.address, { from: account })
  const afterSendBalance = await this.usdcToken.balanceOf(this.feesCollector.address)
  expect(afterSendBalance.sub(beforeSendBalance)).to.be.bignumber.equal(amount)
}

const verifyUpkeepState = async canUpkeep => {
  const result = await this.feesCollector.checkUpkeep(0)
  expect(result.upkeepNeeded).to.be.equal(canUpkeep)

  if (!canUpkeep) {
    await expectRevert(this.feesCollector.performUpkeep(0, { from: fundsSender }), 'Not enough funds')
    await expectRevert(this.feesCollector.sendFunds(0, { from: fundsSender }), 'Not enough funds')
  } else {
    await this.feesCollector.performUpkeep(0, { from: fundsSender })
  }
}

const sendFundsAndVerify = async (
  amount,
  usePerformKeep,
  leftUSDC = toBN(0),
  account = fundsSender,
  collector = this.arbitrumCollector.address,
) => {
  const collectorBalanceBefore = await balance.current(collector)

  if (usePerformKeep) {
    await this.feesCollector.performUpkeep(0, { from: account })
  } else {
    await this.feesCollector.sendFunds(0, { from: account })
  }

  const collectorBalanceAfter = await balance.current(collector)

  expect(collectorBalanceAfter.sub(collectorBalanceBefore)).to.be.bignumber.equal(amount.sub(SUBMISSION_COST))
  expect(await balance.current(this.feesCollector.address)).to.be.bignumber.equal(toBN(0))
  expect(await this.usdcToken.balanceOf(this.feesCollector.address)).to.be.bignumber.equal(leftUSDC)
}

const sendFundsToStakingAndVerify = async (
  amount,
  leftUSDC = toBN(0),
  account = fundsSender,
  collector = this.staking.address,
) => {
  const { treasuryAmount, sentAmount, leftAmount } = splitToTreasury(amount)

  const treasuryBalanceBefore = await balance.current(treasury)
  const collectorBalanceBefore = await this.wethToken.balanceOf(collector)
  await this.feesCollector.sendFunds(0, { from: account })
  const collectorBalanceAfter = await this.wethToken.balanceOf(collector)
  const treasuryBalanceAfter = await balance.current(treasury)

  expect(collectorBalanceAfter.sub(collectorBalanceBefore)).to.be.bignumber.equal(sentAmount)
  expect(treasuryBalanceAfter.sub(treasuryBalanceBefore)).to.be.bignumber.equal(treasuryAmount)
  expect(await balance.current(this.feesCollector.address)).to.be.bignumber.equal(leftAmount)
  expect(await this.usdcToken.balanceOf(this.feesCollector.address)).to.be.bignumber.equal(leftUSDC)
}

const sendFundsWithBuybackAndVefify = async (
  ethAmount,
  goviPrice,
  leftUSDC = toBN(0),
  slippage = MAX_PERCENTAGE,
  sendPercentage = SEND_PERCENTAGE,
  account = fundsSender,
  collector = this.stakingVault.address,
) => {
  const { treasuryAmount, sentAmount, leftAmount } = splitToTreasury(ethAmount, sendPercentage)

  const treasuryBalanceBefore = await balance.current(treasury)
  const collectorBalanceBefore = await this.goviToken.balanceOf(collector)
  await this.feesCollector.sendFunds(goviPrice, { from: account })
  const collectorBalanceAfter = await this.goviToken.balanceOf(collector)
  const treasuryBalanceAfter = await balance.current(treasury)

  expect(collectorBalanceAfter.sub(collectorBalanceBefore)).to.be.bignumber.equal(
    sentAmount.mul(ETH_TO_GOVI_MULTIPLY).mul(slippage).div(MAX_PERCENTAGE),
  )
  expect(treasuryBalanceAfter.sub(treasuryBalanceBefore)).to.be.bignumber.equal(treasuryAmount)
  expect(await balance.current(this.feesCollector.address)).to.be.bignumber.equal(leftAmount)
  expect(await this.usdcToken.balanceOf(this.feesCollector.address)).to.be.bignumber.equal(leftUSDC)
}

const testStandardFundsSend = async usePerformKeep => {
  await send.ether(admin, this.feesCollector.address, ether('0.3'))
  await sendProfitAndValidate(bob, ether('0.2').div(USDC_TO_ETH_MULTIPLY))

  await sendFundsAndVerify(ether('0.5'), usePerformKeep)
}

const testSettingTargetAddress = async hasSubmissionCost => {
  const oldArbitrumCollector = this.arbitrumCollector
  this.arbitrumCollector = await FakeFeesCollector.new({ from: admin })
  expect(oldArbitrumCollector.address).to.not.be.equal(this.arbitrumCollector.address)

  expect(await this.feesCollector.arbitrumContractAddress()).to.equal(oldArbitrumCollector.address)
  await this.feesCollector.setArbitrumContractAddress(this.arbitrumCollector.address, { from: admin })
  expect(await this.feesCollector.arbitrumContractAddress()).to.equal(this.arbitrumCollector.address)

  const beforeOldContractBalance = await balance.current(oldArbitrumCollector.address)

  await send.ether(admin, this.feesCollector.address, ether('0.3'))
  await sendFundsAndVerify(ether('0.3').add(hasSubmissionCost ? toBN(0) : SUBMISSION_COST), true)

  const afterOldContractBalance = await balance.current(oldArbitrumCollector.address)
  expect(afterOldContractBalance).to.be.bignumber.equal(beforeOldContractBalance)
}

const splitToTreasury = (amount, sendPercentage = SEND_PERCENTAGE) => {
  const usedAmount = amount.mul(sendPercentage).div(MAX_PERCENTAGE)
  const treasuryAmount = usedAmount.mul(TREASURY_PERCENTAGE).div(MAX_PERCENTAGE)
  const sentAmount = usedAmount.sub(treasuryAmount)
  const leftAmount = amount.sub(usedAmount)

  return { usedAmount, treasuryAmount, sentAmount, leftAmount }
}

const sendFunds = async (sendToArbitrum, isBuyBack) => {
  if (sendToArbitrum) {
    await this.feesCollector.performUpkeep(0, { from: fundsSender })
  } else if (!isBuyBack) {
    await this.feesCollector.sendFunds(0, { from: fundsSender })
  } else {
    await this.feesCollector.sendFunds(GOVI_PRICE, { from: fundsSender })
  }
}

const setFeesCollectorTests = (sendToArbitrum, singleContract, buyBackOnly) => {
  it('can receive eth without reverting', async () => {
    send.ether(admin, this.feesCollector.address, ether('1'))
  })

  if (buyBackOnly) {
    it('reverts when sending any profit', async () => {
      await expectRevert(
        this.feesCollector.sendProfit(toTokenAmount(1), this.wethToken.address, { from: admin }),
        'Not allowed',
      )
      await expectRevert(
        this.feesCollector.sendProfit(toTokenAmount(1), this.usdcToken.address, { from: admin }),
        'Not allowed',
      )
    })
  } else {
    it('reverts when sending non-usdc profit', async () => {
      await expectRevert(
        this.feesCollector.sendProfit(toTokenAmount(1), this.wethToken.address, { from: admin }),
        'Non-USDC profit',
      )
    })

    it('transfers correct amount when sending usdc profit', async () => {
      expect(await this.usdcToken.balanceOf(this.feesCollector.address)).to.be.bignumber.equal(toBN(0))
      await sendProfitAndValidate(bob, toUSD(1000))
    })
  }

  if (!sendToArbitrum) {
    it('reverts when performing upkeep and sendToArbitrum is true', async () => {
      await expectRevert(this.feesCollector.performUpkeep(0, { from: fundsSender }), 'Not allowed')
    })
  } else {
    it('checks if upkeep is needed properly when only ETH in contract', async () => {
      await verifyUpkeepState(false)
      await send.ether(admin, this.feesCollector.address, ether('0.29'))
      await verifyUpkeepState(false)
      await send.ether(admin, this.feesCollector.address, ether('0.01'))
      await verifyUpkeepState(true)
      await verifyUpkeepState(false)
    })

    it('checks if upkeep is needed properly when USDC is below minimum', async () => {
      await verifyUpkeepState(false)
      await sendProfitAndValidate(bob, toUSD(1499))
      await verifyUpkeepState(false)
      await send.ether(admin, this.feesCollector.address, ether('0.29'))
      await verifyUpkeepState(false)
      await send.ether(admin, this.feesCollector.address, ether('0.01'))
      await verifyUpkeepState(true)
      await verifyUpkeepState(false)
    })

    it('checks if upkeep is needed properly when USDC is above minimum, worth min ETH needed', async () => {
      await verifyUpkeepState(false)
      await sendProfitAndValidate(bob, toUSD(1499))
      await verifyUpkeepState(false)
      await sendProfitAndValidate(bob, toUSD(1))
      await verifyUpkeepState(false)
      await sendProfitAndValidate(
        bob,
        ether('0.3').sub(toUSD(1500).mul(USDC_TO_ETH_MULTIPLY)).div(USDC_TO_ETH_MULTIPLY).sub(toUSD(1)),
      )
      await verifyUpkeepState(false)
      await sendProfitAndValidate(bob, toUSD(1))
      await verifyUpkeepState(true)
      await verifyUpkeepState(false)
    })

    it('checks if upkeep is needed properly when USDC is above minimum, worth less than min ETH needed', async () => {
      await verifyUpkeepState(false)
      await sendProfitAndValidate(bob, toUSD(1499))
      await verifyUpkeepState(false)
      await sendProfitAndValidate(bob, toUSD(1))
      await verifyUpkeepState(false)
      await sendProfitAndValidate(
        bob,
        ether('0.2').sub(toUSD(1500).mul(USDC_TO_ETH_MULTIPLY)).div(USDC_TO_ETH_MULTIPLY),
      )
      await verifyUpkeepState(false)
      await send.ether(admin, this.feesCollector.address, ether('0.09'))
      await verifyUpkeepState(false)
      await send.ether(admin, this.feesCollector.address, ether('0.01'))
      await verifyUpkeepState(true)
      await verifyUpkeepState(false)
    })

    it('reverts when a non-whitelisted address attempts to upkeep', async () => {
      await expectRevert(this.feesCollector.performUpkeep(0, { from: bob }), 'Not allowed')
      await expectRevert(this.feesCollector.performUpkeep(0, { from: admin }), 'Not allowed')
    })

    it('does not revert when a non-whitelisted address attempts to upkeep and whitelist is disabled', async () => {
      await expectRevert(this.feesCollector.performUpkeep(0, { from: bob }), 'Not allowed')
      await this.feesCollector.setEnableWhitelist(false)
      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      await this.feesCollector.performUpkeep(0, { from: bob })
    })
  }

  it('reverts when trying to send funds not by fundsSender', async () => {
    await send.ether(admin, this.feesCollector.address, ether('0.3'))
    await this.feesCollector.setFundsSender(bob, { from: admin })
    await expectRevert(this.feesCollector.sendFunds(0, { from: alice }), 'Not allowed')
    await this.feesCollector.sendFunds(0, { from: bob })
  })

  it('reverts when trying to send funds and fundsSender address is zero', async () => {
    await this.feesCollector.setFundsSender(ZERO_ADDRESS, { from: admin })
    await expectRevert(this.feesCollector.sendFunds(0, { from: admin }), 'Not allowed')
  })

  if (sendToArbitrum) {
    it('converts usdc to eth properly and sends it to arbitrum contract through sendFunds function', async () => {
      await testStandardFundsSend(true)
    })

    it('converts usdc to eth properly and sends it to arbitrum contract through performUpkeep', async () => {
      await testStandardFundsSend(false)
    })
  } else if (singleContract) {
    it('converts usdc to eth properly and sends it to staking contract as eth', async () => {
      await this.feesCollector.setBuyBack(false, { from: admin })

      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      await sendProfitAndValidate(bob, ether('0.2').div(USDC_TO_ETH_MULTIPLY))

      await sendFundsToStakingAndVerify(ether('0.5'))
    })

    it('converts usdc to eth properly and sends it to staking vault after govi conversion', async () => {
      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      await sendProfitAndValidate(bob, ether('0.2').div(USDC_TO_ETH_MULTIPLY))

      await sendFundsWithBuybackAndVefify(ether('0.5'), GOVI_PRICE)
    })
  } else if (buyBackOnly) {
    it('converts eth to govi and sends it to target contract if buy back is enabled', async () => {
      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      await sendFundsWithBuybackAndVefify(ether('0.3'), GOVI_PRICE)
    })

    it('sends eth to target contract if buy back is disabled', async () => {
      await this.feesCollector.setBuyBack(false, { from: admin })
      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      await sendFundsToStakingAndVerify(ether('0.3'))
    })
  }

  if (sendToArbitrum) {
    it('does not convert usdc to eth when min not accumulated, but sends the eth that was gathered to arbitrum', async () => {
      await sendProfitAndValidate(alice, toUSD(1499))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await sendFundsAndVerify(ether('0.3'), true, toUSD(1499))
    })
  } else if (singleContract) {
    it('does not convert usdc to eth when min not accumulated, but sends the eth that was gathered to staking contract', async () => {
      await this.feesCollector.setBuyBack(false, { from: admin })
      await sendProfitAndValidate(alice, toUSD(1499))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await sendFundsToStakingAndVerify(ether('0.3'), toUSD(1499))
    })

    it('does not convert usdc to eth when min not accumulated, but converts the eth that was gathered to govi and sends to staking vault', async () => {
      await sendProfitAndValidate(alice, toUSD(1499))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await sendFundsWithBuybackAndVefify(ether('0.3'), GOVI_PRICE, toUSD(1499))
    })
  }

  if (sendToArbitrum) {
    it('converts usdc to eth when min to convert was accumulated', async () => {
      await sendProfitAndValidate(alice, toUSD(1500))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await sendFundsAndVerify(ether('0.3').add(toUSD(1500).mul(USDC_TO_ETH_MULTIPLY)), true)
    })
  } else if (singleContract) {
    it('converts usdc to eth when min to convert was accumulated (buy back disabled)', async () => {
      await this.feesCollector.setBuyBack(false, { from: admin })
      await sendProfitAndValidate(alice, toUSD(1500))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await sendFundsToStakingAndVerify(ether('0.3').add(toUSD(1500).mul(USDC_TO_ETH_MULTIPLY)))
    })

    it('converts usdc to eth when min to convert was accumulated (buy back enabled)', async () => {
      await sendProfitAndValidate(alice, toUSD(1500))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await sendFundsWithBuybackAndVefify(ether('0.3').add(toUSD(1500).mul(USDC_TO_ETH_MULTIPLY)), GOVI_PRICE)
    })
  }

  if (sendToArbitrum || singleContract) {
    it('reverts when oracle price is zero or negative', async () => {
      await sendProfitAndValidate(bob, toUSD(2000))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      await this.fakePriceProvider.setPrice(toBN(0))
      await expectRevert(sendFunds(sendToArbitrum, true), 'Price not positive')
      await this.fakePriceProvider.setPrice(toBN(-1))
      await expectRevert(sendFunds(sendToArbitrum, true), 'Price not positive')
      await this.fakePriceProvider.setPrice(toBN(1))
      await sendFunds(sendToArbitrum, true)
    })
  }

  if (sendToArbitrum || singleContract) {
    it('reverts when slippage is too high for usdc to eth conversion', async () => {
      await this.fakeExchange.setSlippagePercent(toBN(101), await this.fakeExchange.WETH()) // >1% is lost
      await this.feesCollector.setMaxSlippage(toBN(100))

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))
      await expectRevert(sendFunds(sendToArbitrum, true), 'Fake Uniswap: output below min')
    })

    it('does not revert when slippage is equalized in usdc to eth conversion', async () => {
      await this.fakeExchange.setSlippagePercent(toBN(100), await this.fakeExchange.WETH()) // 1% is lost
      await this.feesCollector.setMaxSlippage(toBN(100))

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))

      if (sendToArbitrum) {
        await sendFundsAndVerify(
          ether('0.5')
            .mul(MAX_PERCENTAGE.sub(toBN(100)))
            .div(MAX_PERCENTAGE),
          true,
        )
      } else {
        await sendFundsWithBuybackAndVefify(
          ether('0.5')
            .mul(MAX_PERCENTAGE.sub(toBN(100)))
            .div(MAX_PERCENTAGE),
          GOVI_PRICE,
        )
      }
    })

    it('does not revert when slippage is lower than max in usdc to eth conversion', async () => {
      await this.fakeExchange.setSlippagePercent(toBN(99), await this.fakeExchange.WETH()) // <1% is lost
      await this.feesCollector.setMaxSlippage(toBN(100))

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))

      if (sendToArbitrum) {
        await sendFundsAndVerify(
          ether('0.5')
            .mul(MAX_PERCENTAGE.sub(toBN(99)))
            .div(MAX_PERCENTAGE),
          true,
        )
      } else {
        await sendFundsWithBuybackAndVefify(
          ether('0.5')
            .mul(MAX_PERCENTAGE.sub(toBN(99)))
            .div(MAX_PERCENTAGE),
          GOVI_PRICE,
        )
      }
    })
  }

  it.skip('reverts when no funds to send', async () => {})

  if (buyBackOnly || singleContract) {
    it('reverts when slippage is too high for eth to govi conversion', async () => {
      await this.fakeExchange.setSlippagePercent(toBN(101), this.goviToken.address) // >1% is lost
      await this.feesCollector.setMaxSlippage(toBN(100))

      if (singleContract) {
        await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))
      } else {
        await send.ether(admin, this.feesCollector.address, ether('0.5'))
      }

      await expectRevert(sendFundsWithBuybackAndVefify(ether('0.5'), GOVI_PRICE), 'Fake Uniswap: output below min')
    })

    it('does not revert when slippage is equalized in eth to govi conversion', async () => {
      await this.fakeExchange.setSlippagePercent(toBN(100), this.goviToken.address) // 1% is lost
      await this.feesCollector.setMaxSlippage(toBN(100))

      if (singleContract) {
        await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))
      } else {
        await send.ether(admin, this.feesCollector.address, ether('0.5'))
      }

      await sendFundsWithBuybackAndVefify(ether('0.5'), GOVI_PRICE, undefined, MAX_PERCENTAGE.sub(toBN(100)))
    })

    it('does not revert when slippage is lower than max in eth to govi conversion', async () => {
      await this.fakeExchange.setSlippagePercent(toBN(99), this.goviToken.address) // <1% is lost
      await this.feesCollector.setMaxSlippage(toBN(100))

      if (singleContract) {
        await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))
      } else {
        await send.ether(admin, this.feesCollector.address, ether('0.5'))
      }

      await sendFundsWithBuybackAndVefify(ether('0.5'), GOVI_PRICE, undefined, MAX_PERCENTAGE.sub(toBN(99)))
    })

    it.skip('transfers funds properly when slippage occurs in both usdc to eth and eth to govi conversion, within limits', async () => {})
  }

  it('reverts when using setters not by owner', async () => {
    await expectRevert(
      this.feesCollector.setUSDCETHPriceAggregator(ZERO_ADDRESS, { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(this.feesCollector.setRouter(ZERO_ADDRESS, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.feesCollector.setStaking(ZERO_ADDRESS, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(
      this.feesCollector.setStakingVaultAddress(ZERO_ADDRESS, { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(
      this.feesCollector.setArbitrumContractAddress(ZERO_ADDRESS, { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(
      this.feesCollector.setArbitrumInbox(ZERO_ADDRESS, { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(
      this.feesCollector.setTreasuryAddress(ZERO_ADDRESS, { from: bob }),
      'Ownable: caller is not the owner',
    )

    await expectRevert(
      this.feesCollector.setTreasuryTransferPercentage(1000, { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(this.feesCollector.setSendPercentage(1000, { from: bob }), 'Ownable: caller is not the owner')

    await expectRevert(this.feesCollector.setUseNative(true, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(
      this.feesCollector.setWrappedToken(ZERO_ADDRESS, { from: bob }),
      'Ownable: caller is not the owner',
    )

    await expectRevert(
      this.feesCollector.setMinETHForTransfer(ether('0.1'), { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(
      this.feesCollector.setMinUDSCForConversion(toUSD(1000), { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(
      this.feesCollector.setMaxSubmissionFee(ether('0.01'), { from: bob }),
      'Ownable: caller is not the owner',
    )
    await expectRevert(this.feesCollector.setMaxSlippage(toBN(200), { from: bob }), 'Ownable: caller is not the owner')

    await expectRevert(this.feesCollector.setSendToArbitrum(false, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.feesCollector.setConvertUSDC(false, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.feesCollector.setBuyBack(false, { from: bob }), 'Ownable: caller is not the owner')

    await expectRevert(this.feesCollector.setFundsSender(alice, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(this.feesCollector.setEnableWhitelist(false, { from: bob }), 'Ownable: caller is not the owner')
    await expectRevert(
      this.feesCollector.setAllowedSenderAddress(alice, true, { from: bob }),
      'Ownable: caller is not the owner',
    )
  })

  if (sendToArbitrum || singleContract) {
    it('sets price oracle properly', async () => {
      // Send entire amount for ease of testing
      await this.feesCollector.setSendPercentage(MAX_PERCENTAGE, { from: admin })

      expect(await this.feesCollector.usdcETHPriceAggregator()).to.equal(this.fakePriceProvider.address)

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))

      if (sendToArbitrum) {
        await sendFundsAndVerify(ether('0.5'), true) // Shows the price used is the updated one, as you get more eth for less USDC, and exchange still works (no slippage)
      } else {
        await sendFundsWithBuybackAndVefify(ether('0.5'), GOVI_PRICE, undefined, undefined, MAX_PERCENTAGE)
      }

      const secondFakePriceProvider = await FakePriceProvider.new(ether('0.0000001'), { from: admin })
      await this.feesCollector.setUSDCETHPriceAggregator(secondFakePriceProvider.address, { from: admin })
      expect(await this.feesCollector.usdcETHPriceAggregator()).to.equal(secondFakePriceProvider.address)

      await this.fakeExchange.setExchangeRate(TO_WETH_RATE.mul(toBN(10)), await this.fakeExchange.WETH(), {
        from: admin,
      })

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY.mul(toBN(10))))

      if (sendToArbitrum) {
        await sendFundsAndVerify(ether('0.5'), true) // Shows the price used is the updated one, as you get more eth for less USDC, and exchange still works (no slippage)
      } else {
        await sendFundsWithBuybackAndVefify(ether('0.5'), GOVI_PRICE, undefined, undefined, MAX_PERCENTAGE)
      }
    })
  }

  it.skip('sets uniswap router properly', async () => {
    // Complete for all cases (including buyback ones...)

    const newRouter = await FakeExchange.new(this.wethToken.address, { from: admin })
    newRouter.setExchangeRate(TO_WETH_RATE, await newRouter.WETH(), { from: admin })
    this.wethToken.transfer(newRouter.address, toTokenAmount(1000000000), { from: admin })

    expect(await this.usdcToken.allowance(this.feesCollector.address, this.fakeExchange.address)).to.be.bignumber.equal(
      MAX_UINT256,
    )

    expect(await this.feesCollector.router()).to.equal(this.fakeExchange.address)
    await this.feesCollector.setRouter(newRouter.address)
    expect(await this.feesCollector.router()).to.equal(newRouter.address)

    expect(await this.usdcToken.allowance(this.feesCollector.address, this.fakeExchange.address)).to.be.bignumber.equal(
      toBN(0),
    )
    expect(await this.usdcToken.allowance(this.feesCollector.address, newRouter.address)).to.be.bignumber.equal(
      MAX_UINT256,
    )

    const oldRouterBeforeBalance = await this.wethToken.balanceOf(this.fakeExchange.address)
    const newRouterBeforeBalance = await this.wethToken.balanceOf(newRouter.address)

    await sendProfitAndValidate(bob, ether('0.3').div(USDC_TO_ETH_MULTIPLY))
    await sendFundsAndVerify(ether('0.3'), true)

    const oldRouterAfterBalance = await this.wethToken.balanceOf(this.fakeExchange.address)
    const newRouterAfterBalance = await this.wethToken.balanceOf(newRouter.address)

    expect(oldRouterBeforeBalance).to.be.bignumber.equal(oldRouterAfterBalance)
    expect(newRouterBeforeBalance.sub(newRouterAfterBalance)).to.be.bignumber.equal(ether('0.3'))
  })

  if (sendToArbitrum) {
    it('sets arbitrum inbox properly', async () => {
      const newArbitrumInbox = await FakeArbitrumInbox.new({ from: admin })
      await newArbitrumInbox.setSubmissionCost(ether('0.002'))
      expect(await this.fakeInbox.submissionCost()).to.be.bignumber.equal(ether('0.001'))

      expect(await this.feesCollector.arbitrumInbox()).to.equal(this.fakeInbox.address)
      await this.feesCollector.setArbitrumInbox(newArbitrumInbox.address, { from: admin })
      expect(await this.feesCollector.arbitrumInbox()).to.equal(newArbitrumInbox.address)

      await sendProfitAndValidate(bob, ether('0.3').div(USDC_TO_ETH_MULTIPLY))
      await this.feesCollector.performUpkeep(0, { from: fundsSender })

      expect(await balance.current(this.arbitrumCollector.address)).to.be.bignumber.equal(
        ether('0.3').sub(ether('0.002')),
      ) // Verifies new submission was used i.e. new inbox
    })
  } else {
    it.skip('setting arbitrum inbox does not influence target staking contract', async () => {})

    it.skip('setting arbitrum inbox does not influence target staking vault', async () => {})
  }

  if (sendToArbitrum) {
    it('setting target staking and staking vault contracts does not influence target arbitrum address', async () => {
      await this.feesCollector.setStaking(alice, { from: admin })
      await this.feesCollector.setStakingVaultAddress(alice, { from: admin })
      const bobBalanceBefore = await balance.current(alice)
      await testStandardFundsSend(true)
      const bobBalanceAfter = await balance.current(alice)

      expect(bobBalanceBefore).to.be.bignumber.equal(bobBalanceAfter)
    })
  } else {
    it.skip('sets target staking contract properly', async () => {})

    it.skip('sets target staking vault contract properly', async () => {})

    it.skip('setting target staking vault contract does not influence staking contract', async () => {})

    it.skip('setting target staking contract does not influence staking vault contract', async () => {})

    it.skip('setting arbitrum target address does not influence staking contract', async () => {})

    it.skip('setting arbitrum target address does not influence staking vault contract', async () => {})
  }

  if (sendToArbitrum) {
    it('sets contract arbitrum address properly', async () => {
      await testSettingTargetAddress(true)
    })
  } else {
    it.skip('setting arbitrum contract address does not influence target staking contract', async () => {})

    it.skip('setting arbitrum contract address does not influence target staking vault', async () => {})
  }

  if (sendToArbitrum) {
    it('reverts when setting min eth amount to be less than max submission fee', async () => {
      await this.feesCollector.setMaxSubmissionFee(ether('0.01'), { from: admin })
      await expectRevert(
        this.feesCollector.setMinETHForTransfer(ether('0.009'), { from: admin }),
        'Smaller than submission fee',
      )
    })
  }

  if (sendToArbitrum) {
    it('sets min eth amount properly', async () => {
      expect(await this.feesCollector.minETHForTransfer()).to.be.bignumber.equal(ether('0.3'))
      await this.feesCollector.setMinETHForTransfer(ether('0.5'), { from: admin })
      expect(await this.feesCollector.minETHForTransfer()).to.be.bignumber.equal(ether('0.5'))

      await send.ether(admin, this.feesCollector.address, ether('0.49'))
      await expectRevert(sendFunds(sendToArbitrum, true), 'Not enough funds')
    })
  }

  if (singleContract) {
    it.skip('buyback occurs regardless to min eth', async () => {})
  }

  if (buyBackOnly) {
    it.skip('buyback occurs regardless to min eth', async () => {})
  }

  if (singleContract) {
    it.skip('converts eth in contract to govi even when no usdc conversion is done', async () => {})
  }

  if (sendToArbitrum || singleContract) {
    it('sets min usdc for conversion properly', async () => {
      expect(await this.feesCollector.minUSDCForConversion()).to.be.bignumber.equal(toUSD(1500))
      await this.feesCollector.setMinUDSCForConversion(toUSD(1000), { from: admin })
      expect(await this.feesCollector.minUSDCForConversion()).to.be.bignumber.equal(toUSD(1000))

      await sendProfitAndValidate(bob, toUSD(1000))
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      if (sendToArbitrum) {
        await sendFundsAndVerify(ether('0.3').add(toUSD(1000).mul(USDC_TO_ETH_MULTIPLY)), true)
      } else {
        await sendFundsWithBuybackAndVefify(ether('0.3').add(toUSD(1000).mul(USDC_TO_ETH_MULTIPLY)), GOVI_PRICE)
      }
    })
  }

  if (sendToArbitrum) {
    it('reverts when setting max submission amount to be more than min eth amount', async () => {
      await this.feesCollector.setMinETHForTransfer(ether('0.3'), { from: admin })
      await expectRevert(
        this.feesCollector.setMaxSubmissionFee(ether('0.4'), { from: admin }),
        'Larger than min transfer ETH',
      )
    })

    it('sets max submission fee properly', async () => {
      expect(await this.feesCollector.maxSubmissionFee()).to.be.bignumber.equal(ether('0.1'))
      await this.feesCollector.setMaxSubmissionFee(ether('0.0001'), { from: admin })
      expect(await this.feesCollector.maxSubmissionFee()).to.be.bignumber.equal(ether('0.0001'))

      await this.feesCollector.setMinETHForTransfer(ether('0.3'), { from: admin })
      await expectRevert.unspecified(this.feesCollector.performUpkeep(0, { from: fundsSender })) // Will underflow as de-facto submission fee is less than max!
    })
  } else {
    it.skip('does not change transferred funds by max submission amount', async () => {})
  }

  if (sendToArbitrum || singleContract) {
    it('sets max slippage properly for usdc to eth conversion', async () => {
      expect(await this.feesCollector.maxSlippage()).to.be.bignumber.equal(toBN(100))

      await this.fakeExchange.setSlippagePercent(toBN(101), await this.fakeExchange.WETH())

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))
      await expectRevert(sendFunds(sendToArbitrum, true), 'Fake Uniswap: output below min')

      await this.feesCollector.setMaxSlippage(toBN(101))
      expect(await this.feesCollector.maxSlippage()).to.be.bignumber.equal(toBN(101))

      await sendFunds(sendToArbitrum, true)
    })
  }

  if (buyBackOnly || singleContract) {
    it.skip('sets max slippage properly for eth to govi conversion', async () => {
      expect(await this.feesCollector.maxSlippage()).to.be.bignumber.equal(toBN(100))

      await this.fakeExchange.setSlippagePercent(toBN(101), this.goviToken.address)

      await sendProfitAndValidate(bob, ether('0.5').div(USDC_TO_ETH_MULTIPLY))
      await expectRevert(this.feesCollector.performUpkeep(0, { from: fundsSender }), 'Fake Uniswap: output below min')

      await this.feesCollector.setMaxSlippage(toBN(101))
      expect(await this.feesCollector.maxSlippage()).to.be.bignumber.equal(toBN(101))

      await this.feesCollector.performUpkeep(0, { from: fundsSender })
    })
  }

  it('sets funds sender properly', async () => {
    await send.ether(admin, this.feesCollector.address, ether('0.3'))

    expect(await this.feesCollector.fundsSender()).to.equal(fundsSender)
    await this.feesCollector.setFundsSender(bob)
    expect(await this.feesCollector.fundsSender()).to.equal(bob)

    await expectRevert(sendFunds(false, true), 'Not allowed')

    if (sendToArbitrum) {
      await sendFundsAndVerify(ether('0.3'), false, toBN(0), bob)
    } else {
      await sendFundsWithBuybackAndVefify(ether('0.3'), GOVI_PRICE, undefined, undefined, undefined, bob)
    }
  })

  if (sendToArbitrum) {
    it('enables upkeep whitelist properly', async () => {
      await send.ether(admin, this.feesCollector.address, ether('0.3'))
      expect(await this.feesCollector.enableWhitelist()).to.be.true
      await this.feesCollector.setEnableWhitelist(false)
      expect(await this.feesCollector.enableWhitelist()).to.be.false

      await this.feesCollector.performUpkeep(0, { from: bob })

      await this.feesCollector.setEnableWhitelist(true)
      expect(await this.feesCollector.enableWhitelist()).to.be.true
      await expectRevert(this.feesCollector.performUpkeep(0, { from: bob }), 'Not allowed')
    })

    it('sets address as whitelisted/not whitelisted properly', async () => {
      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      expect(await this.feesCollector.allowedSenders(bob)).to.be.false
      expect(await this.feesCollector.allowedSenders(alice)).to.be.false

      await expectRevert(this.feesCollector.performUpkeep(0, { from: bob }), 'Not allowed')
      await expectRevert(this.feesCollector.performUpkeep(0, { from: alice }), 'Not allowed')

      await this.feesCollector.setAllowedSenderAddress(bob, true)

      expect(await this.feesCollector.allowedSenders(bob)).to.be.true
      expect(await this.feesCollector.allowedSenders(alice)).to.be.false

      await expectRevert(this.feesCollector.performUpkeep(0, { from: alice }), 'Not allowed')
      await this.feesCollector.performUpkeep(0, { from: bob })

      await send.ether(admin, this.feesCollector.address, ether('0.3'))

      await this.feesCollector.setAllowedSenderAddress(bob, false)

      expect(await this.feesCollector.allowedSenders(bob)).to.be.false
      expect(await this.feesCollector.allowedSenders(alice)).to.be.false

      await expectRevert(this.feesCollector.performUpkeep(0, { from: bob }), 'Not allowed')
      await expectRevert(this.feesCollector.performUpkeep(0, { from: alice }), 'Not allowed')

      await this.feesCollector.setAllowedSenderAddress(alice, true)

      expect(await this.feesCollector.allowedSenders(bob)).to.be.false
      expect(await this.feesCollector.allowedSenders(alice)).to.be.true

      await expectRevert(this.feesCollector.performUpkeep(0, { from: bob }), 'Not allowed')
      await this.feesCollector.performUpkeep(0, { from: alice })
    })
  } else {
    it.skip('allows running send funds regardless of whitelist enable property', async () => {})

    it.skip('allows running send funds regardless of existence of sender in whitelist', async () => {})
  }

  if (!sendToArbitrum) {
    it.skip('sets treasury percentage properly', async () => {})

    it.skip('sets treasury address properly', async () => {})

    it.skip('sets send percentage properly', async () => {})

    it.skip('sending percentage properly after multiple send funds', async () => {})

    it.skip('sets wrapped token properly', async () => {
      // Make sure approve is done correctly
    })
  }
}

describe('FeesCollector (send to arbitrum, convert to usdc true)', () => {
  beforeEach(async () => {
    await beforeEachFeesCollector(true, true, false, true)
  })

  setFeesCollectorTests(true, false, false)
})

describe('FeesCollector (buy back only)', () => {
  beforeEach(async () => {
    await beforeEachFeesCollector(false, false, true, true)
  })

  setFeesCollectorTests(false, false, true)
})

describe('FeesCollector (single contract)', () => {
  beforeEach(async () => {
    await beforeEachFeesCollector(false, true, true, true)
  })

  setFeesCollectorTests(false, true, false)
})

describe.skip('FeesCollector (single contract in polygon, not native, wrapped token is WETH)', () => {
  beforeEach(async () => {
    await beforeEachFeesCollector(false, true, true, false)
  })

  setFeesCollectorTests(false, true, true)
})
