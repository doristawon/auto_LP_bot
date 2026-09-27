import { AbiCoder, Interface } from 'ethers';
import { UNIVERSAL_ROUTER_ABI } from '../abi.js';
import { UNISWAP_UNIVERSAL_ROUTER_212, ZERO_ADDRESS } from '../constants.js';
import { buildV4PathKeys } from '../execution/investment-target.js';
import { poolKeyArgs } from './fables.js';

const routerInterface = new Interface(UNIVERSAL_ROUTER_ABI);
const coder = AbiCoder.defaultAbiCoder();
const MAX_UINT128 = (1n << 128n) - 1n;

const COMMAND_V4_SWAP = '0x10';
const ACTIONS_EXACT_IN_SINGLE_SETTLE_TAKE = '0x060c0f';
const EXACT_INPUT_SINGLE =
  'tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)';
const EXACT_INPUT_PATH =
  'tuple(address,tuple(address,uint24,int24,address,bytes)[],uint256[],uint128,uint128)';

export class UniversalRouterAdapter {
  constructor(provider, config, address = UNISWAP_UNIVERSAL_ROUTER_212) {
    this.provider = provider;
    this.config = config;
    this.address = address;
  }

  buildV4ExactInputSingle({ pool, quote, deadline }) {
    if (!quote) throw new Error('A verified V4 quote is required');
    if (pool.token0.address.toLowerCase() === ZERO_ADDRESS || pool.token1.address.toLowerCase() === ZERO_ADDRESS) {
      throw new Error('Native-token V4 swap encoding is not enabled in the minimal router path');
    }
    const amountIn = BigInt(quote.rawAmountIn);
    const minAmountOut = BigInt(quote.minRawAmountOut);
    if (amountIn <= 0n) throw new Error('Swap amountIn must be positive');
    if (minAmountOut <= 0n) throw new Error('Swap minAmountOut must be positive');

    const zeroForOne = Boolean(quote.zeroForOne);
    const tokenIn = zeroForOne ? pool.token0 : pool.token1;
    const tokenOut = zeroForOne ? pool.token1 : pool.token0;
    if (tokenIn.address.toLowerCase() !== String(quote.tokenIn).toLowerCase()) throw new Error('Quote tokenIn does not match pool direction');
    if (tokenOut.address.toLowerCase() !== String(quote.tokenOut).toLowerCase()) throw new Error('Quote tokenOut does not match pool direction');

    const swapParams = [
      poolKeyArgs(pool),
      zeroForOne,
      amountIn,
      minAmountOut,
      0n,
      '0x'
    ];
    const actions = ACTIONS_EXACT_IN_SINGLE_SETTLE_TAKE;
    const params = [
      coder.encode([EXACT_INPUT_SINGLE], [swapParams]),
      coder.encode(['address', 'uint256'], [tokenIn.address, amountIn]),
      coder.encode(['address', 'uint256'], [tokenOut.address, minAmountOut])
    ];
    const v4Input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
    const data = routerInterface.encodeFunctionData('execute', [
      COMMAND_V4_SWAP,
      [v4Input],
      BigInt(deadline)
    ]);
    return {
      router: this.address,
      data,
      value: 0n,
      deadline: Number(deadline),
      commands: COMMAND_V4_SWAP,
      v4Actions: actions,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      zeroForOne
    };
  }

  async simulateV4ExactInputSingle(args) {
    const request = this.buildV4ExactInputSingle(args);
    const from = args.from || this.config.walletAddress;
    const result = await this.provider.call({
      from,
      to: request.router,
      data: request.data,
      value: request.value
    });
    return { ...request, simulationResult: result };
  }

  buildV4ExactInputPath({ route, tokenIn, quote, deadline }) {
    if (!quote) throw new Error('A verified V4 route quote is required');
    if (!Array.isArray(route) || route.length === 0) throw new Error('A non-empty V4 route is required');
    if (!tokenIn?.address || String(tokenIn.address).toLowerCase() === ZERO_ADDRESS) {
      throw new Error('Native-token V4 routes are not enabled');
    }
    const amountIn = BigInt(quote.rawAmountIn);
    const minAmountOut = BigInt(quote.minRawAmountOut);
    if (amountIn <= 0n || amountIn > MAX_UINT128) throw new Error('Swap amountIn must fit uint128');
    if (minAmountOut <= 0n || minAmountOut > MAX_UINT128) throw new Error('Swap minAmountOut must fit uint128');
    if (String(tokenIn.address).toLowerCase() !== String(quote.tokenIn).toLowerCase()) {
      throw new Error('Route quote tokenIn does not match the selected route');
    }
    const path = buildV4PathKeys(route, tokenIn.address);
    const actions = '0x070c0f';
    const params = [
      coder.encode([EXACT_INPUT_PATH], [[tokenIn.address, path, [], amountIn, minAmountOut]]),
      coder.encode(['address', 'uint256'], [tokenIn.address, amountIn]),
      coder.encode(['address', 'uint256'], [quote.tokenOut, minAmountOut])
    ];
    const v4Input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
    const data = routerInterface.encodeFunctionData('execute', [
      COMMAND_V4_SWAP,
      [v4Input],
      BigInt(deadline)
    ]);
    return {
      router: this.address,
      data,
      value: 0n,
      deadline: Number(deadline),
      commands: COMMAND_V4_SWAP,
      v4Actions: actions,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      tokenIn: tokenIn.address,
      tokenOut: quote.tokenOut,
      path: route.map((pool) => String(pool.id))
    };
  }

  async simulateV4ExactInputPath(args) {
    const request = this.buildV4ExactInputPath(args);
    const from = args.from || this.config.walletAddress;
    const result = await this.provider.call({
      from,
      to: request.router,
      data: request.data,
      value: request.value
    });
    return { ...request, simulationResult: result };
  }
}

export const universalRouterConstants = {
  COMMAND_V4_SWAP,
  ACTIONS_EXACT_IN_SINGLE_SETTLE_TAKE,
  ACTIONS_EXACT_IN_PATH_SETTLE_TAKE: '0x070c0f'
};
