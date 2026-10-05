import { JsonRpcProvider } from 'ethers';
import { isRpcRateLimitError } from './errors.js';

const gates = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_simulateV1',
  'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs',
  'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash']);
const transientLimit = error => isRpcRateLimitError(error) && !/credits? exhausted|quota.{0,50}(exhausted|depleted)|payment required|compute units.{0,50}(exhausted|depleted)/i.test(
  [error?.message,error?.info?.responseBody].filter(Boolean).join(' '));

// Shared by both wallets and read/write adapters using the same endpoint.
// Serial admission limits bursts; up to two admitted requests may be in flight.
export function endpointGate(endpoint, { spacingMs = 250, retryDelayMs = 5000 } = {}) {
  if (gates.has(endpoint)) return gates.get(endpoint);
  let tail = Promise.resolve(), nextAt = 0, cooldownAt = 0;
  const slots = new Set();
  const gate = {
    retryDelayMs,
    cooldown(ms) { cooldownAt = Math.max(cooldownAt, Date.now() + ms); },
    async run(task) {
      let release;
      const slot = new Promise(resolve => { release = resolve; });
      const admission = tail.then(async () => {
        while (slots.size >= 2) await Promise.race(slots);
        while (Date.now() < Math.max(nextAt, cooldownAt)) {
          await sleep(Math.max(nextAt, cooldownAt) - Date.now());
        }
        nextAt = Date.now() + spacingMs;
        slots.add(slot);
      });
      tail = admission.catch(() => {});
      await admission;
      try { return await task(); }
      finally { slots.delete(slot); release(); }
    }
  };
  gates.set(endpoint, gate);
  return gate;
}

export class RateLimitedJsonRpcProvider extends JsonRpcProvider {
  constructor(request, network, options = {}, gate = endpointGate(request.url)) {
    super(request, network, { ...options, batchMaxCount: 1 });
    this.rpcGate = gate;
  }
  async _send(payload) {
    const requests = Array.isArray(payload) ? payload : [payload];
    const retrySafe = requests.every(item => safeMethods.has(item.method));
    for (let attempt = 0; ; attempt++) {
      try {
        const results = await this.rpcGate.run(() => super._send(payload));
        const limited = results.find(item => item.error && transientLimit(item.error));
        if (!limited || !retrySafe || attempt >= 2) return results;
      } catch (error) {
        if (!retrySafe || !transientLimit(error) || attempt >= 2) throw error;
      }
      // Retry reads only. Signed transaction submission is always attempted once.
      this.rpcGate.cooldown(this.rpcGate.retryDelayMs * (attempt + 1));
    }
  }
}
