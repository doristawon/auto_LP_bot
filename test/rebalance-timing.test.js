import test from 'node:test';
import assert from 'node:assert/strict';
import { rebalanceTiming } from '../src/dashboard/rebalance-timing.js';
import { dashboardPage } from '../src/dashboard/page.js';
import vm from 'node:vm';

const NOW = 1_000_000_000;
const POOL = `0x${'11'.repeat(32)}`;
const POSITION = `0x${'22'.repeat(32)}`;
const POLL = 5 * 60_000;
const status = () => ({ executionPaused: false, cycleActive: false, recoveryRequired: false,
  executionBusy: false, nextMonitorAt: NOW + 2 * 60_000,
  selectedExecutionTargetPoolId: POOL,
  strategy: { confirmDelayMin: 15, monitorPollIntervalMs: POLL }, rebalanceBackoffs: [] });
const snapshot = (position) => ({ generatedAt: NOW - 30_000,
  portfolio: { positions: [{ id: POSITION, poolId: POOL, pair: 'USDG/EARN', shares: '1',
    outside: true, shouldRebalance: false, outOfRangeSince: NOW - 5 * 60_000, ...position }] } });

test('countdown points to the first scheduled scan after the OOR confirmation deadline', () => {
  const result = rebalanceTiming(status(), snapshot(), NOW);
  assert.equal(result.phase, 'confirming');
  assert.equal(result.policyReadyAt, NOW + 10 * 60_000);
  assert.equal(result.targetAt, NOW + 12 * 60_000);
});

test('retry backoff moves the attempt to the next scan, never the expiry second', () => {
  const control = status();
  control.rebalanceBackoffs = [{ poolId: POOL, positionId: POSITION, nextRetryAt: NOW + 4 * 60_000 }];
  const result = rebalanceTiming(control, snapshot({ shouldRebalance: true,
    outOfRangeSince: NOW - 30 * 60_000 }), NOW);
  assert.equal(result.phase, 'backoff');
  assert.equal(result.targetAt, NOW + 7 * 60_000);
});

test('paused, executing, stale, and in-range states do not promise a transaction time', () => {
  const paused = status(); paused.executionPaused = true;
  assert.equal(rebalanceTiming(paused, snapshot(), NOW).phase, 'paused');
  const executing = status(); executing.executionBusy = true;
  assert.equal(rebalanceTiming(executing, snapshot(), NOW).phase, 'executing');
  assert.equal(rebalanceTiming(status(), { ...snapshot(), generatedAt: NOW - 20 * 60_000 }, NOW).phase, 'stale');
  assert.equal(rebalanceTiming(status(), snapshot({ outside: false }), NOW).phase, 'in-range');
  assert.equal(rebalanceTiming(status(), snapshot({ outside: false }), NOW).targetAt, status().nextMonitorAt);
});

test('dashboard countdown script parses and updates once per second without polling RPC each tick', () => {
  const html = dashboardPage();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /id="rebalanceClockValue"/);
  assert.match(script, /setInterval\(renderRebalanceCountdown,1000\)/);
});
