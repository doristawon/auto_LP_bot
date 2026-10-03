import { AbiCoder, Contract, getAddress, keccak256 } from 'ethers';
import { USDG } from '../constants.js';
import { fetchOwnerLedger, LENS_ABI, LENS_ADDRESS } from '../analytics/points-evidence.js';

const coder = AbiCoder.defaultAbiCoder();
const POOL_KEY_ABI = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const LENS_BATCH_SIZE = 200;
const MAX_LENS_RANGE_IDS = 200;
const MAX_CLAIM_RANGES = 16;
const UINT256_LIMIT = 1n << 256n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

/**
 * Read the owner's indexed range IDs, verify every row against the exact pool
 * key and lens result, then retain the current range plus at most 15 old ranges
 * that have fees to claim. This function never submits a transaction.
 */
export async function collectOfficialClaimRanges({
  pool,
  walletAddress,
  provider,
  currentPosition,
  maxFeeBps = 1000,
  fetchFn = fetch,
  retiredOnly = false,
  ownerLedger = null,
  knownRangeIds = []
}) {
  const context = validatePool(pool);
  const wallet = getAddress(walletAddress);
  if (!provider || typeof provider.call !== 'function') {
    throw new Error('official-claim-provider-invalid');
  }
  if (!retiredOnly && (!currentPosition || currentPosition.id == null)) {
    throw new Error('official-claim-current-position-required');
  }
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) {
    throw new Error('official-claim-fee-cap-invalid');
  }

  const currentRangeId = retiredOnly ? null : normalizeUint256(currentPosition.id);
  const owner = ownerLedger ?? await fetchOwnerLedger(wallet, fetchFn);
  if (!owner || !Array.isArray(owner.Position)) {
    throw new Error('official-claim-owner-positions-invalid');
  }

  const ids = new Map();
  for (const item of owner.Position) {
    if (String(item?.pool_id || '').toLowerCase() !== context.poolIdHex) continue;
    const id = normalizeUint256(item.range_id);
    ids.set(id.toString(), id);
  }
  for (const rawId of knownRangeIds) {
    const id = normalizeUint256(rawId);
    ids.set(id.toString(), id);
  }
  if (currentRangeId !== null) ids.set(currentRangeId.toString(), currentRangeId);
  if (ids.size > MAX_LENS_RANGE_IDS) {
    throw new Error('official-claim-owner-range-bound-exceeded');
  }

  const lens = new Contract(LENS_ADDRESS, LENS_ABI, provider);
  const rowsById = new Map();
  const allIds = [...ids.values()];
  for (let offset = 0; offset < allIds.length; offset += LENS_BATCH_SIZE) {
    const chunk = allIds.slice(offset, offset + LENS_BATCH_SIZE);
    const [rows] = await lens.userRanges(context.key.hooks, wallet, chunk);
    if (!Array.isArray(rows) || rows.length !== chunk.length) {
      throw new Error('official-claim-lens-incomplete-batch');
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const id = normalizeUint256(row?.rangeId);
      if (id !== chunk[index] || row.keyVerified !== true) {
        throw new Error('official-claim-lens-range-unverified');
      }
      const rowKey = normalizePoolKey(row.key);
      if (poolKeyHash(rowKey) !== context.poolIdHex || !samePoolKey(rowKey, context.key)) {
        throw new Error('official-claim-lens-pool-mismatch');
      }

      const tickLower = safeTick(row.tickLower);
      const tickUpper = safeTick(row.tickUpper);
      if (tickLower >= tickUpper || tickLower < MIN_TICK || tickUpper > MAX_TICK
        || tickLower % context.key.tickSpacing !== 0 || tickUpper % context.key.tickSpacing !== 0) {
        throw new Error('official-claim-lens-ticks-invalid');
      }
      const derivedId = normalizeUint256(keccak256(coder.encode(
        ['bytes32', 'int24', 'int24'], [context.poolIdHex, tickLower, tickUpper]
      )));
      if (derivedId !== id) throw new Error('official-claim-lens-range-id-mismatch');

      const isCurrent = id === currentRangeId;
      if (isCurrent && currentPosition.tickLower != null && currentPosition.tickUpper != null
        && (tickLower !== safeTick(currentPosition.tickLower)
          || tickUpper !== safeTick(currentPosition.tickUpper))) {
        throw new Error('official-claim-current-range-mismatch');
      }
      const claimable0 = normalizeUint256(row.claimable0);
      const claimable1 = normalizeUint256(row.claimable1);
      const hasFees = claimable0 > 0n || claimable1 > 0n;
      const claimPaused = row.claimPaused;
      const settling = row.settling;
      const effectiveFeeBps = Number(row.effectiveClaimFeeBps);
      if (typeof claimPaused !== 'boolean' || typeof settling !== 'boolean'
        || !Number.isInteger(effectiveFeeBps) || effectiveFeeBps < 0 || effectiveFeeBps > 10_000) {
        throw new Error('official-claim-lens-fee-state-invalid');
      }
      const blocked = claimPaused || settling || effectiveFeeBps > maxFeeBps;
      if (retiredOnly && (normalizeUint256(row.shares) !== 0n || !hasFees || blocked)) continue;
      if (isCurrent && blocked) {
        throw new Error('official-claim-range-not-eligible');
      }
      if (!isCurrent && hasFees && blocked) continue;
      rowsById.set(id.toString(), {
        rangeId: toBytes32(id),
        tickLower,
        tickUpper,
        current: isCurrent,
        hasFees,
        claimable0,
        claimable1,
        effectiveFeeBps
      });
    }
  }

  const current = currentRangeId === null ? null : rowsById.get(currentRangeId.toString());
  if (!retiredOnly && !current?.current) throw new Error('official-claim-current-range-missing');
  const olderFeeRows = [...rowsById.values()].filter((row) => !row.current && row.hasFees);
  const usdIndex = context.key.currency0.toLowerCase() === USDG.toLowerCase() ? 0
    : context.key.currency1.toLowerCase() === USDG.toLowerCase() ? 1 : null;
  if (usdIndex != null) {
    olderFeeRows.sort((a, b) => {
      const aUsd = usdIndex === 0 ? a.claimable0 : a.claimable1;
      const bUsd = usdIndex === 0 ? b.claimable0 : b.claimable1;
      if (aUsd !== bUsd) return aUsd > bUsd ? -1 : 1;
      const aOther = usdIndex === 0 ? a.claimable1 : a.claimable0;
      const bOther = usdIndex === 0 ? b.claimable1 : b.claimable0;
      if (aOther !== bOther) return aOther > bOther ? -1 : 1;
      return BigInt(a.rangeId) < BigInt(b.rangeId) ? -1 : BigInt(a.rangeId) > BigInt(b.rangeId) ? 1 : 0;
    });
  }
  if (retiredOnly) return olderFeeRows.slice(0, MAX_CLAIM_RANGES).map(row => ({
    ...row, claimable0: row.claimable0.toString(), claimable1: row.claimable1.toString()
  }));
  const selected = [current, ...olderFeeRows.slice(0, MAX_CLAIM_RANGES - 1)];
  // Lens shares/balances are intentionally not returned; preview must retain
  // the caller's currentPosition snapshot and independently verify live shares.
  return selected.map(({ rangeId, tickLower, tickUpper, current: isCurrent }) => ({
    rangeId,
    tickLower,
    tickUpper,
    current: isCurrent
  }));
}

function validatePool(pool) {
  if (!pool?.id || !pool.key) throw new Error('official-claim-pool-required');
  const poolIdHex = toBytes32(normalizeUint256(pool.id));
  const key = normalizePoolKey(pool.key);
  if (poolKeyHash(key) !== poolIdHex) throw new Error('official-claim-pool-id-mismatch');
  return { poolIdHex, key };
}

function normalizePoolKey(value) {
  if (!value) throw new Error('official-claim-pool-key-invalid');
  const read = (name, index) => value[name] ?? value[index];
  const currency0 = getAddress(read('currency0', 0));
  const currency1 = getAddress(read('currency1', 1));
  const hooks = getAddress(read('hooks', 4));
  const fee = Number(read('fee', 2));
  const tickSpacing = Number(read('tickSpacing', 3));
  if (!Number.isInteger(fee) || fee < 0 || fee >= 2 ** 24
    || !Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing >= 2 ** 23) {
    throw new Error('official-claim-pool-key-invalid');
  }
  return { currency0, currency1, fee, tickSpacing, hooks };
}

function poolKeyHash(key) {
  return keccak256(coder.encode([POOL_KEY_ABI], [[
    key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks
  ]])).toLowerCase();
}

function samePoolKey(left, right) {
  return left.currency0.toLowerCase() === right.currency0.toLowerCase()
    && left.currency1.toLowerCase() === right.currency1.toLowerCase()
    && left.fee === right.fee
    && left.tickSpacing === right.tickSpacing
    && left.hooks.toLowerCase() === right.hooks.toLowerCase();
}

function normalizeUint256(value) {
  let result;
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe number');
    result = BigInt(value);
  } catch {
    throw new Error('official-claim-uint256-invalid');
  }
  if (result < 0n || result >= UINT256_LIMIT) throw new Error('official-claim-uint256-invalid');
  return result;
}

function toBytes32(value) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function safeTick(value) {
  const tick = Number(value);
  if (!Number.isSafeInteger(tick)) throw new Error('official-claim-lens-ticks-invalid');
  return tick;
}
