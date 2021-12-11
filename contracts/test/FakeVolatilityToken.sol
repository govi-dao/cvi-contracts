// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8;
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../ElasticToken.sol";

contract FakeVolatilityToken is Initializable, ElasticToken {
    bool public rebased = false;
    
    function initialize(string memory _lpTokenName, string memory _lpTokenSymbolName) public initializer {
        ElasticToken.__ElasticToken_init(_lpTokenName, _lpTokenSymbolName, 18);
    }    

    // If not rebaser, the rebase underlying method will revert
    function rebaseCVI() external onlyRebaser {
        rebased = true;
    }
}
