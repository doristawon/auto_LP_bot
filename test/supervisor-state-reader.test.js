import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPendingExecutionPhase } from '../scripts/read-pending-execution.js';
import { AutoLpBot } from '../src/bot.js';

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

test('supervisor stop-file attaches an existing bot, defers pending work, and never launches a duplicate', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/supervise-dashboard.ps1', import.meta.url));
  const script = readFileSync(scriptPath, 'utf8');
  const stopStart = script.indexOf('if (Test-Path -LiteralPath $stopFile) {');
  const mainLoopStart = script.indexOf('\n  if (-not $child)', stopStart);
  assert.ok(stopStart >= 0 && mainLoopStart > stopStart, 'expected stop-file and normal launch branches');

  const stopBranch = script.slice(stopStart, mainLoopStart);
  const attachExisting = stopBranch.indexOf('$child = Get-AppProcess');
  const readPending = stopBranch.indexOf('$pending = Get-PendingExecution');
  const defer = stopBranch.indexOf("'app.stop_deferred_for_execution'");
  const stopChild = stopBranch.indexOf('Stop-Process -Id $child.Id');
  assert.ok(attachExisting >= 0 && attachExisting < readPending,
    'cold supervisor startup must attach a surviving bot before reading its journal');
  assert.ok(readPending < defer && defer < stopChild,
    'an active or unreadable journal must defer Stop-Process');
  assert.match(stopBranch, /if \(\$pending\) \{[\s\S]*?Start-Sleep -Seconds 15[\s\S]*?continue/);
  assert.doesNotMatch(stopBranch, /Start-AppProcess/, 'stop-file handling must never launch a bot');

  const normalLaunch = script.slice(mainLoopStart, script.indexOf('\n  Start-Sleep -Seconds 15', mainLoopStart));
  const discoverExisting = normalLaunch.indexOf('$existing = Get-AppProcess');
  const attach = normalLaunch.indexOf('$child = $existing');
  const launchNew = normalLaunch.indexOf('$child = Start-AppProcess');
  assert.ok(discoverExisting >= 0 && discoverExisting < attach && attach < launchNew,
    'normal startup must attach to the existing bot before launching a new process');
});

test('an explicit dashboard pause remains paused through the next startup scan', async () => {
  const settings = new Map([['executionPaused', false], ['stopLossLatched', false]]);
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { walletAddress: '0x00000000000000000000000000000000000000aa', pollIntervalMs: 0 };
  bot.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  bot.ledger = { append() {} };
  bot.snapshot = { bot: {} };
  bot.executionPaused = false;
  bot.resumeExecutionAfterStartup = true;
  bot.running = false;
  bot.initialize = async () => {};
  bot.schedulePointsSimulation = () => {};
  let scans = 0;
  let automaticRestores = 0;
  bot.runOnce = async () => { scans++; bot.running = false; };
  bot.startExecution = async () => { automaticRestores++; return { ok: true }; };

  bot.setExecutionPaused(true, 'dashboard');
  await bot.start();

  assert.equal(scans, 1);
  assert.equal(automaticRestores, 0);
  assert.equal(bot.executionPaused, true);
  assert.equal(settings.get('executionPaused'), true);
});
