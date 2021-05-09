const liveContracts = require(`../../output/contracts.live.json`);

const saveContracts = (network, contracts) => {
  if(! process.env.SAVE_CONTRACTS) {
    console.log('Skip saving contracts file');
    return;
  }

  const CONTRACTS_FILE = `./output/contracts.${network}.json`;
  const fs = require('fs');
  if (fs.existsSync(CONTRACTS_FILE)) {
    // const existingFile = require(CONTRACTS_FILE);
    console.log('> Contracts writing: ' + CONTRACTS_FILE);
    fs.writeFileSync(CONTRACTS_FILE, JSON.stringify({...liveContracts,...contracts}));
  } else {
    console.log('Skip updating contracts file - Could not find existing contracts file: ', CONTRACTS_FILE);
  }
};

const DEPLOYER_ADDRESS = '0xCedAD8C0Ae5e0a878c01cC8c81E0Ca2DbA909deD';

exports.saveContracts = saveContracts;
exports.DEPLOYER_ADDRESS = DEPLOYER_ADDRESS;
