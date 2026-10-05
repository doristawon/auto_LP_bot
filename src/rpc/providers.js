import { FallbackProvider, FetchRequest, JsonRpcProvider } from 'ethers';
import { isRpcTimeoutError } from './errors.js';
import { RateLimitedJsonRpcProvider } from './rate-limited-provider.js';

function classifyRpcError(error) {
  const status = Number(error?.statusCode || error?.status || error?.info?.responseStatus || 0);
  const message = [error?.message, error?.shortMessage, error?.cause?.message,
    error?.info?.error?.message, error?.info?.responseText].filter(Boolean).join(' ');
  if (status === 402 || /(?:quota|credits?|compute units?)(?:[^.\n]{0,60})(?:exhausted|used up|depleted|exceeded)|(?:exhausted|used up|depleted|exceeded)(?:[^.\n]{0,60})(?:quota|credits?|compute units?)|payment required|resource exhausted/i.test(message)) return 'quota_exhausted';
  if (status === 429 || /\b429\b|rate[ -]?limit|too many requests|request limit/i.test(message)) return 'rate_limited';
  if (isRpcTimeoutError(error)) return 'timeout';
  if (/bad data|invalid (response|argument)|could not decode|invalid hex|cannot convert|invalid bigint|invalid integer/i.test(message)) return 'invalid_response';
  if (status >= 400) return 'http_error';
  return 'transport';
}

export async function probeRpcEndpoint(url, chainId, { timeoutMs = 6000 } = {}) {
  const startedAt = Date.now();
  const checkedAt = Date.now();
  const request = new FetchRequest(url);
  request.timeout = Math.max(1000, Math.min(15_000, Number(timeoutMs) || 6000));
  request.retryFunc = async () => false;
  const provider = new JsonRpcProvider(request, { chainId, name: 'robinhood' }, { staticNetwork: true });
  try {
    let actualChainId = null;
    let blockNumber = null;
    let reachable = false;
    try {
      actualChainId = Number(BigInt(await provider.send('eth_chainId', [])));
      reachable = true;
      blockNumber = Number(BigInt(await provider.send('eth_blockNumber', [])));
    } catch (error) {
      return {
        reachable, chainValid: false, chainId: actualChainId, blockNumber: null,
        latencyMs: Date.now() - startedAt, errorType: classifyRpcError(error), checkedAt: Date.now()
      };
    }
    const blockValid = Number.isSafeInteger(blockNumber) && blockNumber >= 0;
    const valid = actualChainId === Number(chainId) && blockValid;
    return {
      reachable: true, chainValid: actualChainId === Number(chainId), chainId: actualChainId,
      blockNumber: Number.isSafeInteger(blockNumber) ? blockNumber : null,
      latencyMs: Date.now() - startedAt,
      errorType: !blockValid ? 'invalid_response' : valid ? null : 'wrong_chain', checkedAt: Date.now()
    };
  } finally {
    provider.destroy();
  }
}

export function createProviders(config) {
  const network = { chainId: config.chainId, name: 'robinhood' };
  const requestTimeoutMs = Number(config.rpcRequestTimeoutMs || 30_000);
  const rawProviders = config.rpcUrls.map((url) => {
    const request = new FetchRequest(url);
    request.timeout = requestTimeoutMs;
    request.retryFunc = async () => false;
    return new RateLimitedJsonRpcProvider(request, network, { staticNetwork: true });
  });
  const writeRequest = new FetchRequest(config.rpcUrls[0]);
  writeRequest.timeout = requestTimeoutMs;
  writeRequest.retryFunc = async () => false;
  const writeProvider = new RateLimitedJsonRpcProvider(writeRequest, network, { staticNetwork: true });
  const readProvider = rawProviders.length === 1
    ? rawProviders[0]
    : new FallbackProvider(
        rawProviders.map((provider, index) => ({
          provider,
          priority: index + 1,
          weight: 1,
          stallTimeout: 1200 + index * 400
        })),
        network,
        { quorum: 1 }
      );
  return { readProvider, writeProvider, rawProviders };
}

export async function verifyProviders(providers, chainId, urls = null) {
  const results = [];
  for (let index = 0; index < providers.length; index += 1) {
    if (Array.isArray(urls) && urls[index]) {
      const result = await probeRpcEndpoint(urls[index], chainId, { timeoutMs: 8000 });
      results.push({ index, ...result, ok: result.reachable && result.chainValid && result.errorType == null
        && Number.isSafeInteger(result.blockNumber) && result.blockNumber >= 0 });
      continue;
    }
    try {
      const startedAt = Date.now();
      const actualChainId = Number(BigInt(await providers[index].send('eth_chainId', [])));
      const blockNumber = Number(BigInt(await providers[index].send('eth_blockNumber', [])));
      const chainValid = actualChainId === chainId;
      const blockValid = Number.isSafeInteger(blockNumber) && blockNumber >= 0;
      results.push({ index, ok: chainValid && blockValid, reachable: true,
        chainValid, chainId: actualChainId, blockNumber, latencyMs: Date.now() - startedAt,
        errorType: !blockValid ? 'invalid_response' : chainValid ? null : 'wrong_chain', checkedAt: Date.now() });
    } catch (error) {
      const errorType = classifyRpcError(error);
      results.push({ index, ok: false, reachable: false, chainValid: false, chainId: null,
        blockNumber: null, latencyMs: null, errorType, checkedAt: Date.now() });
    }
  }
  if (!results.some((x) => x.ok)) {
    const error = new Error('No configured RPC endpoint is healthy on Robinhood Chain');
    error.rpcHealth = results;
    throw error;
  }
  return results;
}
