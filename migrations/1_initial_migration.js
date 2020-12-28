const Migrations = artifacts.require('Migrations');

module.exports = function (deployer, network) {
    if (['development', 'develop', 'soliditycoverage','cvidev'].includes(network)) {
        deployer.deploy(Migrations);
    }
};
