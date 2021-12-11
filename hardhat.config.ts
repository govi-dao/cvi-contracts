import '@nomiclabs/hardhat-truffle5';
import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-web3';
import '@nomiclabs/hardhat-ethers';
import '@openzeppelin/hardhat-upgrades';
import '@ethersproject/hardware-wallets';
import 'dotenv/config';
import { task } from 'hardhat/config';

import 'hardhat-contract-sizer';
import '@nomiclabs/hardhat-etherscan';

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task('accounts', 'Prints the list of accounts', async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import("hardhat/config").HardhatUserConfig
 */
module.exports = {
  networks: {
    hardhat: {
      accounts: {
        accountsBalance: "400000000000000000000000000000000000000000000000000"
      },
    },
    live: {
      url: `${process.env.RPC_URL}`,
      gasPrice: 120000000000,
    },
    matic: {
      url: `${process.env.RPC_URL_POLYGON}`,
    },
    dev: {
      url: 'http://localhost:8545',
    },
    staging: {
      url: `http://${process.env.CVI_STAGING_HOST}`,
    },
    matic_dev: {
      url: 'http://localhost:8546',
    },
    matic_staging: {
      url: `http://${process.env.CVI_MATIC_STAGING_HOST}`,
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  },
  solidity: {
    version: '0.8.4',
    settings: {
      optimizer: {
        enabled: true,
        runs: 100,
      },
    },
  },
  mocha: {
    timeout: 30000
  }
};
