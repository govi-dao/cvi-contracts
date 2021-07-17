const {toBN, toTokenAmount, toCVI} = require('./BNUtils.js');

const {accounts, contract} = require('@openzeppelin/test-environment');
const [admin] = accounts;

const Platform = contract.fromArtifact('Platform');
const ETHPlatform = contract.fromArtifact('ETHPlatform');
const ETHVolOracle = contract.fromArtifact('ETHVolOracle');
const PositionRewards = contract.fromArtifact('PositionRewards');
const FeesCalculator = contract.fromArtifact('FeesCalculator');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const FakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const Liquidation = contract.fromArtifact('Liquidation');

const INITIAL_RATE = toBN(1, 12);
const ETH_INITIAL_RATE = toBN(1, 3);
const MAX_CVI_VALUE = toBN(22000);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'; //TOOD: To constants

let contracts = {};

const deployPlatform = async (isETH, initialRate = INITIAL_RATE, ethIniitalRate = ETH_INITIAL_RATE, maxCVIValue = MAX_CVI_VALUE) => {
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

const deployFullPlatform = async isETH => {
	contracts = {};

	contracts.isETH = isETH;
    contracts.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(10000000), 18, {from: admin});

    if (!isETH) {
        contracts.token = await FakeERC20.new('DAI', 'DAI', toTokenAmount(10000000), 6, {from: admin});
    }

    contracts.tokenAddress = isETH ? ZERO_ADDRESS : contracts.token.address;
    contracts.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
    contracts.fakeOracle = await ETHVolOracle.new(contracts.fakePriceProvider.address, ZERO_ADDRESS, {from: admin});

    contracts.feesCalculator = await FeesCalculator.new(contracts.fakeOracle.address, MAX_CVI_VALUE, {from: admin});
    contracts.fakeFeesCollector = await FakeFeesCollector.new(contracts.tokenAddress, {from: admin});
    contracts.rewards = await PositionRewards.new(contracts.cviToken.address, {from: admin});
    contracts.liquidation = await Liquidation.new(MAX_CVI_VALUE, {from: admin});

    contracts.stakingContractAddress = ZERO_ADDRESS;

    await deployPlatform(isETH);

    await contracts.platform.setMaxAllowedLeverage(8, {from: admin});
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, contracts.rewards.address, contracts.liquidation.address, contracts.fakeFeesCollector.address, {from: admin});
    await contracts.platform.setFeesCalculator(contracts.feesCalculator.address, {from: admin});
    await contracts.rewards.setRewarder(contracts.platform.address, {from: admin});

    await contracts.feesCalculator.setTurbulenceUpdator(contracts.platform.address, {from: admin});

    let cviValue = toCVI(5000);
    await contracts.fakePriceProvider.setPrice(cviValue);
};

const setStakingContractAddress = async (stakingContractAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, contracts.rewards.address, contracts.liquidation.address, stakingContractAddress, options);
};

const setFeesCalculator = async (feesCalculatorAddress, options) => {
    await contracts.platform.setFeesCalculator(feesCalculatorAddress, options);
};

const setRewards = async (rewardsAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, rewardsAddress, contracts.liquidation.address, contracts.stakingContractAddress, options);
};

const setFeesCollector = async (feesCollectorAddress, options) => {
    await contracts.platform.setSubContracts(feesCollectorAddress, contracts.fakeOracle.address, contracts.rewards.address, contracts.liquidation.address, contracts.stakingContractAddress, options);
};

const setLiquidation = async (liquidationAddress, options) => {
    await contracts.platform.setSubContracts(contracts.fakeFeesCollector.address, contracts.fakeOracle.address, contracts.rewards.address, liquidationAddress, contracts.stakingContractAddress, options);
};

const getContracts = () => contracts;

exports.deployFullPlatform = deployFullPlatform;
exports.deployPlatform = deployPlatform;
exports.getContracts = getContracts;
exports.setFeesCalculator = setFeesCalculator;
exports.setRewards = setRewards;
exports.setFeesCollector = setFeesCollector;
exports.setLiquidation = setLiquidation;
exports.setStakingContractAddress = setStakingContractAddress;
