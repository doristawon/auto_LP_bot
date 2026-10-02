import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { EIP7702_GUARD_ABI } from '../src/abi.js';
import { executeOfficialReposition, findOfficialRepositionEvent }
  from '../src/execution/official-reposition-execution.js';
const wallet = '0x' + '11'.repeat(20), hook = '0x' + '22'.repeat(20);
const poolId = '0x' + '33'.repeat(32), hash = '0x' + '44'.repeat(32);
const guard = new Interface(EIP7702_GUARD_ABI);
const deposit = new Interface(['event Deposited(address indexed owner,uint256 indexed id,uint128 liquidity)']);
function fixture({ unknown = false, duplicate = false, paused = false, pending = false } = {}) {
  const settings = new Map([['executionPaused', paused]]);
  let journal = { id: 'fixture', phase: 'prepared', pair: 'A/USDG', tx: {},
    preBalancesRaw: { raw0: '100', raw1: '100' } };
  let sent = 0;
  const logs = [
    { address: wallet, ...guard.encodeEventLog(guard.getEvent('OfficialRepositioned'),
      [poolId, 1n, 2n, 200n, 3n, 4n, 1n, 2n]) },
    { address: hook, ...deposit.encodeEventLog(deposit.getEvent('Deposited'), [hook, 2n, 200n]) }
  ];
  if (duplicate) logs.push(logs[1]);
  const executor = {
    config: { walletAddress: wallet, topUpMinGasReserveWei: 1n },
    writeProvider: { getTransactionCount: async (_address, tag) => pending && tag === 'pending' ? 2 : 1 },
    state: { getSetting: (key, fallback) => settings.get(key) ?? fallback },
    ledger: { append() {} },
    patchJournal: (_previous, patch) => { journal = { ...journal, ...patch }; return journal; },
    clearJournal: () => { journal = null; },
    assertPlanStillOutOfRange: async () => {},
    assertTopUpGasBudget: async () => {},
    getPinnedFeeOverrides: async () => ({ gasPrice: 1n }),
    readPositionShares: async (_pool, id) => id === 1n ? 0n : sent ? 205n : 5n,
    readRawPairBalances: async () => ({ raw0: 10n, raw1: 20n }),
    sendVerifiedTx: async request => {
      sent++; request.onSent(hash);
      if (unknown) { const error = new Error('Sensitive calldata should not be retained');
        error.code = 'BROADCAST_OUTCOME_UNCERTAIN'; throw error; }
      return { hash, status: 1, logs };
    }
  };
  const plan = { pool: { id: poolId, key: { hooks: hook } }, position: { id: 1n, shares: 100n } };
  const candidate = { request: { to: wallet, data: '0x1234' }, summary: { method: 'fixture' },
    expected: { rangeId: 2n, liquidity: 200n, minLiquidity: 199n }, claimRanges: [],
    target: { tickLower: -60, tickUpper: 60 }, gasUsed: '200000', protected: { raw0: '10', raw1: '20' } };
  return { executor, args: { plan, candidate, journal }, sent: () => sent, journal: () => journal, logs };
}
test('official guarded claim/reposition produces one capital send and one new deposit', async () => {
  const f = fixture(); const result = await executeOfficialReposition.call(f.executor, f.args);
  assert.equal(f.sent(), 1); assert.equal(result.depositHash, result.withdrawHash);
  assert.equal(result.status, 'completed'); assert.equal(f.journal(), null);
});
test('uncertain official broadcast stays recovery locked with no fallback send or calldata leak', async () => {
  const f = fixture({ unknown: true });
  await assert.rejects(executeOfficialReposition.call(f.executor, f.args), error => {
    assert.match(error.message, /BROADCAST_OUTCOME_UNCERTAIN/);
    assert.ok(!error.stack.includes('Sensitive'));
    assert.equal(error.officialHandled, true);
    return true;
  });
  assert.equal(f.sent(), 1); assert.equal(f.journal().phase, 'recovery_required');
  assert.equal(f.journal().tx.officialReposition, hash);
  assert.ok(!JSON.stringify(f.journal()).includes('Sensitive'));
});
test('official receipt with more than one deposit fails verification and retains recovery', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(executeOfficialReposition.call(f.executor, f.args));
  assert.equal(f.sent(), 1); assert.equal(f.journal().phase, 'recovery_required');
});
test('paused official flow never broadcasts', async () => {
  const f = fixture({ paused: true });
  await assert.rejects(executeOfficialReposition.call(f.executor, f.args));
  assert.equal(f.sent(), 0); assert.equal(f.journal().phase, 'failed');
});

test('pending wallet transaction blocks official capital send', async () => {
  const f = fixture({ pending: true });
  await assert.rejects(executeOfficialReposition.call(f.executor, f.args));
  assert.equal(f.sent(), 0); assert.equal(f.journal().phase, 'failed');
});
test('official event parser requires one matching event emitted by delegated wallet', () => {
  const f = fixture(); assert.equal(findOfficialRepositionEvent({ logs: f.logs }, wallet, poolId).liquidity, 200n);
  assert.throws(() => findOfficialRepositionEvent({ logs: [f.logs[0], f.logs[0]] }, wallet, poolId));
  assert.throws(() => findOfficialRepositionEvent({ logs: f.logs }, hook, poolId));
});
