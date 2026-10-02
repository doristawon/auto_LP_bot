export const POOL_KEY_TUPLE = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

export const REGISTRY_ABI = [
  'function activePools() view returns (tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bytes32 id,bool active)[])'
];

export const HOOK_ABI = [
  'function poolManager() view returns(address)',
  'function rangeState(uint256) view returns(uint128 liquidity)',
  `function rangeKey(uint256) view returns(${POOL_KEY_TUPLE} key,int24 tickLower,int24 tickUpper,bool exists)`,
  'function balanceOf(address,uint256) view returns(uint256)',
  'function userPosition(uint256,address) view returns(tuple(uint128 staked,uint128 owed0,uint128 owed1,uint256 checkpoint0X128,uint256 checkpoint1X128,uint256 stakedCheckpoint0X128,uint256 stakedCheckpoint1X128,uint256 forgone0,uint256 forgone1))',
  'function paused() view returns(bool)',
  `function deposit(${POOL_KEY_TUPLE} key,int24 tickLower,int24 tickUpper,uint128 liquidity,uint128 amount0Max,uint128 amount1Max,uint256 deadline)`,
  `function claimFees(${POOL_KEY_TUPLE} key,int24 tickLower,int24 tickUpper,address recipient,uint16 walk)`,
  `function withdrawAndClaim(${POOL_KEY_TUPLE} key,int24 tickLower,int24 tickUpper,uint128 liquidity,address recipient,uint128 amount0Min,uint128 amount1Min,uint256 deadline,uint16 walk)`
];

export const V4_QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)',
  'function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns(uint256 amountOut,uint256 gasEstimate)'
];

export const POOL_MANAGER_ABI = [
  'function extsload(bytes32,uint256) view returns(bytes32[])'
];

export const ERC20_ABI = [
  'function symbol() view returns(string)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)'
];

export const DEPOSITED_EVENT = 'Deposited(address,uint256,uint128)';
export const WITHDRAWN_EVENT = 'Withdrawn(address,uint256,uint128)';
export const FEES_COLLECTED_EVENT = 'FeesCollected(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint128,uint128,uint64,uint64)';
export const V4_SWAP_EVENT = 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)';


export const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'
];

export const PERMIT2_ABI = [
  'function allowance(address user,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)'
];

export const EIP7702_GUARD_ABI = [
  `function guardVersion() view returns(bytes32)`,
  `function IMPLEMENTATION() view returns(address)`,
  'function isValidSignature(bytes32 digest,bytes signature) view returns(bytes4)',
  `function guardedWithdrawAndClaim(${POOL_KEY_TUPLE} key,int24 tickLower,int24 tickUpper,uint128 liquidity,address recipient,uint128 amount0Min,uint128 amount1Min,uint256 deadline,uint16 walk)`,
  `function atomicSwapAndDeposit((${POOL_KEY_TUPLE} key,int24 tickLower,int24 tickUpper,uint256 expectedBalance0,uint256 expectedBalance1,uint128 funding0,uint128 funding1,uint8 tokenIn,bytes32 swapPoolId,uint128 amountIn,uint128 minOut,uint128 minLiquidity,uint16 maxResidualBps,uint256 deadline,bytes routerData) plan)`,
  'function guardedRepositionAndClaim((uint256 expectedBalance0,uint256 expectedBalance1,uint256 funding0,uint256 funding1,int24[] claimLower,int24[] claimUpper,uint16 walk,uint16 maxResidualBps,bytes routerData) plan)',
  'event OfficialRepositioned(bytes32 indexed poolId,uint256 indexed oldRangeId,uint256 indexed newRangeId,uint128 liquidity,uint256 claimed0,uint256 claimed1,uint256 residual0,uint256 residual1)',
  'event AtomicDeposited(bytes32 indexed poolId,uint128 liquidity,uint128 funding0,uint128 funding1,uint256 residual0,uint256 residual1)'
];
