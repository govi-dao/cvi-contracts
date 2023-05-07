// import 'tsconfig-paths/register'
import '@nomiclabs/hardhat-truffle5'
import '@nomiclabs/hardhat-waffle'
import '@nomiclabs/hardhat-web3'
import '@nomiclabs/hardhat-ethers'
import '@openzeppelin/hardhat-upgrades'
import 'hardhat-contract-sizer'
import type { HardhatUserConfig } from 'hardhat/config'

function createHardhatConfig(): HardhatUserConfig {
  const compilerVersions = ['0.8.4', '0.6.6', '0.5.16']

  return {
    solidity: {
      compilers: compilerVersions.map(version => ({
        version,
        settings: {
          optimizer: {
            enabled: true,
            runs: 100,
          },
        },
      })),
      settings: {
        outputSelection: {
          '*': {
            '*': ['storageLayout'],
          },
        },
      },
    },
    networks: {
      hardhat: {
        chainId: 10000,
        accounts: {
          count: 20,
          accountsBalance: '400000000000000000000000000000000000000000000000000',
        },
      },
    },
  }
}

export default createHardhatConfig()
