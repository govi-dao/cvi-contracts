const {toBN, toTokenAmount, toCVI} = require('./BNUtils.js');

const Platform = artifacts.require('Platform');
const ETHPlatform = artifacts.require('ETHPlatform');
const ETHVolOracle = artifacts.require('ETHVolOracle');
const PositionRewards = artifacts.require('PositionRewards');
const FeesCalculator = artifacts.require('FeesCalculator');
const FakeERC20 = artifacts.require('FakeERC20');
const FakePriceProvider = artifacts.require('FakePriceProvider');
const FakeFeesCollector = artifacts.require('FakeFeesCollector');
const Liquidation = artifacts.require('Liquidation');

const INITIAL_RATE = toBN(1, 12);
const ETH_INITIAL_RATE = toBN(1, 3);
const MAX_CVI_VALUE = toBN(22000);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

let contracts = {};

const getAccounts = async () => {
    return web3.eth.getAccounts();
};

let admin;

const setAdmin = async () => {
    const accounts = await getAccounts();
    admin = accounts[0];
};

const deployPlatform = async (isETH, initialRate = INITIAL_RATE, ethIniitalRate = ETH_INITIAL_RATE, maxCVIValue = MAX_CVI_VALUE) => {
    await setAdmin();

    if (isETH) {
        contracts.platform = await ETHPlatform.new({from : admin});
        contracts.platform.initialize('ETH-LP', 'ETH-LP', ethIniitalRate, maxCVIValue,
            contracts.feesCalculator.address, contracts.fakeOracle.address, contracts.liquidation.address, {from: admin});
        contracts.initialRate = ethIniitalRate;
    } else {
        contracts.platform = await Platform.new({from: admin});
        contracts.platform.initialize(contracts.tokenAddress, 'WETH-LP', 'WETH-LP', initialRate, maxCVIValue,
            contracts.feesCalculator.address, contracts.fakeOracle.address, contracts.liquidation.address, {from: admin});
        contracts.initialRate = initialRate;
    }

    contracts.maxCVIValue = maxCVIValue;
};

const deployFullPlatform = async (isETH, token) => {
    await setAdmin();
	contracts = {};

	contracts.isETH = isETH;
    contracts.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(10000000), 18, {from: admin});

    if (!isETH) {
        if (token !== undefined) {
            contracts.token = token;
        } else {
            contracts.token = await FakeERC20.new('DAI', 'DAI', toTokenAmount(10000000), 6, {from: admin});
        }
    }

    contracts.tokenAddress = isETH ? ZERO_ADDRESS : contracts.token.address;
    contracts.fakePriceProvider = await FakePriceProvider.new(toCVI(5000), {from: admin});
    contracts.fakeOracle = await ETHVolOracle.new(contracts.fakePriceProvider.address, ZERO_ADDRESS, {from: admin});

    contracts.feesCalculator = await FeesCalculator.new(contracts.fakeOracle.address, MAX_CVI_VALUE, {from: admin});
    contracts.fakeFeesCollector = await FakeFeesCollector.new(contracts.tokenAddress, {from: admin});
    contracts.rewards = await PositionRewards.new({from: admin});
    contracts.rewards.initialize(contracts.cviToken.address, {from: admin});
    contracts.liquidation = await Liquidation.new(MAX_CVI_VALUE, {from: admin});

    contracts.stakingContractAddress = ZERO_ADDRESS;

    await deployPlatform(isETH);

    await contracts.platform.setMaxAllowedLeverage(8, {from: admin});
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, ZERO_ADDRESS, contracts.liquidation.address, contracts.fakeFeesCollector.address, {from: admin});
    await contracts.platform.setFeesCalculator(contracts.feesCalculator.address, {from: admin});

    contracts.rewardsAddress = ZERO_ADDRESS;

    await contracts.feesCalculator.setStateUpdator(contracts.platform.address, {from: admin});

    let cviValue = toCVI(5000);
    await contracts.fakePriceProvider.setPrice(cviValue);
};

const setStakingContractAddress = async (stakingContractAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, contracts.rewardsAddress, contracts.liquidation.address, stakingContractAddress, options);
};

const setFeesCalculator = async (feesCalculatorAddress, options) => {
    await contracts.platform.setFeesCalculator(feesCalculatorAddress, options);
};

const setRewards = async (rewardsAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, rewardsAddress, contracts.liquidation.address, contracts.stakingContractAddress, options);
};

const setFeesCollector = async (feesCollectorAddress, options) => {
    await contracts.platform.setSubContracts(feesCollectorAddress, contracts.fakeOracle.address, contracts.rewardsAddress, contracts.liquidation.address, contracts.stakingContractAddress, options);
};

const setLiquidation = async (liquidationAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, contracts.rewardsAddress, liquidationAddress, contracts.stakingContractAddress, options);
};

const setOracle = async (oracleAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, oracleAddress, contracts.rewardsAddress, contracts.liquidation.address, contracts.stakingContractAddress, options);
};

const getContracts = () => contracts;

const setContracts = newContracts => {
    contracts = newContracts;
};

exports.deployFullPlatform = deployFullPlatform;
exports.deployPlatform = deployPlatform;
exports.getContracts = getContracts;
exports.setContracts = setContracts;
exports.setFeesCalculator = setFeesCalculator;
exports.setRewards = setRewards;
exports.setFeesCollector = setFeesCollector;
exports.setLiquidation = setLiquidation;
exports.setOracle = setOracle;
exports.setStakingContractAddress = setStakingContractAddress;
exports.getAccounts = getAccounts;
exports.ZERO_ADDRESS = ZERO_ADDRESS;
