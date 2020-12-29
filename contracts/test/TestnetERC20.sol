// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract TestnetERC20 is ERC20, Ownable {

    mapping(address => bool) public whitelistedAddresses;

    mapping(address => uint8) public faucetDrips;

    uint8 public maxDripsPerAddress = 1;
    uint public dripSize = 10000;
    uint public dripCost = 0;

    address public manager;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) public ERC20(_name, _symbol) {
        _setupDecimals(_decimals);
        uint initialDrip = dripSize * 1000 * 10 ** uint(decimals());
        _mint(msg.sender, initialDrip);
    }

    function faucet() public payable {
        require(faucetDrips[msg.sender] < maxDripsPerAddress);
        require(msg.value >= dripCost, "Insufficient value for drip");
        uint amountToDrip = dripSize * 10 ** uint(decimals());
        faucetDrips[msg.sender]++;
        _mint(msg.sender, amountToDrip);
    }

    function setMaxDrips(uint8 _max) public onlyOwner {
        maxDripsPerAddress = _max;
    }

    function setDripSize(uint _size) public onlyOwner {
        dripSize = _size;
    }

    function setManager(address _manager) public onlyOwner {
        manager = _manager;
    }

    function setDripCost(uint _cost) public onlyOwner {
        dripCost = _cost;
    }

    function addToWhitelist(address _participant) public onlyOwner {
        whitelistedAddresses[_participant] = true;
    }

    function _beforeTokenTransfer(address _from, address _to, uint) internal override {
        require(_from == address(0) || whitelistedAddresses[_from] == true || whitelistedAddresses[_to] == true, "Unapproved transfer");
    }
}

