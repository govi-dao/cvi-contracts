/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, expectEvent, time, BN, balance } = require('@openzeppelin/test-helpers')
const chai = require('chai')

const { getAccounts, ZERO_ADDRESS } = require('./utils/DeployUtils.js')
const { toBN, toTokenAmount, toCVI } = require('./utils/BNUtils.js')
const { calculateSingleUnitFee, calculateNextAverageTurbulence } = require('./utils/FeesUtils.js')
const { print } = require('./utils/DebugUtils')

const ElasticToken = artifacts.require('ElasticToken')
const TestElasticToken = artifacts.require('TestElasticToken')

const expect = chai.expect

const MAX_CVI_VALUE = new BN(20000)
const SCALING_FACTOR_DECIMALS = '1000000000000000000000000'
const DELTA_PRECISION_DECIMALS = '1000000000000000000'

let admin, bob, alice, carol

const setAccounts = async () => {
  ;[admin, bob, alice, carol] = await getAccounts()
}

describe('Elastic Token', () => {
  beforeEach(async () => {
    await setAccounts()
    this.testElasticToken = await TestElasticToken.new('TestToken', 'ELT', 18, { from: admin })
  })

  it('burns first properly', async () => {
    const tx1 = await this.testElasticToken.mint(alice, 100)
    await expectEvent(tx1, 'Transfer', { from: ZERO_ADDRESS, to: alice, amount: toBN(100) })

    const tx2 = await this.testElasticToken.burn(alice, 40)
    await expectEvent(tx2, 'Transfer', { from: alice, to: ZERO_ADDRESS, amount: toBN(40) })

    const initSupply = await this.testElasticToken.initSupply()
    await expect(initSupply).to.be.bignumber.equal(toBN(60))

    const totalSupply = await this.testElasticToken.totalSupply()
    await expect(totalSupply).to.be.bignumber.equal(toBN(60))

    const aliceUnderlyingBalance = await this.testElasticToken.balanceOfUnderlying(alice)
    await expect(aliceUnderlyingBalance).to.be.bignumber.equal(toBN(60))

    const aliceBalance = await this.testElasticToken.balanceOf(alice)
    await expect(aliceBalance).to.be.bignumber.equal(toBN(60))
  })

  it('reverts when burning more than existing funds', async () => {
    await this.testElasticToken.mint(alice, 100)
    await expectRevert.unspecified(this.testElasticToken.burn(alice, 101))
  })

  it('returns zero balance and underlyingBalance for addresses with no funds', async () => {
    await this.testElasticToken.mint(alice, 100)
    const res = await this.testElasticToken.balanceOf(bob)
    await expect(res).to.be.bignumber.equal(new BN(0))

    const res2 = await this.testElasticToken.balanceOfUnderlying(bob)
    await expect(res2).to.be.bignumber.equal(new BN(0))
  })

  it('mints first properly', async () => {
    const tx = await this.testElasticToken.mint(alice, 40)
    await expectEvent(tx, 'Transfer', { from: ZERO_ADDRESS, to: alice, amount: toBN(40) })

    const initSupply = await this.testElasticToken.initSupply()
    await expect(initSupply).to.be.bignumber.equal(toBN(40))

    const totalSupply = await this.testElasticToken.totalSupply()
    await expect(totalSupply).to.be.bignumber.equal(toBN(40))

    const aliceUnderlyingBalance = await this.testElasticToken.balanceOfUnderlying(alice)
    await expect(aliceUnderlyingBalance).to.be.bignumber.equal(toBN(40))

    const aliceBalance = await this.testElasticToken.balanceOf(alice)
    await expect(aliceBalance).to.be.bignumber.equal(toBN(40))
  })

  it.skip('mints and burns properly for multi-users', async () => {})

  it('reverts transfer without sufficient funds', async () => {
    await this.testElasticToken.mint(alice, 100)
    await expectRevert.unspecified(this.testElasticToken.transfer(alice, 40, { from: bob }))
  })

  it('emits transfer and approve events properly', async () => {
    await this.testElasticToken.mint(alice, 100)
    const tx1 = await this.testElasticToken.transfer(bob, 40, { from: alice })
    await expectEvent(tx1, 'Transfer', { from: alice, to: bob, amount: toBN(40) })

    expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(60))
    expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(40))

    const tx2 = await this.testElasticToken.approve(alice, 10, { from: bob })
    await expectEvent(tx2, 'Approval', { owner: bob, spender: alice, amount: toBN(10) })
    const tx3 = await this.testElasticToken.transferFrom(bob, alice, 10, { from: alice })
    await expectEvent(tx3, 'Transfer', { from: bob, to: alice, amount: toBN(10) })

    expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(70))
    expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(30))

    expectRevert.unspecified(this.testElasticToken.transferFrom(bob, alice, 15, { from: alice }))
    const tx4 = await this.testElasticToken.increaseAllowance(alice, 15, { from: bob })
    expect(await this.testElasticToken.allowance(bob, alice)).to.be.bignumber.equal(toBN(15))
    expectEvent(tx4, 'Approval', { owner: bob, spender: alice, amount: toBN(15) })
    await this.testElasticToken.transferFrom(bob, alice, 5, { from: alice })
    expect(await this.testElasticToken.allowance(bob, alice)).to.be.bignumber.equal(toBN(10))

    expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(75))
    expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(25))

    const tx5 = await this.testElasticToken.decreaseAllowance(alice, 5, { from: bob })
    expect(await this.testElasticToken.allowance(bob, alice)).to.be.bignumber.equal(toBN(5))
    expectEvent(tx5, 'Approval', { owner: bob, spender: alice, amount: toBN(5) })
    expectRevert.unspecified(this.testElasticToken.transferFrom(bob, alice, 10, { from: alice }))
    await this.testElasticToken.transferFrom(bob, alice, 5, { from: alice })
    expect(await this.testElasticToken.allowance(bob, alice)).to.be.bignumber.equal(toBN(0))

    expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(80))
    expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(20))
  })

  it.skip('transfers properly', async () => {})

  it.skip('transfers from properly', async () => {})

  it.skip('approves allowance properly', async () => {})

  it.skip('approves allowance properly for multi-users', async () => {})

  it('decreases allowance properly', async () => {
    await this.testElasticToken.mint(alice, 30)
    await this.testElasticToken.approve(bob, 30, { from: alice })
    await this.testElasticToken.decreaseAllowance(bob, 10, { from: alice })
    await expectRevert.unspecified(this.testElasticToken.transferFrom(alice, bob, 21, { from: bob }))
    await this.testElasticToken.transferFrom(alice, bob, 20, { from: bob })
  })

  it.skip('decreases allowance properly for multi-users', async () => {})

  it.skip('increases allowance properly', async () => {})

  it.skip('increases allowance properly for multi-users', async () => {})

  it('rebases properly between approve/increaseallowance and transfer', async () => {
    await this.testElasticToken.setRebaser(admin, { from: admin })

    await this.testElasticToken.mint(alice, 100)
    await this.testElasticToken.approve(bob, 20, { from: alice })
    const tx = await this.testElasticToken.rebase(new BN('100000000000000000'), false, { from: admin })

    const scalingAfter = await this.testElasticToken.scalingFactor()
    expect(scalingAfter).to.be.bignumber.equal(new BN('900000000000000000000000'))

    const allowance = await this.testElasticToken.allowance(alice, bob)
    expect(allowance).to.be.bignumber.equal(new BN(20))
    const balanceOfAlice = await this.testElasticToken.balanceOfUnderlying(alice)
    expect(balanceOfAlice).to.be.bignumber.equal(new BN(100))

    const totalAmount = await this.testElasticToken.valueToUnderlying(100)
    expect(totalAmount).to.be.bignumber.equal(new BN(111))

    const underlyingAmountToTransfer = await this.testElasticToken.valueToUnderlying(20)
    expect(underlyingAmountToTransfer).to.be.bignumber.equal(new BN(22))

    await this.testElasticToken.transfer(bob, 20, { from: alice })

    const balanceOfAliceAfter = await this.testElasticToken.balanceOfUnderlying(alice)
    const balanceOfBobAfter = await this.testElasticToken.balanceOfUnderlying(bob)

    const underlyingAmountAlice = await this.testElasticToken.valueToUnderlying(balanceOfAliceAfter)
    const underlyingAmountBob = await this.testElasticToken.valueToUnderlying(balanceOfBobAfter)

    expect(underlyingAmountAlice).to.be.bignumber.equal(new BN(86))
    expect(underlyingAmountBob).to.be.bignumber.equal(new BN(24))

    expect(balanceOfAliceAfter).to.be.bignumber.equal(new BN(78))
    expect(balanceOfBobAfter).to.be.bignumber.equal(new BN(22))
  })

  it('rebases properly when delta is zero', async () => {
    await this.testElasticToken.setRebaser(admin, { from: admin })

    const scalingBefore = await this.testElasticToken.scalingFactor()
    expect(scalingBefore).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS))
    const tx = await this.testElasticToken.rebase(0, true, { from: admin })
    const scalingAfter = await this.testElasticToken.scalingFactor()
    expect(scalingAfter).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS))
    const timestamp = await time.latest()

    expectEvent(tx, 'Rebase', { epoch: timestamp, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter })

    const tx2 = await this.testElasticToken.rebase(0, false, { from: admin })
    const scalingAfter2 = await this.testElasticToken.scalingFactor()
    expect(scalingAfter2).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS))
    const timestamp2 = await time.latest()

    expectEvent(tx2, 'Rebase', { epoch: timestamp2, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter })
  })

  it('rebases properly when delta > 0', async () => {
    const amount = 100

    await this.testElasticToken.setRebaser(admin, { from: admin })
    await this.testElasticToken.mint(alice, amount)

    const underlyingValue = await this.testElasticToken.valueToUnderlying(amount)
    expect(underlyingValue).to.be.bignumber.equal(new BN(amount))

    const scalingBefore = await this.testElasticToken.scalingFactor()
    expect(scalingBefore).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS))
    const tx = await this.testElasticToken.rebase(12, true, { from: admin })
    const scalingAfter = await this.testElasticToken.scalingFactor()
    expect(scalingAfter).to.be.bignumber.equal(new BN('1000000000000000012000000'))
    const timestamp = await time.latest()
    expectEvent(tx, 'Rebase', { epoch: timestamp, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter })

    const initSupply = await this.testElasticToken.initSupply() //100
    expect(initSupply).to.be.bignumber.equal(new BN(100))

    const totalSupply = await this.testElasticToken.totalSupply() //100.0000000000000012
    expect(totalSupply).to.be.bignumber.equal(new BN(100))

    const underlyingTotalSupply = totalSupply.mul(new BN(SCALING_FACTOR_DECIMALS)).div(new BN(scalingAfter)) //99.9999999999999988
    expect(underlyingTotalSupply).to.be.bignumber.equal(new BN(99))

    const aliceBalance = await this.testElasticToken.balanceOfUnderlying(alice)
    expect(aliceBalance).to.be.bignumber.equal(new BN(100))
  })

  it.skip('rebases properly with various delta values > 0', async () => {})

  it('rebases properly when delta < 0', async () => {
    const amount = 100

    await this.testElasticToken.setRebaser(admin, { from: admin })
    await this.testElasticToken.mint(alice, amount)

    const underlyingValue = await this.testElasticToken.valueToUnderlying(amount)
    expect(underlyingValue).to.be.bignumber.equal(new BN(amount))

    const scalingBefore = await this.testElasticToken.scalingFactor()
    expect(scalingBefore).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS))
    const tx = await this.testElasticToken.rebase(12, false, { from: admin })
    const scalingAfter = await this.testElasticToken.scalingFactor()
    expect(scalingAfter).to.be.bignumber.equal(new BN('999999999999999988000000'))
    const timestamp = await time.latest()
    expectEvent(tx, 'Rebase', { epoch: timestamp, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter })

    const initSupply = await this.testElasticToken.initSupply() //100
    expect(initSupply).to.be.bignumber.equal(new BN(100))

    const totalSupply = await this.testElasticToken.totalSupply() //99.9999999999999988
    expect(totalSupply).to.be.bignumber.equal(new BN(99))

    const underlyingTotalSupply = totalSupply.mul(new BN(SCALING_FACTOR_DECIMALS)).div(new BN(scalingAfter)) //99.000000000000001188
    expect(underlyingTotalSupply).to.be.bignumber.equal(new BN(99))

    const aliceBalance = await this.testElasticToken.balanceOfUnderlying(alice)
    expect(aliceBalance).to.be.bignumber.equal(new BN(100))
  })

  it.skip('rebases properly with various delta values < 0', async () => {})

  it('reverts when rebasing with no tokens minted', async () => {
    await this.testElasticToken.setRebaser(admin, { from: admin })
    const scalingBefore = await this.testElasticToken.scalingFactor()
    await expectRevert.unspecified(this.testElasticToken.rebase(10, true, { from: admin }))
  })

  it('rebases properly with zero indexDelta even if no tokens are minted', async () => {
    // NOTE: Make sure this is desired
  })

  it.skip('scaling factor doesnt exceed maxScalingFactor', async () => {
    await this.testElasticToken.setRebaser(admin, { from: admin })
    for (let i = 0; i < 100; i++) {
      await this.testElasticToken.mint(alice, toBN(1, 77))
    }
    await this.testElasticToken.rebase(new BN('100000000000000000'), true, { from: admin })
    const scalingAfter = await this.testElasticToken.scalingFactor()
    expect(scalingAfter).to.be.bignumber.equal(new BN('1100000000000000000000000'))

    const maxScalingFactor = await this.testElasticToken.maxScalingFactor()
    expect(maxScalingFactor).to.be.bignumber.equal(
      new BN('11579208923731619542357098500868790785326998466564056403945'),
    )

    await this.testElasticToken.rebase(new BN('100000000000000000'), true, { from: admin })
    const scalingAfter2 = await this.testElasticToken.scalingFactor()
    expect(scalingAfter2).to.be.bignumber.equal(new BN('1210000000000000000000000'))

    const maxScalingFactor2 = await this.testElasticToken.maxScalingFactor()
    expect(maxScalingFactor2).to.be.bignumber.equal(
      new BN('11579208923731619542357098500868790785326998466564056403945'),
    )

    for (let i = 0; i < 100; i++) {
      await this.testElasticToken.rebase(new BN('100000000000000000'), true, { from: admin })
    }

    const scalingAfter3 = await this.testElasticToken.scalingFactor()
    await expect(scalingAfter3).to.be.bignumber.equal(new BN('1210000000000000000000000'))
  })

  it('reverts when recipient is invalid', async () => {
    await expectRevert(this.testElasticToken.mint(ZERO_ADDRESS, 40, { from: alice }), 'Zero address')
    await expectRevert(this.testElasticToken.burn(ZERO_ADDRESS, 40, { from: alice }), 'Zero address')
    await expectRevert(this.testElasticToken.transfer(ZERO_ADDRESS, 40, { from: admin }), 'Zero address')

    await expectRevert(this.testElasticToken.transferFrom(ZERO_ADDRESS, alice, 40, { from: alice }), 'Zero address')
    await expectRevert(this.testElasticToken.transferFrom(bob, ZERO_ADDRESS, 40, { from: bob }), 'Zero address')
    await expectRevert(
      this.testElasticToken.transferFrom(ZERO_ADDRESS, ZERO_ADDRESS, 40, { from: admin }),
      'Zero address',
    )
  })

  it('reverts when rebase not called by rebaser', async () => {
    await this.testElasticToken.setRebaser(admin, { from: admin })
    await expectRevert(this.testElasticToken.rebase(40, true, { from: alice }), 'Not allowed')
  })

  it('reverts when admin functions are not called by owner', async () => {
    await expectRevert(this.testElasticToken.setRebaser(admin, { from: alice }), 'Ownable: caller is not the owner')
  })

  it.skip('sets rebaser properly', async () => {})
})
