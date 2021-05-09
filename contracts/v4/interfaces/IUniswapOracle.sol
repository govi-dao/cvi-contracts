pragma solidity 0.7.6;

interface IUniswapOracle {
    function update() external;
    function consult(address token, uint amountIn) external view returns (uint amountOut);

    function blockTimestampLast() external view returns (uint32);

    function PERIOD() external returns (uint);
}