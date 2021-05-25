// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity 0.7.6;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "./interfaces/IElasticToken.sol";

contract ElasticToken is IElasticToken, Ownable {

    using SafeMath for uint256;

    uint256 public constant SCALING_FACTOR_DECIMALS = 10**24;
    uint256 public constant DELTA_PRECISION_DECIMALS = 10**18;

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    uint256 public scalingFactor;
    uint256 public initSupply;
    address public rebaser;

    mapping(address => uint256) internal _underlyingBalances;
    mapping(address => mapping(address => uint256)) internal _allowedFragments;

    modifier onlyRebaser() {
        require(msg.sender == rebaser, "Not allowed");
        _;
    }

    modifier validRecipient(address to) {
        require(to != address(0x0), "Zero address");
        _;
    }

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;

        scalingFactor = DELTA_PRECISION_DECIMALS;
    }

    function maxScalingFactor() public view override returns (uint256) {
        // Scaling factor can only go up to 2**256-1 = initSupply * scalingFactor
        return uint256(-1).div(initSupply);
    }

    function _mint(address to, uint256 amount) internal validRecipient(to) {
        _beforeTokenTransfer(address(0), to, amount);

        totalSupply = totalSupply.add(amount);
        uint256 underlyingValue = valueToUnderlying(amount);
        initSupply = initSupply.add(underlyingValue);

        // Make sure init suuply increase keeps scaling factor below max
        require(scalingFactor <= maxScalingFactor(), "Max scaling factor too low");

        _underlyingBalances[to] = _underlyingBalances[to].add(underlyingValue);

        emit Transfer(address(0), to, amount);
    }

    function _burn(address to, uint256 amount) internal validRecipient(to) {
        _beforeTokenTransfer(to, address(0), amount);

        totalSupply = totalSupply.sub(amount);
        uint256 underlyingValue = valueToUnderlying(amount);

        // Note: as initSupply decreases, max sacling factor increases, so no need to test scaling factor against it
        initSupply = initSupply.sub(underlyingValue);

        _underlyingBalances[to] = _underlyingBalances[to].sub(underlyingValue, "Burn amount exceeds balance");

        emit Transfer(to, address(0), amount);
    }

    function transfer(address to, uint256 value) external override validRecipient(to) returns (bool) {
        // Note: As scaling factor grows, dust will be untransferrable
        // Minimum transfer value == scalingFactor / 1e24;

        _beforeTokenTransfer(msg.sender, to, value);

        uint256 underlyingValue = valueToUnderlying(value);
        _underlyingBalances[msg.sender] = _underlyingBalances[msg.sender].sub(underlyingValue);
        _underlyingBalances[to] = _underlyingBalances[to].add(underlyingValue);
        emit Transfer(msg.sender, to, value);

        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override validRecipient(from) validRecipient(to) returns (bool) {
        _beforeTokenTransfer(from, to, value);

        _allowedFragments[from][msg.sender] = _allowedFragments[from][msg.sender].sub(value, "No allowance");

        uint256 underlyingValue = valueToUnderlying(value);
        _underlyingBalances[from] = _underlyingBalances[from].sub(underlyingValue);
        _underlyingBalances[to] = _underlyingBalances[to].add(underlyingValue);
        emit Transfer(from, to, value);

        return true;
    }

    function balanceOf(address who) public view override returns (uint256) {
      return underlyingToValue(_underlyingBalances[who]);
    }

    function balanceOfUnderlying(address who) external view override returns (uint256) {
      return _underlyingBalances[who];
    }

    function allowance(address owner_, address spender) external view override returns (uint256) {
        return _allowedFragments[owner_][spender];
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        _allowedFragments[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function increaseAllowance(address spender, uint256 addedValue) external override returns (bool) {
        _allowedFragments[msg.sender][spender] = _allowedFragments[msg.sender][spender].add(addedValue);
        emit Approval(msg.sender, spender, _allowedFragments[msg.sender][spender]);
        return true;
    }

    function decreaseAllowance(address spender, uint256 subtractedValue) external override returns (bool) {
        uint256 oldValue = _allowedFragments[msg.sender][spender];
        if (subtractedValue >= oldValue) {
            _allowedFragments[msg.sender][spender] = 0;
        } else {
            _allowedFragments[msg.sender][spender] = oldValue.sub(subtractedValue);
        }
        emit Approval(msg.sender, spender, _allowedFragments[msg.sender][spender]);
        return true;
    }

    function setRebaser(address _rebaser) external override onlyOwner {
        rebaser = _rebaser;
    }

    /**
    * @dev The supply adjustment equals (totalSupply * DeviationFromTargetRate) / rebaseLag
    *      Where DeviationFromTargetRate is (MarketOracleRate - targetRate) / targetRate
    *      and targetRate is CpiOracleRate / baseCpi
    */
    function rebase(uint256 indexDelta, bool positive) public override onlyRebaser returns (uint256) {
        if (indexDelta == 0) {
          emit Rebase(block.timestamp, scalingFactor, scalingFactor);
          return totalSupply;
        }

        uint256 prevScalingFactor = scalingFactor;

        if (!positive) {
            // Negative rebase, decrease scaling factor
            scalingFactor = scalingFactor.mul(DELTA_PRECISION_DECIMALS.sub(indexDelta)).div(DELTA_PRECISION_DECIMALS);
        } else {
            // Positive reabse, increase scaling factor
            uint256 newScalingFactor = scalingFactor.mul(DELTA_PRECISION_DECIMALS.add(indexDelta)).div(DELTA_PRECISION_DECIMALS);
            if (newScalingFactor < maxScalingFactor()) {
                scalingFactor = newScalingFactor;
            } else {
                scalingFactor = maxScalingFactor();
            }
        }

        totalSupply = underlyingToValue(initSupply);

        emit Rebase(block.timestamp, prevScalingFactor, scalingFactor);
        return totalSupply;
    }

    function underlyingToValue(uint256 unerlyingValue) public override view returns (uint256) {
        return unerlyingValue.mul(scalingFactor).div(SCALING_FACTOR_DECIMALS);
    }

    function valueToUnderlying(uint256 value) public override view returns (uint256) {
        return value.mul(SCALING_FACTOR_DECIMALS).div(scalingFactor);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal virtual {}
}
