// SPDX-License-Identifier: MIT

pragma solidity 0.7.6;

interface IElasticToken {

    event Rebase(uint256 epoch, uint256 prevScalingFactor, uint256 newScalingFactor);

    event Transfer(address indexed from, address indexed to, uint amount);
    event Approval(address indexed owner, address indexed spender, uint amount);

    function transfer(address to, uint256 value) external returns(bool);
    function transferFrom(address from, address to, uint256 value) external returns(bool);
    function balanceOf(address who) external view returns(uint256);
    function allowance(address owner, address spender) external view returns(uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function increaseAllowance(address spender, uint256 addedValue) external returns (bool);
    function decreaseAllowance(address spender, uint256 subtractedValue) external returns (bool);

    function balanceOfUnderlying(address who) external view returns(uint256);
    function maxScalingFactor() external view returns (uint256);
    function underlyingToValue(uint256 unerlyingValue) external view returns (uint256);
    function valueToUnderlying(uint256 value) external view returns (uint256);

    function rebase(uint256 indexDelta, bool positive) external returns (uint256);
    function setRebaser(address rebaser) external;
}
