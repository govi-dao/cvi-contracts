const {expectRevert, time, BN} = require('@openzeppelin/test-helpers');
const {accounts, contract} = require('@openzeppelin/test-environment');
const chai = require('chai');

const {toTokenAmount, toBN} = require('./utils/BNUtils.js');

const Staking = contract.fromArtifact('Staking');
const FakeERC20 = contract.fromArtifact('FakeERC20');

const expect = chai.expect;
const [admin, bob, alice, carol] = accounts;

describe('Staking', () => {
    beforeEach(async () => {
        //this.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(10000000), 18, {from: admin});
        //this.staking = await Staking.new(this.cviToken.address, this.fakeUniswapRouter.address, {from: admin});
    });

    it('reverts when rewarding zero position units', async() => {
        //await expectRevert(this.rewards.reward(bob, new BN(0), {from: admin}), 'Position units must be positive');
    });
});
