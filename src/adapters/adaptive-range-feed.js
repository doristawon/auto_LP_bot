import { Interface, id, isAddress } from 'ethers';
import { V4_SWAP_EVENT } from '../abi.js';

const abi = new Interface(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']);

// Only one pool; bounded RPC work, no per-swap block queries, no fabricated times.
export async function readAdaptiveRangeSamples(provider, { poolId, poolManager,
  windowHours = 24, nowMs = Date.now(), maxRequests = 128, maxLogs = 10000 } = {}) {
  if (!/^0x[\da-f]{64}$/i.test(poolId) || !isAddress(poolManager) || windowHours !== 24
    || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 256
    || !Number.isInteger(maxLogs) || maxLogs < 20 || maxLogs > 10000) throw new Error('Invalid adaptive range feed settings');
  let requests = 0;
  const deadline = Date.now() + 90_000;
  const request = async fn => {
    if (++requests > maxRequests) throw new Error('Adaptive range RPC budget exhausted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Adaptive range scan deadline exceeded');
    let timer;
    try { return await Promise.race([fn(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Adaptive range RPC deadline exceeded')), Math.min(remaining, 12_000));
    })]); } finally { clearTimeout(timer); }
  };
  const blocks = new Map();
  const readBlock = async number => {
    if (blocks.has(number)) return blocks.get(number);
    const block = await request(() => provider.getBlock(number));
    if (!block || (typeof number === 'number' && block.number !== number)
      || !Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp)
      || !/^0x[\da-f]{64}$/i.test(block.hash)) throw new Error('Adaptive range block unavailable');
    blocks.set(number, block);
    return block;
  };
  const latest = await readBlock('latest');
  // Small confirmation buffer; the end hash is checked again after the scan.
  const end = await readBlock(Math.max(0, latest.number - 20));
  if (end.timestamp * 1000 > nowMs + 30_000 || nowMs - end.timestamp * 1000 > 5 * 60_000) throw new Error('Adaptive range chain data is stale');
  const boundary = end.timestamp - windowHours * 3600;
  let lo = 0, hi = end.number;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    const block = await readBlock(middle);
    if (block.timestamp < boundary) lo = middle + 1;
    else hi = middle;
  }
  const start = await readBlock(lo);
  if (start.timestamp > boundary + 300) throw new Error('Adaptive range history is incomplete');
  let cursor = start.number, span = 50000;
  const unique = new Map();
  while (cursor <= end.number) {
    const until = Math.min(end.number, cursor + span - 1);
    let logs;
    try { logs = await request(() => provider.getLogs({ address: poolManager,
      topics: [id(V4_SWAP_EVENT), poolId], fromBlock: cursor, toBlock: until })); }
    catch (error) {
      const message = String(error?.message || '');
      // Quota/transport failures are not retried. Split only explicit range/result limits.
      if (span > 1000 && /block range|too many results|response size|limited to.*blocks|query returned more/i.test(message)) {
        const limit = /limited to\s+(\d+)\s+blocks/i.exec(message);
        span = Math.max(1000, Math.min(Math.floor(span / 2), Number(limit?.[1] || span)));
        continue;
      }
      throw error;
    }
    if (!Array.isArray(logs) || logs.length >= maxLogs) throw new Error('Adaptive range logs may be truncated');
    for (const log of logs) {
      const logIndex = Number(log.index ?? log.logIndex), blockNumber = Number(log.blockNumber);
      if (log.removed || String(log.address).toLowerCase() !== poolManager.toLowerCase()
        || String(log.topics?.[1]).toLowerCase() !== poolId.toLowerCase()
        || !Number.isSafeInteger(blockNumber) || blockNumber < cursor || blockNumber > until
        || !Number.isSafeInteger(logIndex) || logIndex < 0 || !/^0x[\da-f]{64}$/i.test(log.blockHash)) throw new Error('Adaptive range logs are inconsistent');
      const parsed = abi.parseLog(log);
      if (parsed?.name !== 'Swap') throw new Error('Unexpected adaptive range event');
      const sample = { blockNumber, logIndex, tick: Number(parsed.args.tick), blockHash: log.blockHash,
        amount0: String(parsed.args.amount0), amount1: String(parsed.args.amount1), fee: Number(parsed.args.fee) };
      const key = `${blockNumber}:${logIndex}`, previous = unique.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(sample)) throw new Error('Conflicting adaptive range event');
      unique.set(key, sample);
      if (unique.size >= maxLogs) throw new Error('Adaptive range log budget exhausted');
    }
    cursor = until + 1;
  }
  const samples = [...unique.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const first = samples.length ? await readBlock(samples[0].blockNumber) : null;
  const last = samples.length ? await readBlock(samples.at(-1).blockNumber) : null;
  if (first && (first.hash !== samples[0].blockHash || last.hash !== samples.at(-1).blockHash)) throw new Error('Adaptive range event block hash changed');
  const endAgain = await request(() => provider.getBlock(end.number));
  if (endAgain?.hash !== end.hash) throw new Error('Adaptive range reorg detected');
  return { samples, firstSwapTimestampSeconds: first?.timestamp ?? null,
    lastSwapTimestampSeconds: last?.timestamp ?? null, asOfTimestampSeconds: end.timestamp,
    windowStartTimestampSeconds: start.timestamp,
    fromBlock: start.number, toBlock: end.number, observedAt: end.timestamp * 1000, requests };
}
