const {expectRevert, expectEvent, time, BN, balance} = require('@openzeppelin/test-helpers');
const chai = require('chai');

const { getAccounts, ZERO_ADDRESS } = require('./utils/DeployUtils.js');
const {toBN, toTokenAmount, toCVI} = require('./utils/BNUtils.js');
const {calculateSingleUnitFee, calculateNextAverageTurbulence} = require('./utils/FeesUtils.js');
const { print } = require('./utils/DebugUtils');

const ElasticToken = artifacts.require('ElasticToken');
const TestElasticToken = artifacts.require('TestElasticToken');

const expect = chai.expect;

const MAX_CVI_VALUE = new BN(20000);
const SCALING_FACTOR_DECIMALS = '1000000000000000000000000';
const DELTA_PRECISION_DECIMALS = '1000000000000000000';

let admin, bob, alice, carol;

const setAccounts = async () => {
    [admin, bob, alice, carol] = await getAccounts();
};

describe('Elastic Token', () => {
    beforeEach(async () => {
        await setAccounts();
        this.testElasticToken = await TestElasticToken.new('TestToken', 'ELT', 18, {from: admin});
    });

    it('check burn operation', async () => {
        const tx1 = await this.testElasticToken.mint(alice, 100);
        await expectEvent(tx1, 'Transfer', {from: ZERO_ADDRESS, to: alice, amount: toBN(100)});
        const tx2 = await this.testElasticToken.burn(alice, 40);
        await expectEvent(tx2, 'Transfer', {from: alice, to: ZERO_ADDRESS, amount: toBN(40)});

        //check initSupply
        const initSupply = await this.testElasticToken.initSupply.call();
        await expect(initSupply).to.be.bignumber.equal(new BN(60));

        //check totalSupply
        const totalSupply = await this.testElasticToken.totalSupply.call();
        await expect(totalSupply).to.be.bignumber.equal(new BN(60));

        //check underlying balances
        const aliceBalance = await this.testElasticToken.balanceOfUnderlying(alice);
        await expect(aliceBalance).to.be.bignumber.equal(new BN(60));

        const res = await this.testElasticToken.balanceOf(alice);
        await expect(res).to.be.bignumber.equal(new BN(60));
    });

    it('cannot burn more than existing funds', async () => {
        await this.testElasticToken.mint(alice, 100);
        await expectRevert.unspecified(this.testElasticToken.burn(alice, 101));
    });

    it('balanceOf and balanceOfUnderlying return zero for addresses with no funds', async () => {
        await this.testElasticToken.mint(alice, 100);
        const res = await this.testElasticToken.balanceOf(bob);
        await expect(res).to.be.bignumber.equal(new BN(0));

        const res2 = await this.testElasticToken.balanceOfUnderlying(bob);
        await expect(res2).to.be.bignumber.equal(new BN(0));
    });

    it('check mint operation', async () => {
        const tx = await this.testElasticToken.mint(alice, 40);
        await expectEvent(tx, 'Transfer', {from: ZERO_ADDRESS, to: alice, amount: toBN(40)});

        const res = await this.testElasticToken.balanceOf(alice);
        await expect(res).to.be.bignumber.equal(new BN(40));
    });

    it('verify transfer is not possible without sufficient funds', async () => {
        await this.testElasticToken.mint(alice, 100);
        await expectRevert.unspecified(this.testElasticToken.transfer(alice, 40, {from: bob}));
    });

    it('check that transfer and approve events are emitted as expected', async () => {
        await this.testElasticToken.mint(alice, 100);
        const tx1 = await this.testElasticToken.transfer(bob, 40, {from: alice});
        await expectEvent(tx1, 'Transfer', {from: alice, to: bob, amount: toBN(40)});

        await expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(60));
        await expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(40));

        const tx2 = await this.testElasticToken.approve(alice, 10, {from: bob});
        await expectEvent(tx2, 'Approval', {owner: bob, spender: alice, amount: toBN(10)});
        const tx3 = await this.testElasticToken.transferFrom(bob, alice, 10, {from: alice});
        await expectEvent(tx3, 'Transfer', {from: bob, to: alice, amount: toBN(10)});

        await expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(70));
        await expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(30));

        await expectRevert.unspecified(this.testElasticToken.transferFrom(bob, alice, 15, {from: alice}));
        const tx4 = await this.testElasticToken.increaseAllowance(alice, 15, {from: bob});
        await expectEvent(tx4, 'Approval', {owner: bob, spender: alice, amount: toBN(15)});
        await this.testElasticToken.transferFrom(bob, alice, 5, {from: alice}); // Allowance left is 10

        await expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(75));
        await expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(25));

        const tx5 = await this.testElasticToken.decreaseAllowance(alice, 5, {from: bob});
        await expectEvent(tx5, 'Approval', {owner: bob, spender: alice, amount: toBN(5)}); // Allownace decreased from 10 left to 5
        await expectRevert.unspecified(this.testElasticToken.transferFrom(bob, alice, 10, {from: alice}));
        await this.testElasticToken.transferFrom(bob, alice, 5, {from: alice});

        await expect(await this.testElasticToken.balanceOf(alice)).to.be.bignumber.equal(new BN(80));
        await expect(await this.testElasticToken.balanceOf(bob)).to.be.bignumber.equal(new BN(20));
    });

    it('decrease allowance in amount larger than value will not enable transferFrom of that amount', async () => {
        await this.testElasticToken.mint(alice, 30);
        await this.testElasticToken.approve(bob, 30, {from: alice});
        await this.testElasticToken.decreaseAllowance(bob, 10, {from: alice});
        await expectRevert.unspecified(this.testElasticToken.transferFrom(alice, bob, 21, {from: bob}));
        await this.testElasticToken.transferFrom(alice, bob, 20, {from: bob});
    });

    it('rebase between approve/increaseallowance and transfer', async () => {
        await this.testElasticToken.setRebaser(admin, {from: admin});

        await this.testElasticToken.mint(alice, 100);
        await this.testElasticToken.approve(bob, 20, {from: alice});
        const tx = await this.testElasticToken.rebase(new BN('100000000000000000'), false, {from: admin});

        const scalingAfter = await this.testElasticToken.scalingFactor();
        await expect(scalingAfter).to.be.bignumber.equal(new BN('900000000000000000000000'));

        const allowance = await this.testElasticToken.allowance(alice, bob);
        await expect(allowance).to.be.bignumber.equal(new BN(20));
        const balanceOfAlice = await this.testElasticToken.balanceOfUnderlying(alice);
        await expect(balanceOfAlice).to.be.bignumber.equal(new BN(100));

        const totalAmount = await this.testElasticToken.valueToUnderlying(100);
        await expect(totalAmount).to.be.bignumber.equal(new BN(111));

        const underlyingAmountToTransfer = await this.testElasticToken.valueToUnderlying(20);
        await expect(underlyingAmountToTransfer).to.be.bignumber.equal(new BN(22));

        await this.testElasticToken.transfer(bob, 20, {from: alice});

        const balanceOfAliceAfter = await this.testElasticToken.balanceOfUnderlying(alice);
        const balanceOfBobAfter = await this.testElasticToken.balanceOfUnderlying(bob);

        const underlyingAmountAlice = await this.testElasticToken.valueToUnderlying(balanceOfAliceAfter);
        const underlyingAmountBob = await this.testElasticToken.valueToUnderlying(balanceOfBobAfter);

        await expect(underlyingAmountAlice).to.be.bignumber.equal(new BN(86));
        await expect(underlyingAmountBob).to.be.bignumber.equal(new BN(24));

        await expect(balanceOfAliceAfter).to.be.bignumber.equal(new BN(78));
        await expect(balanceOfBobAfter).to.be.bignumber.equal(new BN(22));
    });

    it('check rebase operation when delta equals zero', async () => {
        await this.testElasticToken.setRebaser(admin, {from: admin});

        const scalingBefore = await this.testElasticToken.scalingFactor();
        await expect(scalingBefore).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS));
        const tx = await this.testElasticToken.rebase(0, true, {from: admin});
        const scalingAfter = await this.testElasticToken.scalingFactor();
        await expect(scalingAfter).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS));
        const timestamp = await time.latest();

        await expectEvent(tx, 'Rebase', {epoch: timestamp, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter});

        const tx2 = await this.testElasticToken.rebase(0, false, {from: admin});
        const scalingAfter2 = await this.testElasticToken.scalingFactor();
        await expect(scalingAfter2).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS));
        const timestamp2 = await time.latest();

        await expectEvent(tx2, 'Rebase', {epoch: timestamp2, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter});
    });

    it('check rebase operation when delta > 0', async () => {
        const amount = 100;

        await this.testElasticToken.setRebaser(admin, {from: admin});
        await this.testElasticToken.mint(alice, amount);

        const underlyingValue = await this.testElasticToken.valueToUnderlying(amount);
        await expect(underlyingValue).to.be.bignumber.equal(new BN(amount));

        const scalingBefore = await this.testElasticToken.scalingFactor();
        await expect(scalingBefore).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS));
        const tx = await this.testElasticToken.rebase(12, true, {from: admin});
        const scalingAfter = await this.testElasticToken.scalingFactor();
        await expect(scalingAfter).to.be.bignumber.equal(new BN('1000000000000000012000000'));
        const timestamp = await time.latest();
        await expectEvent(tx, 'Rebase', {epoch: timestamp, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter});

        //check initSupply
        const initSupply = await this.testElasticToken.initSupply.call(); //100
        await expect(initSupply).to.be.bignumber.equal(new BN(100));

        //check totalSupply
        const totalSupply = await this.testElasticToken.totalSupply.call(); //100.0000000000000012
        await expect(totalSupply).to.be.bignumber.equal(new BN(100));

        //check valueToUnderlying of totalSupply
        const a = totalSupply.mul(new BN(SCALING_FACTOR_DECIMALS)).div(new BN(scalingAfter)); //99.9999999999999988
        await expect(a).to.be.bignumber.equal(new BN(99));

        //check underlying balances
        const aliceBalance = await this.testElasticToken.balanceOfUnderlying(alice);
        await expect(aliceBalance).to.be.bignumber.equal(new BN(100));
    });

    it('check rebase operation when delta < 0', async () => {
        const amount = 100;

        await this.testElasticToken.setRebaser(admin, {from: admin});
        await this.testElasticToken.mint(alice, amount);

        const underlyingValue = await this.testElasticToken.valueToUnderlying(amount);
        await expect(underlyingValue).to.be.bignumber.equal(new BN(amount));

        const scalingBefore = await this.testElasticToken.scalingFactor();
        await expect(scalingBefore).to.be.bignumber.equal(new BN(SCALING_FACTOR_DECIMALS));
        const tx = await this.testElasticToken.rebase(12, false, {from: admin});
        const scalingAfter = await this.testElasticToken.scalingFactor();
        await expect(scalingAfter).to.be.bignumber.equal(new BN('999999999999999988000000'));
        const timestamp = await time.latest();
        await expectEvent(tx, 'Rebase', {epoch: timestamp, prevScalingFactor: scalingBefore, newScalingFactor: scalingAfter});

        //check initSupply
        const initSupply = await this.testElasticToken.initSupply.call(); //100
        await expect(initSupply).to.be.bignumber.equal(new BN(100));

        //check totalSupply
        const totalSupply = await this.testElasticToken.totalSupply.call(); //99.9999999999999988
        await expect(totalSupply).to.be.bignumber.equal(new BN(99));

        //check valueToUnderlying of totalSupply
        const a = totalSupply.mul(new BN(SCALING_FACTOR_DECIMALS)).div(new BN(scalingAfter)); //99.000000000000001188
        await expect(a).to.be.bignumber.equal(new BN(99));

        //check underlying balances
        const aliceBalance = await this.testElasticToken.balanceOfUnderlying(alice);
        await expect(aliceBalance).to.be.bignumber.equal(new BN(100));
    });

    it('rebase fails if no tokens were minted.', async () => {
        // However, rebase to indexDelta=0 doesn't throw an Error
        await this.testElasticToken.setRebaser(admin, {from: admin});
        const scalingBefore = await this.testElasticToken.scalingFactor();
        await expectRevert.unspecified(this.testElasticToken.rebase(10, true, {from: admin}));
    });

    it('reverts when recipient is invalid', async () => {
        await expectRevert(this.testElasticToken.mint(ZERO_ADDRESS, 40, {from: alice}), 'Zero address');
        await expectRevert(this.testElasticToken.burn(ZERO_ADDRESS, 40, {from: alice}), 'Zero address');
        await expectRevert(this.testElasticToken.transfer(ZERO_ADDRESS, 40, {from: admin}), 'Zero address');

        await expectRevert(this.testElasticToken.transferFrom(ZERO_ADDRESS, alice, 40, {from: alice}), 'Zero address');
        await expectRevert(this.testElasticToken.transferFrom(bob, ZERO_ADDRESS, 40,  {from: bob}), 'Zero address');
        await expectRevert(this.testElasticToken.transferFrom(ZERO_ADDRESS, ZERO_ADDRESS, 40, {from: admin}), 'Zero address');
    });

    it('reverts when not called by rebaser', async () => {
        await this.testElasticToken.setRebaser(admin, {from: admin});
        await expectRevert(this.testElasticToken.rebase(40, true, {from: alice}), 'Not allowed');
    });

    it('reverts when not called by owner', async () => {
        await expectRevert(this.testElasticToken.setRebaser(admin, {from: alice}), 'Ownable: caller is not the owner');
    });
});
