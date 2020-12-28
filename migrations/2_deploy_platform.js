const Platform = artifacts.require('Platform.sol');
const Rewards = artifacts.require('Rewards.sol');
const ETHPlatform = artifacts.require('ETHPlatform.sol');
const FeesModel = artifacts.require('FeesModel.sol');
const FakeERC20 = artifacts.require('FakeERC20.sol');
const TestnetERC20 = artifacts.require('TestnetERC20.sol');
const WETH9 = artifacts.require('WETH9.sol');
const FakePriceProvider = artifacts.require('FakePriceProvider.sol');
const CVIOracle = artifacts.require('CVIOracle.sol');
const FakeFeesCollector = artifacts.require('FakeFeesCollector.sol');
const FeesCalculator = artifacts.require('FeesCalculator.sol');
const Liquidation = artifacts.require('Liquidation.sol');
const GOVI = artifacts.require('GOVI.sol');
const BN = web3.utils.BN;

module.exports = async function(deployer, network, [admin]) {
  if (['development', 'soliditycoverage','cvidev'].includes(network)) {
    console.log('deploying...');
    await deployer.deploy(GOVI);
    await deployer.deploy(TestnetERC20, 'Tether', 'USDT', 6);
    const usdtAddress = TestnetERC20.address;
    //await deployer.deploy(FakePriceProvider, 80);
    await deployer.deploy(CVIOracle, '0x37960e1e359541ffd071065b685026899bcB96c3');
    await deployer.deploy(FeesCalculator);
    await deployer.deploy(FeesModel, FeesCalculator.address, CVIOracle.address);
    await deployer.deploy(Rewards, usdtAddress);
    await deployer.deploy(Liquidation);

    console.log('Deploying USDT Platform...');
    await deployer.deploy(FakeFeesCollector, usdtAddress);
    await deployer.deploy(Platform, usdtAddress, 'USDT-LP', 'USDT-LP', FeesModel.address, FeesCalculator.address,
    CVIOracle.address, Liquidation.address, {from: admin });

    const platform = await Platform.deployed();
    const rewards = await Rewards.deployed();

    await platform.setRewards(Rewards.address);
    await platform.setFeesCollector(FakeFeesCollector.address);
    await rewards.setRewarder(Platform.address);

    if(process.env.TESTNET) {
      await testPlatform([admin]);
    }

    saveContracts();
  }
};

function saveContracts() {
  const CONTRACTS_FILE = process.env.CONTRACTS_FILE;
  if(CONTRACTS_FILE) {
    const fs = require('fs');
    console.log('> Contracts writing: ' + CONTRACTS_FILE);
    fs.writeFileSync(CONTRACTS_FILE, JSON.stringify({ 
        GOVI: {
          address: GOVI.address,
          abi: GOVI.abi
        },
        USDT: {
          address: TestnetERC20.address,
          abi: TestnetERC20.abi
        },
        USDTPlatform: {
          address: Platform.address,
          abi: Platform.abi
        },
        FeesCalculator: {
          address: FeesCalculator.address,
          abi: FeesCalculator.abi
        },
        FeesModel: {
          address: FeesModel.address,
          abi: FeesModel.abi
        },
        Liquidation: {
          address: Liquidation.address,
          abi: Liquidation.abi
        },
        CVIOracle: {
          address: CVIOracle.address,
          abi: CVIOracle.abi
        },
        Rewards: {
          address: Rewards.address,
          abi: Rewards.abi
        }
    }));
  }
}

async function testPlatform([admin]) {
  try {
    const token = await TestnetERC20.deployed();
    console.log('token address:', TestnetERC20.address);
    await token.addToWhitelist(Platform.address);
    await token.faucet({from:admin});
    console.log('token balance:',(await token.balanceOf(admin)).toString());
    const platform = await Platform.deployed();
    await token.approve(Platform.address, new BN('1000000000'));
    const tx = await platform.deposit(new BN('1000'), new BN('1'));
    const balance = await platform.balanceOf(admin);
    console.log('platform balance:',balance.toString());
    const total = await platform.totalSupply();
    console.log('total:', total);
    await platform.setBuyersLockupPeriod(new BN('120'));
    await platform.setLPLockupPeriod(new BN('120'));
    console.log('lockedup period:', (await platform.buyersLockupPeriod()).toString());

  } catch(err) {
    console.log(err.message);
    console.log(err);
  }
}
