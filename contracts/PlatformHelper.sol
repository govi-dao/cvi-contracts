
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./interfaces/IStaking.sol";
import "./interfaces/IPlatformHelper.sol";

contract PlatformHelper is Initializable, IPlatformHelper {
    uint16 private constant MAX_PERCENTAGE = 10000;

    IERC20 private govi;
    IStaking private staking;


    function initialize(IERC20 _govi, IStaking _staking) public initializer {
        govi = _govi;
        staking = _staking;
    }

    function dailyFundingFee(IPlatform _platform) external view override returns (uint256 fundingFeePercent) {
        (uint32 cviValue,,) = _platform.cviOracle().getCVILatestRoundData();
        (, fundingFeePercent) = _platform.feesCalculator().calculateSingleUnitPeriodFundingFee(IFeesCalculator.CVIValue(1 days, cviValue), premiumFeeCollateralRatio(_platform));
    }

    function fundingFeeValues(IPlatform _platform, uint32 _minCVI, uint32 _maxCVI, uint256 _minCollateral, uint256 _maxCollateral) external view override returns (uint256[][] memory fundingFeeRatePercent) {
        fundingFeeRatePercent = new uint256[][](_maxCollateral - _minCollateral + 1);
        uint256 currCollateralIndex = 0;
        for (uint256 currCollateral = _minCollateral; currCollateral <= _maxCollateral; currCollateral += 1) {
            uint256[] memory currValues = new uint256[](_maxCVI - _minCVI + 1);
            uint256 currCVIIndex = 0;
            for (uint32 currCVI = _minCVI * _platform.feesCalculator().oracleLeverage(); currCVI <= _maxCVI * _platform.feesCalculator().oracleLeverage(); currCVI += _platform.feesCalculator().oracleLeverage()) {
                (,uint256 feePercent) = _platform.feesCalculator().calculateSingleUnitPeriodFundingFee(IFeesCalculator.CVIValue(1 days, currCVI * 100), (currCollateral * _platform.PRECISION_DECIMALS()) / 100);
                currValues[currCVIIndex] = feePercent;
                currCVIIndex += 1;
            }
            fundingFeeRatePercent[currCollateralIndex] = currValues;
            currCollateralIndex += 1;
        }
    }

    function premiumFeeCollateralRatio(IPlatform _platform) public view override returns (uint256) {
        if (_platform.totalLeveragedTokensAmount() == 0) {
            return MAX_PERCENTAGE;
        }

        return _platform.feesCalculator().calculateCollateralRatio(_platform.totalLeveragedTokensAmount(), _platform.totalPositionUnitsAmount());
    }

    function collateralRatio(IPlatform _platform) public view override returns (uint256) {
        if (_platform.totalLeveragedTokensAmount() == 0) {
            return MAX_PERCENTAGE;
        }

        return _platform.totalPositionUnitsAmount() * _platform.PRECISION_DECIMALS() / _platform.totalLeveragedTokensAmount();
    }

    function volTokenIntrinsicPrice(IVolatilityToken _volToken) public view override returns (uint256) {
        require(IERC20(address(_volToken)).totalSupply() > 0, "No supply");

        uint256 volTokenBalance = calculateVolTokenPositionBalance(_volToken);

        return volTokenBalance * 10 ** ERC20(address(_volToken)).decimals() / IERC20(address(_volToken)).totalSupply();
    }

    function volTokenDexPrice(IThetaVault _thetaVault) external view override returns (uint256) {
        (uint256 volTokenAmount, uint256 usdcAmount) = _thetaVault.getReserves();
        require(volTokenAmount > 0 && usdcAmount > 0, "No liquidity");
        return usdcAmount * 10 ** ERC20(address(_thetaVault.volToken())).decimals() / volTokenAmount;
    }

    function maxWithdrawAmount(IThetaVault _thetaVault) external view override returns (uint256 maxAmount, uint256 maxUSDCAmount) {
        (uint256 totalBalance,,,,,) =_thetaVault.totalBalance();
        uint256 totalSupply = IERC20(address(_thetaVault)).totalSupply();
        uint256 totalLeveragedTokensAmount = _thetaVault.volToken().platform().totalLeveragedTokensAmount();
        uint256 maxPlatformWithdraw = totalLeveragedTokensAmount - _thetaVault.volToken().platform().totalPositionUnitsAmount();
        maxAmount = maxPlatformWithdraw * totalSupply / totalLeveragedTokensAmount;
        maxUSDCAmount = maxAmount * totalBalance / totalSupply;
    }

    function _simulateMint(uint256 _totalUnits, uint256 _totalTokens, uint256 _units, uint256 _amount) internal pure returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        newTotalUnits = _totalUnits + _units;
        newTotalTokens = _totalTokens + _amount;
    }

    function _simulateBurn(uint256 _totalUnits, uint256 _totalTokens, uint256 _units, uint256 _amount) internal pure returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        newTotalUnits = _totalUnits - _units;
        newTotalTokens = _totalTokens - _amount;
    }

    function _simulatePlatformDeposit(uint256 _totalUnits, uint256 _totalTokens, uint256 _amount) internal pure returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        newTotalUnits = _totalUnits;
        newTotalTokens = _totalTokens + _amount;
    }

    function _simulatePlatformWithdraw(uint256 _totalUnits, uint256 _totalTokens, uint256 _amount) internal pure returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        newTotalUnits = _totalUnits;
        newTotalTokens = _totalTokens - _amount;
    }

    function _simulateThetaDeposit(IThetaVault _thetaVault, uint256 _totalUnits, uint256 _totalTokens, uint256 _amount) internal view returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        uint256 liquidityAmount = _getLiquidityAmount(_thetaVault, _amount);
        (uint256 units, uint256 tokens) = _getPositionAmount(_thetaVault, _amount);

        (newTotalUnits, newTotalTokens) = _simulatePlatformDeposit(_totalUnits, _totalTokens, liquidityAmount);
        (newTotalUnits, newTotalTokens) = _simulateMint(newTotalUnits, newTotalTokens, units, tokens);
    }

    function _simulateThetaWithdraw(IThetaVault _thetaVault, uint256 _totalUnits, uint256 _totalTokens, uint256 _amount) internal view returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        uint256 liquidityAmount = _getLiquidityAmount(_thetaVault, _amount);
        (uint256 units, uint256 tokens) = _getPositionAmount(_thetaVault, _amount);

        (newTotalUnits, newTotalTokens) = _simulateBurn(_totalUnits, _totalTokens, units, tokens);
        (newTotalUnits, newTotalTokens) = _simulatePlatformWithdraw(newTotalUnits, newTotalTokens, liquidityAmount);
    }

    function _getLiquidityAmount(IThetaVault _thetaVault, uint256 _thetaAmount) internal view returns (uint256 liquidityAmount) {
        IPlatform platform = _thetaVault.volToken().platform();
        uint256 totalSupply = IERC20(address(_thetaVault)).totalSupply();
        uint256 thetaLPBalance = IERC20(address(platform)).balanceOf(address(_thetaVault));
        uint256 platformLPTokens = _thetaAmount * thetaLPBalance / totalSupply;
        uint256 totalPlatformBalance = platform.totalBalance(true);
        uint256 totalPlatformSupply = IERC20(address(platform)).totalSupply();
        return platformLPTokens * totalPlatformBalance / totalPlatformSupply;
    }

    function _getPositionAmount(IThetaVault _thetaVault, uint256 _thetaAmount) internal view returns (uint256 units, uint256 tokens) { 
        IVolatilityToken volToken = _thetaVault.volToken();
        IPlatform platform = volToken.platform();
        uint256 totalSupply = IERC20(address(_thetaVault)).totalSupply();
        uint256 totalVolTokenSupply = IERC20(address(volToken)).totalSupply();
        (uint256 volTokenAmount, ) = _thetaVault.getReserves();
        uint256 volTokensToBurn = _thetaAmount * volTokenAmount  / totalSupply;
        uint volTokenPositionBalance = calculateVolTokenPositionBalance(volToken);
        (uint256 totalVolTokenPosUnits,,,,) = platform.positions(address(volToken));
        units = volTokensToBurn * totalVolTokenPosUnits / totalVolTokenSupply;
        tokens = volTokenPositionBalance * volTokensToBurn / totalVolTokenSupply;
    }

    function _simulateRebalance(IThetaVault _thetaVault, uint256 _totalUnits, uint256 _totalTokens) internal view returns (uint256 newTotalUnits, uint256 newTotalTokens) {
        uint256 adjustedPositionUnits = _totalUnits * (MAX_PERCENTAGE + _thetaVault.extraLiqidityPercentage()) / MAX_PERCENTAGE;
        if (_totalTokens > adjustedPositionUnits) {
            uint256 extraLiquidityAmount = _totalTokens - adjustedPositionUnits;

            (newTotalUnits, newTotalTokens) = _simulatePlatformWithdraw(_totalUnits, _totalTokens, extraLiquidityAmount);
            (newTotalUnits, newTotalTokens) = _simulateThetaDeposit(_thetaVault, newTotalUnits, newTotalTokens, extraLiquidityAmount);
        } else {
            uint256 liquidityMissing = adjustedPositionUnits - _totalTokens;
            (uint256 balance,, uint256 intrinsicDEXVolTokenBalance,, uint256 dexUSDCAmount,) = _thetaVault.totalBalance();

            if (intrinsicDEXVolTokenBalance + dexUSDCAmount > liquidityMissing && 
                (intrinsicDEXVolTokenBalance + dexUSDCAmount - liquidityMissing) * MAX_PERCENTAGE / balance >= _thetaVault.minDexPercentageAllowed()) {

                (uint256 units, uint256 tokens) = _getPositionAmount(_thetaVault, liquidityMissing);
                (newTotalUnits, newTotalTokens) = _simulateBurn(_totalUnits, _totalTokens, units, tokens);
                (newTotalUnits, newTotalTokens) =  _simulatePlatformDeposit(newTotalUnits, newTotalTokens, liquidityMissing);
            }
        }
    }

    function willWithdrawSucceed(IThetaVault _thetaVault, uint256 _withdrawAmount) external view override returns (bool success) {
        IPlatform platform = _thetaVault.volToken().platform();

        uint256 totalPositionUnitsAmount = platform.totalPositionUnitsAmount();
        uint256 totalLeveragedTokensAmount = platform.totalLeveragedTokensAmount();

        (totalPositionUnitsAmount, totalLeveragedTokensAmount) = _simulateRebalance(_thetaVault, totalPositionUnitsAmount, totalLeveragedTokensAmount);
        (totalPositionUnitsAmount, totalLeveragedTokensAmount) = _simulateThetaWithdraw(_thetaVault, totalPositionUnitsAmount, totalLeveragedTokensAmount, _withdrawAmount);
        return totalLeveragedTokensAmount >= totalPositionUnitsAmount;
    }

    function maxMintAmount(IVolatilityToken _volToken) external view override returns (uint256 maxAmount) {
        (uint32 cviValue,,) = _volToken.platform().cviOracle().getCVILatestRoundData();
        (uint256 totalPositionUnitsAmount, uint256 totalLeveragedTokensAmount,) = calculateLiquidity(_volToken, 0, 0, 0);
        maxAmount = (totalLeveragedTokensAmount - totalPositionUnitsAmount) * cviValue / _volToken.platform().maxCVIValue();
    }

    function calculateLiquidity(IVolatilityToken _volToken, uint256 _tokenAmount, uint256 _openPositionFee, uint256 _buyingPremiumFee) private view returns (uint256 totalPositionUnitsAmount, uint256 totalLeveragedTokensAmount, bool insufficientLiquidity) {
        (uint32 cviValue,,) = _volToken.platform().cviOracle().getCVILatestRoundData();
        uint256 positionedTokenAmount = (_tokenAmount - _openPositionFee - _buyingPremiumFee) * _volToken.leverage();
        uint256 positionUnitsAmount = uint256(positionedTokenAmount) * _volToken.platform().maxCVIValue() / cviValue;
        totalPositionUnitsAmount = _volToken.platform().totalPositionUnitsAmount() + positionUnitsAmount;
        totalLeveragedTokensAmount = _volToken.platform().totalLeveragedTokensAmount() + positionedTokenAmount + _buyingPremiumFee;
        insufficientLiquidity = totalPositionUnitsAmount > totalLeveragedTokensAmount;
    }

    function calculateCommonFees(IVolatilityToken _volToken, bool _isKeepers, uint256 _tokenAmount, uint256 _timeWindow) private view returns (uint256 timeWindowFee, uint256 keepersFee) {
        timeWindowFee = _tokenAmount * _volToken.requestFeesCalculator().calculateTimeDelayFee(_timeWindow) / MAX_PERCENTAGE;
        keepersFee = _isKeepers ? _volToken.requestFeesCalculator().calculateKeepersFee(_tokenAmount) : 0; 
    }

    function calculatePenaltyFee(IVolatilityToken _volToken, bool _isKeepers, IVolatilityToken.Request memory _request, uint256 _tokenAmount) private view returns (uint256 timePenaltyFee) {
        timePenaltyFee = 0;
        if (!_isKeepers && (block.timestamp > _request.requestTimestamp + _volToken.requestFeesCalculator().minWaitTime() && block.timestamp < _request.targetTimestamp)) {
            timePenaltyFee = _tokenAmount * _volToken.requestFeesCalculator().calculateTimePenaltyFee(_request) / MAX_PERCENTAGE;
        }
    }

    function calculateMintFees(IVolatilityToken _volToken, uint256 _tokenAmount) private view returns (uint256 openPositionFee, uint256 buyingPremiumFee, uint buyingPremiumFeePercentage) {
        openPositionFee = _tokenAmount * _volToken.platform().feesCalculator().openPositionFeePercent() * _volToken.leverage() / MAX_PERCENTAGE;

        (uint32 cviValue,,) = _volToken.platform().cviOracle().getCVILatestRoundData();

        uint256 lastLeveragedTokensAmount = _volToken.platform().totalLeveragedTokensAmount();
        uint256 lastTotalPositionUnitsAmount =  _volToken.platform().totalPositionUnitsAmount();

        uint256 maxPositionUnitsAmount = (_tokenAmount - openPositionFee) * _volToken.leverage() * _volToken.platform().maxCVIValue() / cviValue;
        uint256 totalPositionUnitsAmount = _volToken.platform().totalPositionUnitsAmount() + maxPositionUnitsAmount;
        uint256 leveragedTokensAmount = _volToken.platform().totalLeveragedTokensAmount() + (_tokenAmount - openPositionFee) * _volToken.leverage();

        (buyingPremiumFee, buyingPremiumFeePercentage) = 
            _volToken.platform().feesCalculator().calculateBuyingPremiumFee(uint168(_tokenAmount), _volToken.leverage(), 
                lastLeveragedTokensAmount, lastTotalPositionUnitsAmount, leveragedTokensAmount, totalPositionUnitsAmount);
    }

    function calculateBurnFees(IVolatilityToken _volToken, uint256 _volTokensAmount) private view returns (uint256 burnUSDCAmountBeforeFees, uint256 closeFee) {
        burnUSDCAmountBeforeFees = _volTokensAmount * calculateVolTokenPositionBalance(_volToken) / IERC20(address(_volToken)).totalSupply();
        closeFee = burnUSDCAmountBeforeFees * (_volToken.platform().feesCalculator().closePositionLPFeePercent() + 
            _volToken.platform().feesCalculator().calculateClosePositionFeePercent(0, true)) / MAX_PERCENTAGE;
    }

    function calculatePreMint(IVolatilityToken _volToken, bool _isKeepers, uint256 _usdcAmount, uint256 _timeWindow) external view override returns (PreMintResult memory result) {
        (result.timeWindowFee, result.keepersFee) = calculateCommonFees(_volToken, _isKeepers, _usdcAmount, _timeWindow);
        result.netMintAmount = _usdcAmount - result.timeWindowFee - result.keepersFee;

        (result.openPositionFee, result.buyingPremiumFee, result.buyingPremiumFeePercentage) = calculateMintFees(_volToken, _usdcAmount);
        result.netMintAmount = result.netMintAmount - result.openPositionFee - uint168(result.buyingPremiumFee);

        uint256 supply = IERC20(address(_volToken)).totalSupply();
        uint256 balance = calculateVolTokenPositionBalance(_volToken);
        if (supply > 0 && balance > 0) {
            result.expectedVolTokensAmount = uint256(result.netMintAmount) * supply / balance;
        } else {
            result.expectedVolTokensAmount = uint256(result.netMintAmount) * _volToken.initialTokenToLPTokenRate();
        }
    }

    function checkMintRequest(IVolatilityToken _volToken, uint256 _requestId, bool _isKeepers) external view override returns (CheckMintResult memory result) {
        IVolatilityToken.Request memory request; 
        (request.requestType, request.tokenAmount,,,, request.requestTimestamp, request.targetTimestamp, request.useKeepers, request.maxBuyingPremiumFeePercentage) = _volToken.requests(_requestId);
        require(request.requestType == 1, 'Invalid request id');

        uint256 timeWindowFee;
        (timeWindowFee, result.keepersFee) = calculateCommonFees(_volToken, _isKeepers, request.tokenAmount, request.targetTimestamp - request.requestTimestamp);
        result.timePenaltyFee = calculatePenaltyFee(_volToken, _isKeepers, request, request.tokenAmount);
        result.netMintAmount = request.tokenAmount - timeWindowFee - result.keepersFee - result.timePenaltyFee;

        (result.openPositionFee, result.buyingPremiumFee, result.buyingPremiumFeePercentage) = calculateMintFees(_volToken, request.tokenAmount);
        result.netMintAmount = result.netMintAmount - uint168(result.openPositionFee) - uint168(result.buyingPremiumFee);

        (,, result.insufficientLiquidity) = calculateLiquidity(_volToken, request.tokenAmount, result.openPositionFee, result.buyingPremiumFee);
        result.insufficientSlippage = result.buyingPremiumFeePercentage > request.maxBuyingPremiumFeePercentage;

        uint256 supply = IERC20(address(_volToken)).totalSupply();
        uint256 balance = calculateVolTokenPositionBalance(_volToken);
        if (supply > 0 && balance > 0) {
            result.expectedVolTokensAmount = uint256(result.netMintAmount) * supply / balance;
        } else {
            result.expectedVolTokensAmount = uint256(result.netMintAmount) * _volToken.initialTokenToLPTokenRate();
        }
    }

    function calculatePreBurn(IVolatilityToken _volToken, bool _isKeepers, uint256 _volTokensAmount, uint256 _timeWindow) external view override returns (PreBurnResult memory result) {
        uint256 burnUSDCAmountBeforeFees;
        (burnUSDCAmountBeforeFees, result.closeFee) = calculateBurnFees(_volToken, _volTokensAmount);
        result.expectedUSDCAmount = burnUSDCAmountBeforeFees - result.closeFee;

        (result.timeWindowFee, result.keepersFee) = calculateCommonFees(_volToken, _isKeepers, result.expectedUSDCAmount, _timeWindow);

        result.expectedUSDCAmount = result.expectedUSDCAmount - result.timeWindowFee - result.keepersFee;
        result.netBurnAmount = _volTokensAmount * result.expectedUSDCAmount / burnUSDCAmountBeforeFees;
    }

    function checkBurnRequest(IVolatilityToken _volToken, uint256 _requestId, bool _isKeepers) external view override returns (CheckBurnResult memory result) {
        IVolatilityToken.Request memory request; 
        (request.requestType, request.tokenAmount,,,, request.requestTimestamp, request.targetTimestamp, request.useKeepers,) = _volToken.requests(_requestId);
        require(request.requestType == 2, 'Invalid request id');

        uint256 tokenAmount = IElasticToken(address(_volToken)).underlyingToValue(request.tokenAmount);

        uint256 burnUSDCAmountBeforeFees;
        (burnUSDCAmountBeforeFees, result.closeFee) = calculateBurnFees(_volToken, tokenAmount);
        result.expectedUSDCAmount = burnUSDCAmountBeforeFees - result.closeFee;

        result.timePenaltyFee = calculatePenaltyFee(_volToken, _isKeepers, request, burnUSDCAmountBeforeFees);
        uint256 timeWindowFee;
        (timeWindowFee, result.keepersFee) = calculateCommonFees(_volToken, _isKeepers, result.expectedUSDCAmount, request.targetTimestamp - request.requestTimestamp);

        result.expectedUSDCAmount = result.expectedUSDCAmount - timeWindowFee - result.timePenaltyFee - result.keepersFee;
        result.netBurnAmount = tokenAmount * result.expectedUSDCAmount / burnUSDCAmountBeforeFees;
    }

    function convertGOVIToXGOVI(uint256 _goviAmount) external view override returns (uint256 xGOVIAmount) { 
        uint256 totalStaked = govi.balanceOf(address(staking));
        uint256 addedReward = staking.rewardPerSecond() * (block.timestamp - staking.lastUpdateTime());
        uint256 totalSupply = IERC20(address(staking)).totalSupply();
        if (totalStaked + addedReward > 0) {
            xGOVIAmount = _goviAmount * totalSupply / (totalStaked + addedReward);
        }
    }

    function convertXGOVIToGOVI(uint256 _xGOVIAmount) external view override returns (uint256 goviAmount) { 
        uint256 totalStaked = govi.balanceOf(address(staking));
        uint256 addedReward = staking.rewardPerSecond() * (block.timestamp - staking.lastUpdateTime());
        uint256 totalSupply = IERC20(address(staking)).totalSupply();
        if (totalSupply > 0) {
            goviAmount = (totalStaked + addedReward) * _xGOVIAmount / totalSupply;
        }
    }

    function stakedGOVI(address _account) external view override returns (uint256 stakedAmount, uint256 share) {
        stakedAmount = this.convertXGOVIToGOVI(IERC20(address(staking)).balanceOf(_account));
        if (stakedAmount > 0) {
            share = IERC20(address(staking)).balanceOf(_account) * MAX_PERCENTAGE / IERC20(address(staking)).totalSupply();
        }
    }

    function calculateStakingAPR() external view override returns (uint256 apr) {
        uint256 totalStaked = govi.balanceOf(address(staking));
        uint256 periodReward = staking.rewardPerSecond() * 1 days * 365;
        apr = totalStaked == 0 ?  0 : periodReward * MAX_PERCENTAGE / totalStaked;
    }

    function calculateVolTokenPositionBalance(IVolatilityToken _volToken) private view returns (uint256 volTokenBalance) {
        IPlatform platform = _volToken.platform();

        bool isPositive = true;
        (uint256 currPositionUnits,,,,) = platform.positions(address(_volToken));
        if (currPositionUnits != 0) {
            (volTokenBalance, isPositive,,,,) = platform.calculatePositionBalance(address(_volToken));
        }
        require(isPositive, "Negative balance");
    }
}
