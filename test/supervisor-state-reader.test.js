import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPendingExecutionPhase } from '../scripts/read-pending-execution.js';

test('phase reader preserves active execution phases without PowerShell case folding', () => {
  const json = JSON.stringify({ settings: {
    ActiveRebalanceExecution: { phase: 'completed' },
    activeRebalanceExecution: { phase: 'withdraw_sent' }
  } });
  assert.equal(readPendingExecutionPhase(json), 'withdraw_sent');
});

test('phase reader accepts idle and terminal state shapes', () => {
  assert.equal(readPendingExecutionPhase('{"settings":{}}'), null);
  assert.equal(readPendingExecutionPhase('{"settings":{"activeRebalanceExecution":null}}'), null);
  assert.equal(readPendingExecutionPhase('{"settings":{"activeRebalanceExecution":{"phase":"failed"}}}'), 'failed');
});

test('malformed state or execution shape fails closed', () => {
  for (const json of ['{', '[]', '{}', '{"settings":null}',
    '{"settings":{"activeRebalanceExecution":{"phase":null}}}',
    '{"settings":{"activeRebalanceExecution":"failed"}}']) {
    assert.throws(() => readPendingExecutionPhase(json));
  }
});

test('CLI emits only a safe phase and fails closed on invalid or missing state', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lp phase # '));
  const file = path.join(dir, 'state file.json');
  const reader = fileURLToPath(new URL('../scripts/read-pending-execution.js', import.meta.url));
  const run = () => spawnSync(process.execPath, [reader, file], { encoding: 'utf8' });
  try {
    writeFileSync(file, JSON.stringify({ settings: { activeRebalanceExecution: { phase: 'atomic_sent' } } }));
    let result = run();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'atomic_sent');
    assert.equal(result.stderr, '');
    writeFileSync(file, '{"settings":{"activeRebalanceExecution":null}}');
    result = run();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'none');
    writeFileSync(file, '{malformed');
    result = run();
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    rmSync(file);
    result = run();
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('lp phase # '));
    rmSync(dir, { recursive: true, force: true });
  }
});
