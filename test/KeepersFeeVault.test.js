/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { expectRevert, time, BN } = require('@openzeppelin/test-helpers')
const chai = require('chai')

const { toUSD } = require('./utils/BNUtils.js')
const { getAccounts } = require('./utils/DeployUtils.js')

const FakeERC20 = artifacts.require('FakeERC20')
const KeepersFeeVault = artifacts.require('KeepersFeeVault')

const expect = chai.expect

let admin, bob, extractor

const setAccounts = async () => {
  ;[admin, bob, extractor] = await getAccounts()
}

describe('KeepersFeeVault', () => {
  beforeEach(async () => {
    await setAccounts()

    this.usdcToken = await FakeERC20.new('USDC', 'USDC', toUSD(1000000000), 18, { from: admin })
    this.vault = await KeepersFeeVault.new(this.usdcToken.address, { from: admin })
  })

  it('reverts when extracting without setting extractor', async () => {
    await expectRevert(this.vault.extractUSDC({ from: admin }), 'Not allowed')
  })

  it('reverts when setting extractor not by owner', async () => {
    await expectRevert(this.vault.setExtractor(bob, { from: extractor }), 'Ownable: caller is not the owner')
    await expectRevert(this.vault.setExtractor(extractor, { from: bob }), 'Ownable: caller is not the owner')
  })

  it('reverts when extracting and no USDC in vault', async () => {
    await this.vault.setExtractor(extractor, { from: admin })
    await expectRevert(this.vault.extractUSDC({ from: extractor }), 'No funds')
  })

  it('allows extraction of all usdc transfered to vault', async () => {
    expect(await this.usdcToken.balanceOf(extractor)).to.be.bignumber.equal(toUSD(0))

    await this.vault.setExtractor(extractor, { from: admin })

    await this.usdcToken.transfer(this.vault.address, toUSD(1000), { from: admin })
    await time.increase(3600)
    await this.usdcToken.transfer(this.vault.address, toUSD(500), { from: admin })
    await time.increase(3600)
    await this.vault.extractUSDC({ from: extractor })

    expect(await this.usdcToken.balanceOf(extractor)).to.be.bignumber.equal(toUSD(1500))
  })

  it('reverts when extracting not by extractor', async () => {
    await this.vault.setExtractor(extractor, { from: admin })

    await this.usdcToken.transfer(this.vault.address, toUSD(1000), { from: admin })
    await expectRevert(this.vault.extractUSDC({ from: bob }), 'Not allowed')
    await expectRevert(this.vault.extractUSDC({ from: admin }), 'Not allowed')
  })

  it('sets extractor properly', async () => {
    await this.vault.setExtractor(extractor, { from: admin })

    await this.usdcToken.transfer(this.vault.address, toUSD(1000), { from: admin })
    await this.vault.extractUSDC({ from: extractor })

    expect(await this.usdcToken.balanceOf(extractor)).to.be.bignumber.equal(toUSD(1000))

    await this.usdcToken.transfer(this.vault.address, toUSD(500), { from: admin })
    await this.vault.setExtractor(bob, { from: admin })

    await expectRevert(this.vault.extractUSDC({ from: extractor }), 'Not allowed')
    await this.vault.extractUSDC({ from: bob })

    expect(await this.usdcToken.balanceOf(bob)).to.be.bignumber.equal(toUSD(500))
  })
})
