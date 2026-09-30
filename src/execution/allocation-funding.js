const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

/** Convert a saved, journal-compatible allocation scope into pair-ordered raw caps. */
export function allocationPairCaps(pool, scope) {
  const poolId = String(pool?.id || '').toLowerCase();
  const scopePoolId = String(scope?.poolId || '').toLowerCase();
  const updatedAt = Number(scope?.allocationUpdatedAt);
  if (!poolId || scopePoolId !== poolId
    || !Number.isFinite(updatedAt) || updatedAt <= 0
    || !scope.tokenCaps || typeof scope.tokenCaps !== 'object') {
    throw new Error('Allocation funding scope is not journal-compatible for this pool');
  }
  const token0Address = String(pool.token0?.address || '').toLowerCase();
  const token1Address = String(pool.token1?.address || '').toLowerCase();
  if (!ADDRESS_RE.test(token0Address) || !ADDRESS_RE.test(token1Address)
    || token0Address === token1Address) throw new Error('Allocation pool token pair is invalid');
  const tokenCaps = normalizeRawMap(scope.tokenCaps);
  if (!tokenCaps.has(token0Address) || !tokenCaps.has(token1Address)) {
    throw new Error('Allocation scope is missing a pool token cap');
  }
  return { [token0Address]: tokenCaps.get(token0Address), [token1Address]: tokenCaps.get(token1Address) };
}

/** Clip a physical wallet balance snapshot to the saved pair caps. */
export function clipAllocationPairBalances(balances, caps) {
  const actual = normalizeRawMap(balances);
  const normalizedCaps = normalizeRawMap(caps);
  return Object.fromEntries([...normalizedCaps.keys()].map((address) =>
    [address, minBigInt(actual.get(address) || 0n, normalizedCaps.get(address))]));
}

/**
 * Apply only signed physical deltas explained by this transaction receipt.
 * Debits are exact and reduce scoped inventory; credits increase it. Unexpected
 * or mismatched physical changes fail closed.
 */
export function addAllocationReceiptDeltas(scoped, physicalBefore, physicalAfter, expected = {}) {
  const inventory = normalizeRawMap(scoped);
  const before = normalizeRawMap(physicalBefore);
  const after = normalizeRawMap(physicalAfter);
  const expectations = normalizeExpected(expected);
  if (!expectations.size) throw new Error('Receipt delta expectations are required');
  const addresses = new Set([...before.keys(), ...after.keys()]);
  const deltas = new Map();
  for (const address of addresses) {
    const delta = (after.get(address) || 0n) - (before.get(address) || 0n);
    if (delta !== 0n) deltas.set(address, delta);
  }
  for (const [address, expectation] of expectations) {
    const delta = deltas.get(address) || 0n;
    if (delta !== expectation) {
      throw new Error('Physical receipt delta does not match the expected raw amount');
    }
    if (!inventory.has(address)) throw new Error('Receipt token is outside the scoped pool pair');
    if (delta < 0n && inventory.get(address) + delta < 0n) throw new Error('Receipt debit exceeds scoped pool inventory');
  }
  for (const address of deltas.keys()) {
    if (!expectations.has(address)) throw new Error('Unexpected physical receipt delta cannot be scoped');
  }
  const result = Object.fromEntries(inventory);
  for (const [address, delta] of deltas) result[address] = (inventory.get(address) || 0n) + delta;
  return result;
}

/** Reject executor requests whose pair-ordered raw inputs exceed their caps. */
export function assertAllocationRawCaps(required, caps) {
  const requested = normalizeRawMap(required);
  const normalizedCaps = normalizeRawMap(caps);
  for (const [address, raw] of requested) {
    if (!normalizedCaps.has(address) || raw > normalizedCaps.get(address)) {
      throw new Error('Executor raw input exceeds the pool allocation cap');
    }
  }
  return Object.fromEntries(requested);
}

function normalizeExpected(expected) {
  const result = new Map();
  const entries = expected instanceof Map ? [...expected] : Object.entries(expected || {});
  for (const [addressValue, value] of entries) {
    const address = String(addressValue).toLowerCase();
    if (!ADDRESS_RE.test(address) || result.has(address)) throw new Error('Receipt expectation token is invalid or duplicated');
    const delta = BigInt(value);
    if (delta === 0n) throw new Error('Receipt expected raw delta cannot be zero');
    result.set(address, delta);
  }
  return result;
}

function normalizeRawMap(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  const result = new Map();
  for (const [key, rawValue] of entries) {
    const address = String(key).toLowerCase();
    if (!ADDRESS_RE.test(address) || result.has(address)) throw new Error('Raw token map contains an invalid or duplicate token');
    const raw = BigInt(rawValue?.rawCap ?? rawValue?.raw ?? rawValue);
    if (raw < 0n) throw new Error('Raw token amount cannot be negative');
    result.set(address, raw);
  }
  return result;
}

function minBigInt(a, b) { return a < b ? a : b; }
