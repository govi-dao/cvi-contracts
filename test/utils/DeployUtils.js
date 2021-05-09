const {toBN, toTokenAmount, toCVI} = require('./BNUtils.js');

const {accounts, contract} = require('@openzeppelin/test-environment');
const [admin] = accounts;

const Platform = contract.fromArtifact('PlatformV3');
const ETHPlatform = contract.fromArtifact('ETHPlatformV2');
const CVIOracle = contract.fromArtifact('CVIOracleV3');
const Rewards = contract.fromArtifact('Rewards');
const FeesCalculator = contract.fromArtifact('FeesCalculatorV4');
const FakeERC20 = contract.fromArtifact('FakeERC20');
const FakePriceProvider = contract.fromArtifact('FakePriceProvider');
const FakeFeesCollector = contract.fromArtifact('FakeFeesCollector');
const Liquidation = contract.fromArtifact('Liquidation');

const INITIAL_RATE = toBN(1, 12);
const ETH_INITIAL_RATE = toBN(1, 3);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'; //TOOD: To constants

let contracts = {};

const deployPlatform = async (isETH, initialRate = INITIAL_RATE, ethIniitalRate = ETH_INITIAL_RATE) => {
    if (isETH) {
        contracts.platform = await ETHPlatform.new(
            'ETH-LP', 'ETH-LP', ethIniitalRate,
            contracts.feesCalculator.address, contracts.fakeOracle.address, contracts.liquidation.address, {from: admin});
        contracts.initialRate = ethIniitalRate;
    } else {
        contracts.platform = await Platform.new(
            contracts.tokenAddress, 'WETH-LP', 'WETH-LP', initialRate,
            contracts.feesCalculator.address, contracts.fakeOracle.address, contracts.liquidation.address, {from: admin});
        contracts.initialRate = initialRate;
    }
};

const deployFullPlatform = async isETH => {
	contracts = {};

	contracts.isETH = isETH;
    contracts.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(100000), 18, {from: admin});

    if (!isETH) {
        contracts.token = await FakeERC20.new('DAI', 'DAI', toTokenAmount(100000), 18, {from: admin});
    }

    contracts.tokenAddress = isETH ? ZERO_ADDRESS : contracts.token.address;
    contracts.fakePriceProvider = await FakePriceProvider.new(80, {from: admin});
    contracts.fakeOracle = await CVIOracle.new(contracts.fakePriceProvider.address, {from: admin});
    contracts.feesCalculator = await FeesCalculator.new({from: admin});
    contracts.fakeFeesCollector = await FakeFeesCollector.new(contracts.tokenAddress, {from: admin});
    contracts.rewards = await Rewards.new(contracts.cviToken.address, {from: admin});
    contracts.liquidation = await Liquidation.new({from: admin});

    await deployPlatform(isETH);

    await contracts.rewards.setRewarder(contracts.platform.address, {from: admin});
    await contracts.feesCalculator.setTurbulenceUpdator(contracts.platform.address, {from: admin});

    await contracts.platform.setFeesCollector(contracts.fakeFeesCollector.address, {from: admin});

    let cviValue = toCVI(5000);
    await contracts.fakePriceProvider.setPrice(cviValue);
};

const getContracts = () => contracts;

exports.deployFullPlatform = deployFullPlatform;
exports.deployPlatform = deployPlatform;
exports.getContracts = getContracts;
