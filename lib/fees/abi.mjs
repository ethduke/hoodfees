import { parseAbi } from "viem";
export const bagsFactoryAbi = parseAbi([
  "function allTokensLength() view returns (uint256)",
  "function getTokens(uint256 offset,uint256 limit) view returns (address[])",
  "function feeShareForToken(address token) view returns (address)",
  "function curveForToken(address token) view returns (address)",
  "function feeShareBeacon() view returns (address)",
  "function hook() view returns (address)",
]);
export const bagsFeeAbi = parseAbi([
  "function claim(bool unwrap)",
  "function claimable(address user) view returns (uint256)",
  "function claimerBps(address user) view returns (uint16)",
  "function PARTNER() view returns (address)",
  "function WETH() view returns (address)",
  "function hook() view returns (address)",
  "function poolId() view returns (bytes32)",
  "function bondingCurve() view returns (address)",
  "event Claimed(address indexed user,uint256 amount,bool unwrap)",
]);
export const bagsBeaconAbi = parseAbi(["function implementation() view returns (address)"]);
export const bagsCurveAbi = parseAbi(["function TOKEN() view returns (address)"]);
export const bagsHookAbi = parseAbi(["function sweep(bytes32 poolId)"]);
export const bankrHookAbi = parseAbi(["function INITIALIZER() view returns (address)"]);
export const o1Legacy = parseAbi([
  "function claim(address recipient,address currency)",
  "function owed(address recipient,address currency) view returns (uint256)",
  "event Credited(address indexed recipient,address indexed currency,uint256 amount)",
  "event Claimed(address indexed recipient,address indexed currency,uint256 amount)",
]);
export const o1Current = parseAbi([
  "function claimFor(address recipient,address currency)",
  "function owed(address recipient,address currency) view returns (uint256)",
  "event Credited(address indexed recipient,address indexed currency,uint256 amount)",
  "event Claimed(address indexed recipient,address indexed currency,address indexed destination,uint256 amount)",
]);
export const ponsEscrow = parseAbi([
  "function claim(uint256 amount) returns (uint256)",
  "function claimToken(address token,uint256 amount) returns (uint256)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient,address token) view returns (uint256)",
  "event Claimed(address indexed recipient,uint256 amount)",
  "event ClaimedToken(address indexed recipient,address indexed token,uint256 amount)",
  "event Credited(address indexed recipient,address indexed depositor,uint256 amount)",
  "event CreditedToken(address indexed recipient,address indexed token,address indexed depositor,uint256 amount)",
]);
// Adapted from fungun's reviewed Long ABI and beneficiary-discovery adapter.
export const longAbi = parseAbi([
  "struct PoolKey {address currency0;address currency1;uint24 fee;int24 tickSpacing;address hooks;}",
  "struct BeneficiaryData {address beneficiary;uint96 shares;}",
  "function getState(address asset) view returns (address numeraire,uint256 totalTokensOnBondingCurve,address dopplerHook,bytes graduationDopplerHookCalldata,uint8 status,PoolKey poolKey,int24 farTick)",
  "function getPoolKey(bytes32 poolId) view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)",
  "function getShares(bytes32 poolId,address beneficiary) view returns (uint256)",
  "function getCumulatedFees0(bytes32 poolId) view returns (uint256)",
  "function getCumulatedFees1(bytes32 poolId) view returns (uint256)",
  "function getLastCumulatedFees0(bytes32 poolId,address beneficiary) view returns (uint256)",
  "function getLastCumulatedFees1(bytes32 poolId,address beneficiary) view returns (uint256)",
  "function collectFees(bytes32 poolId) returns (uint128 fees0,uint128 fees1)",
  "event Lock(address indexed pool,BeneficiaryData[] beneficiaries)",
  "event UpdateBeneficiary(bytes32 poolId,address oldBeneficiary,address newBeneficiary)",
  "event Release(bytes32 indexed poolId,address indexed beneficiary,uint256 fees0,uint256 fees1)",
]);
export const ponsFactoryAbi = parseAbi([
  "struct LaunchedToken {address token;address curve;address deployer;address creatorFeeRecipient;address pairToken;uint256 graduationThreshold;uint24 poolFee;int24 tickSpacing;uint16 creatorTaxBps;bool buybackEnabled;uint8 phase;uint256 sweptQuote;uint256 sweptTokens;uint256 sweptAt;bool exists;}",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
  "event CreatorFeeRecipientUpdated(address indexed token,address indexed previousRecipient,address indexed newRecipient)",
]);
export const ponsV1Abi = parseAbi([
  "struct V1Launch {address token;address deployer;address pairedToken;address positionManager;uint256 positionId;uint256 dexId;uint256 launchConfigId;uint256 restrictionsEndBlock;uint256 supply;bool isToken0;uint24 poolFee;bool exists;uint256 initialBuyAmount;}" ,
  "function getLaunchedToken(address token) view returns (V1Launch)",
  "function collectFees(address token) returns (uint256 amount0,uint256 amount1)",
  "function feeRedirects(address token) view returns (address)",
  "function feeRecipientTokenCount(address wallet) view returns (uint256)",
  "function feeRecipientTokens(address wallet,uint256 index) view returns (address)",
  "function deployerTokenCount(address wallet) view returns (uint256)",
  "function deployerTokens(address wallet,uint256 index) view returns (address)",
  "function tokenProtocolFeeShares(address token) view returns (uint256)",
  "event PositionLocked(address indexed token,address indexed deployer,uint256 indexed dexId,address pairToken,uint256 positionId,address positionManager)",
  "event FeeRedirectUpdated(address indexed token,address indexed newFeeWallet)",
  "event FeesClaimed(address indexed token,address indexed caller,address token0,address token1,uint256 recipientAmount0,uint256 recipientAmount1,uint256 protocolAmount0,uint256 protocolAmount1)",
]);
export const ponsCurveAbi = parseAbi([
  "function deployer() view returns (address)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint16)",
  "function graduated() view returns (bool)",
]);
export const ponsHookAbi = parseAbi([
  "function launches(bytes32 poolId) view returns (bool registered,bool memecoinIsCurrency0,address memecoin,address quoteToken,address creator,address buybackCreatorRecipient,address protocolFeeRecipient,uint16 creatorTaxBps,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps,bool buybackEnabled)",
  "function pendingFees(bytes32 poolId,address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId,address currency) view returns (uint256)",
  "function pendingBuyback(bytes32 poolId,address currency) view returns (uint256)",
]);
export const pairAbi = parseAbi([
  "function claimable(address recipient,address asset) view returns (uint256)",
  "function claim(address asset) returns (uint256 amount)",
  "event FeesClaimed(address indexed recipient,address indexed asset,uint256 amount)",
]);
