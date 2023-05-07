/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
const { toBN, toTokenAmount, toCVI } = require('./BNUtils.js')

const Platform = artifacts.require('Platform')
const PlatformHelper = artifacts.require('PlatformHelper')
const ETHVolOracle = artifacts.require('ETHVolOracle')
const PositionRewards = artifacts.require('PositionRewards')
const FeesCalculator = artifacts.require('FeesCalculator')
const FakeERC20 = artifacts.require('FakeERC20')
const FakePriceProvider = artifacts.require('FakePriceProvider')
const FakeFeesCollector = artifacts.require('FakeFeesCollector')
const Liquidation = artifacts.require('Liquidation')

const RequestFeesCalculator = artifacts.require('RequestFeesCalculator')
const KeepersFeeVault = artifacts.require('KeepersFeeVault')
const VolTokenRequestFulfiller = artifacts.require('VolTokenRequestFulfiller')
const VolatilityToken = artifacts.require('VolatilityToken')
const VolatilityTokenTest = artifacts.require('VolatilityTokenTest')

const ThetaVault = artifacts.require('ThetaVault')
const ThetaVaultRequestFulfiller = artifacts.require('ThetaVaultRequestFulfiller')

const UniswapV2Factory = artifacts.require('UniswapV2Factory')
const UniswapV2Router02 = artifacts.require('UniswapV2Router02')
const UniswapV2Pair = artifacts.require('UniswapV2Pair')

const WETH9 = artifacts.require('WETH9')

const INITIAL_RATE = toBN(1, 12)
const INITIAL_VOL_RATE = toBN(1, 12)
const INITIAL_THETA_RATE = toBN(1, 12)
const ETH_INITIAL_RATE = toBN(1, 3)
const MAX_CVI_VALUE = toBN(22000)

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_UINT256 = toBN(2).pow(toBN(256)).sub(toBN(1))

let contracts = {}

const getAccounts = async () => {
  return web3.eth.getAccounts()
}

let admin

const setAdmin = async () => {
  const accounts = await getAccounts()
  admin = accounts[0]
}

const deployPlatformHelper = async (goviAddress, stakingAddress) => {
  contracts.platformHelper = await PlatformHelper.new(goviAddress, stakingAddress, { from: admin })
  return contracts.platformHelper
}

const deployPlatform = async (
  isETH,
  initialRate = INITIAL_RATE,
  ethIniitalRate = ETH_INITIAL_RATE,
  maxCVIValue = MAX_CVI_VALUE,
) => {
  await setAdmin()

  if (isETH) {
    contracts.platform = await ETHPlatform.new({ from: admin })
    contracts.platform.initialize(
      'ETH-LP',
      'ETH-LP',
      ethIniitalRate,
      maxCVIValue,
      contracts.feesCalculator.address,
      contracts.fakeOracle.address,
      contracts.liquidation.address,
      { from: admin },
    )
    contracts.initialRate = ethIniitalRate
  } else {
    contracts.platform = await Platform.new({ from: admin })
    contracts.platform.initialize(
      contracts.tokenAddress,
      'WETH-LP',
      'WETH-LP',
      initialRate,
      maxCVIValue,
      contracts.feesCalculator.address,
      contracts.fakeOracle.address,
      contracts.liquidation.address,
      { from: admin },
    )
    contracts.initialRate = initialRate
  }

  contracts.maxCVIValue = maxCVIValue
}

const deployFullPlatform = async (isETH, oracleLeverage, token) => {
  await setAdmin()
  contracts = {}

  contracts.isETH = isETH
  contracts.cviToken = await FakeERC20.new('CVI', 'CVI', toTokenAmount(10000000), 18, { from: admin })

  if (!isETH) {
    if (token !== undefined) {
      contracts.token = token
    } else {
      contracts.token = await FakeERC20.new('USDC', 'USDC', toTokenAmount(10000000), 6, { from: admin })
    }
  }

  contracts.tokenAddress = isETH ? ZERO_ADDRESS : contracts.token.address
  contracts.fakePriceProvider = await FakePriceProvider.new(toCVI(10000), { from: admin })
  contracts.fakeOracle = await ETHVolOracle.new(contracts.fakePriceProvider.address, ZERO_ADDRESS, oracleLeverage, {
    from: admin,
  })
  contracts.oracleLeverage = oracleLeverage

  contracts.feesCalculator = await FeesCalculator.new(
    contracts.fakeOracle.address,
    MAX_CVI_VALUE.mul(toBN(oracleLeverage)),
    oracleLeverage,
    { from: admin },
  )
  contracts.fakeFeesCollector = await FakeFeesCollector.new(contracts.tokenAddress, { from: admin })
  contracts.rewards = await PositionRewards.new({ from: admin })
  contracts.rewards.initialize(contracts.cviToken.address, { from: admin })
  contracts.liquidation = await Liquidation.new(MAX_CVI_VALUE.mul(toBN(oracleLeverage)), { from: admin })

  contracts.stakingContractAddress = ZERO_ADDRESS

  await deployPlatform(isETH, undefined, undefined, MAX_CVI_VALUE.mul(toBN(oracleLeverage)))

  await contracts.platform.setMaxAllowedLeverage(8, { from: admin })
  await contracts.platform.setSubContracts(
    contracts.fakeFeesCollector.address,
    contracts.fakeOracle.address,
    ZERO_ADDRESS,
    contracts.liquidation.address,
    contracts.fakeFeesCollector.address,
    { from: admin },
  )
  await contracts.platform.setFeesCalculator(contracts.feesCalculator.address, { from: admin })

  contracts.rewardsAddress = ZERO_ADDRESS

  await contracts.feesCalculator.setStateUpdator(contracts.platform.address, { from: admin })

  let cviValue = toCVI(10000)
  await contracts.fakePriceProvider.setPrice(cviValue)
}

const setupVolTokenContracts = () => {
  contracts.requestFeesCalculator = {}
  contracts.keepersFeeVault = {}
  contracts.volToken = {}
  contracts.requestFulfiller = {}
  contracts.platforms = {}
}

const setupLiquidityProviders = async accounts => {
  for (let account of accounts) {
    await contracts.platform.setAddressSpecificParameters(account, true, true, false, true, { from: admin })
  }
}

const deployVolToken = async (state, margin, isTest = false) => {
  state[margin.toString()] = {}

  state[margin.toString()].volTokenSupply = toBN(0)
  state[margin.toString()].volTokenPositionUnits = toBN(0)
  state[margin.toString()].totalRequestsAmount = toBN(0)

  state[margin.toString()].requests = {}

  contracts.requestFeesCalculator[margin.toString()] = await RequestFeesCalculator.new({ from: admin })
  contracts.keepersFeeVault[margin.toString()] = await KeepersFeeVault.new(contracts.token.address, { from: admin })

  contracts.volToken[margin.toString()] = isTest
    ? await VolatilityTokenTest.new({ from: admin })
    : await VolatilityToken.new({ from: admin })
  await contracts.volToken[margin.toString()].initialize(
    contracts.token.address,
    'CVI-USDC',
    'CVI-USDC',
    1,
    INITIAL_VOL_RATE,
    contracts.platform.address,
    contracts.fakeFeesCollector.address,
    contracts.feesCalculator.address,
    contracts.requestFeesCalculator[margin.toString()].address,
    contracts.fakeOracle.address,
    { from: admin },
  )

  contracts.requestFulfiller[margin.toString()] = await VolTokenRequestFulfiller.new(
    contracts.volToken[margin.toString()].address,
    { from: admin },
  )
  await contracts.volToken[margin.toString()].setFulfiller(contracts.requestFulfiller[margin.toString()].address, {
    from: admin,
  })

  await contracts.volToken[margin.toString()].setKeepersFeeVaultAddress(
    contracts.keepersFeeVault[margin.toString()].address,
    { from: admin },
  )

  await contracts.platform.setAddressSpecificParameters(
    contracts.volToken[margin.toString()].address,
    false,
    true,
    false,
    true,
    { from: admin },
  )

  contracts.platforms[margin.toString()] = contracts.platform

  state[margin.toString()].nextRequestId = toBN(1)
  state[margin.toString()].minRequestId = toBN(1)
  state[margin.toString()].keepersFeeVaultBalance = toBN(0)
}

const setupUniswap = async () => {
  contracts.weth = await WETH9.new({ from: admin })
  contracts.factory = await UniswapV2Factory.new(admin, { from: admin })
  contracts.router = await UniswapV2Router02.new(contracts.factory.address, contracts.weth.address, { from: admin })
}

const setupThetaVaultContracts = () => {
  contracts.volTokenPair = {}
  contracts.thetaVault = {}
  contracts.thetaRequestFulfiller = {}
}

const deployThetaVault = async (state, margin, accountsUsed) => {
  state[margin.toString()].thetaTokenSupply = toBN(0)
  state[margin.toString()].totalDepositRequestsAmount = toBN(0)
  state[margin.toString()].totalVaultLeveragedAmount = toBN(0)
  state[margin.toString()].nextRequestId = toBN(1)
  state[margin.toString()].minRequestId = toBN(1)
  state[margin.toString()].dexUSDCAmount = toBN(0)
  state[margin.toString()].dexVolTokenAmount = toBN(0)
  state[margin.toString()].dexVolTokenUnerlyingAmount = toBN(0)
  state[margin.toString()].dexPairVaultBalance = toBN(0)
  state[margin.toString()].dexPairTotalSupply = toBN(0)
  state[margin.toString()].platformLPTokensVaultBalance = toBN(0)
  state[margin.toString()].totalHoldingsAmount = toBN(0)

  state[margin.toString()].thetaTokenBalances = {}

  for (let account of accountsUsed) {
    state[margin.toString()].thetaTokenBalances[account] = toBN(0)
  }

  await setupUniswap()

  await contracts.factory.createPair(contracts.volToken[margin.toString()].address, contracts.token.address)
  contracts.volTokenPair[margin.toString()] = await UniswapV2Pair.at(
    await contracts.factory.getPair(contracts.volToken[margin.toString()].address, contracts.token.address),
  )

  contracts.thetaVault[margin.toString()] = await ThetaVault.new({ from: admin })
  await contracts.thetaVault[margin.toString()].initialize(
    INITIAL_THETA_RATE,
    contracts.platform.address,
    contracts.volToken[margin.toString()].address,
    '0x0000000000000000000000000000000000000001', //TODO: Temp, deploy staking contracts
    contracts.token.address,
    contracts.router.address,
    'CVI-THETA',
    'CVI-THETA',
  )

  contracts.thetaRequestFulfiller[margin.toString()] = await ThetaVaultRequestFulfiller.new(
    contracts.thetaVault[margin.toString()].address,
    { from: admin },
  )

  await contracts.volToken[margin.toString()].setMinter(contracts.thetaVault[margin.toString()].address, {
    from: admin,
  })

  await contracts.platform.setLockupPeriods(0, toBN(60 * 60 * 6))

  await contracts.platform.setAddressSpecificParameters(
    contracts.thetaVault[margin.toString()].address,
    true,
    false,
    false,
    true,
    { from: admin },
  )
}

const setStakingContractAddress = async (stakingContractAddress, options) => {
  await contracts.platform.setSubContracts(
    contracts.fakeFeesCollector.address,
    contracts.fakeOracle.address,
    contracts.rewardsAddress,
    contracts.liquidation.address,
    stakingContractAddress,
    options,
  )
}

const setFeesCalculator = async (feesCalculatorAddress, options) => {
  await contracts.platform.setFeesCalculator(feesCalculatorAddress, options)
}

const setRewards = async (rewardsAddress, options) => {
  await contracts.platform.setSubContracts(
    contracts.fakeFeesCollector.address,
    contracts.fakeOracle.address,
    rewardsAddress,
    contracts.liquidation.address,
    contracts.stakingContractAddress,
    options,
  )
}

const setFeesCollector = async (feesCollectorAddress, options) => {
  await contracts.platform.setSubContracts(
    feesCollectorAddress,
    contracts.fakeOracle.address,
    contracts.rewardsAddress,
    contracts.liquidation.address,
    contracts.stakingContractAddress,
    options,
  )
}

const setLiquidation = async (liquidationAddress, options) => {
  await contracts.platform.setSubContracts(
    contracts.fakeFeesCollector.address,
    contracts.fakeOracle.address,
    contracts.rewardsAddress,
    liquidationAddress,
    contracts.stakingContractAddress,
    options,
  )
}

const setOracle = async (oracleAddress, options) => {
  await contracts.platform.setSubContracts(
    contracts.fakeFeesCollector.address,
    oracleAddress,
    contracts.rewardsAddress,
    contracts.liquidation.address,
    contracts.stakingContractAddress,
    options,
  )
}

const getContracts = () => contracts

const setContracts = newContracts => {
  contracts = newContracts
}

exports.deployFullPlatform = deployFullPlatform
exports.deployPlatform = deployPlatform
exports.deployPlatformHelper = deployPlatformHelper
exports.setupVolTokenContracts = setupVolTokenContracts
exports.deployVolToken = deployVolToken
exports.setupThetaVaultContracts = setupThetaVaultContracts
exports.setupLiquidityProviders = setupLiquidityProviders
exports.deployThetaVault = deployThetaVault
exports.getContracts = getContracts
exports.setContracts = setContracts
exports.setFeesCalculator = setFeesCalculator
exports.setRewards = setRewards
exports.setFeesCollector = setFeesCollector
exports.setLiquidation = setLiquidation
exports.setOracle = setOracle
exports.setStakingContractAddress = setStakingContractAddress
exports.getAccounts = getAccounts
exports.INITIAL_VOL_RATE = INITIAL_VOL_RATE
exports.INITIAL_THETA_RATE = INITIAL_THETA_RATE
exports.ZERO_ADDRESS = ZERO_ADDRESS
exports.MAX_UINT256 = MAX_UINT256
