import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardPage } from '../src/dashboard/page.js';
import { describeExecutionProgress } from '../src/dashboard/execution-progress.js';

const html = dashboardPage();
function uiFunction(name) {
  const source = html.split('\n').find(line => line.startsWith(`function ${name}(`));
  assert.ok(source, name);
  return vm.runInNewContext(`(${source})`, { safeEventText: value => String(value) });
}

test('backoff distinguishes confirmed withdrawal, pending receipt and unrelated positions', () => {
  const describe = uiFunction('backoffAssetState');
  const row = { poolId: 'pool', positionId: 'old-range' };
  const progress = describeExecutionProgress({ id: 'execution-1', poolId: 'pool',
    oldPosition: { id: 'old-range' }, phase: 'recovery_required', lastKnownPhase: 'atomic_preflighted',
    tx: { withdraw: '0x' + 'aa'.repeat(32) } });
  assert.match(describe(progress, row), /撤池已確認，資產已離開舊 LP/);
  assert.match(describe(progress, { ...row, positionId: 'other-range' }), /未對應此部位/);
  const pending = describeExecutionProgress({ id: 'execution-2', poolId: 'pool',
    oldPosition: { id: 'old-range' }, phase: 'withdraw_sent', tx: { withdraw: '0x' + 'bb'.repeat(32) } });
  assert.match(describe(pending, row), /撤池交易待確認/);
  assert.doesNotMatch(html, /這是重試冷卻狀態，不代表資產已移動/);
});

test('dashboard separates historical liquidation failure from current status', () => {
  const view = uiFunction('stopLiquidationView');
  const failed = { status: 'failed', at: 100, error: 'historical failure' };
  const legacy = view({ liquidation: failed, incident: { resetAt: 200 } });
  assert.equal(legacy.current, null);
  assert.equal(legacy.previous, failed);
  const history = [failed, { status: 'completed', at: 150 }];
  assert.equal(view({ liquidation: null, liquidationHistory: history }).previous, history[1]);
  for (const status of ['queued', 'running', 'pending']) {
    const current = { status, at: 100 };
    assert.equal(view({ liquidation: current, incident: { resetAt: 200 } }).current, current);
  }
  const later = { ...failed, at: 300 };
  assert.equal(view({ liquidation: later, incident: { resetAt: 200 } }).current, later);
});
