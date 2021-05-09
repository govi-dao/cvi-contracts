pragma solidity 0.7.6;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "./../v4/interfaces/IUniswapOracle.sol";

contract FakeUniswapOracle is IUniswapOracle {

    using SafeMath for uint256;

    uint public constant override PERIOD = 1 hours;

    uint256 public price;
    uint256 public lastPrice;
    uint256 public nextPrice;
    uint32 public override blockTimestampLast;

    function setNextPrice(uint256 _nextPrice) external {
        nextPrice = _nextPrice;
    }

    function update() external override {
        
        uint256 timeElapsed = block.timestamp - blockTimestampLast; // overflow is desired

        // ensure that at least one full period has passed since the last update
        require(timeElapsed >= PERIOD, "Period not elapsed");

        lastPrice = price;
        price = nextPrice;
        blockTimestampLast = uint32(block.timestamp);
    }

    // note this will always return 0 before update has been called successfully for the first time.
    function consult(address token, uint amountIn) external view override returns (uint amountOut) {
        amountOut = price.mul(amountIn);
    }
}