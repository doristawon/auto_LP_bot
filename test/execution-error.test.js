import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { EIP7702_GUARD_ABI } from '../src/abi.js';
import { summarizeExecutionError } from '../src/execution/execution-error.js';

const guard = new Interface(EIP7702_GUARD_ABI);

test('summarizes LiquidityBelowMinimum and drops long calldata from error text', () => {
  const payload = guard.encodeErrorResult('LiquidityBelowMinimum');
  const calldata = `0x${'ab'.repeat(512)}`;
  const error = Object.assign(new Error(`execution reverted (unknown custom error) data="${calldata}"`), {
    code: 'CALL_EXCEPTION', data: payload
  });

  const summary = summarizeExecutionError(error);
  assert.equal(summary.guardError, 'LiquidityBelowMinimum');
  assert.equal(summary.errorSelector, guard.getError('LiquidityBelowMinimum').selector);
  assert.match(summary.error, /可存入流動性低於最低限制/);
  assert.doesNotMatch(JSON.stringify(summary), /ab{20,}|unknown custom error/);
});

test('decodes ExcessResidual from nested object data without retaining its arguments', () => {
  const payload = guard.encodeErrorResult('ExcessResidual', [123456789n, 987654321n]);
  const error = Object.assign(new Error('execution reverted'), {
    info: { error: { data: { result: payload } } }
  });

  const summary = summarizeExecutionError(error);
  assert.equal(summary.guardError, 'ExcessResidual');
  assert.equal(summary.errorSelector, guard.getError('ExcessResidual').selector);
  assert.match(summary.error, /殘餘代幣超出允許上限/);
  assert.doesNotMatch(JSON.stringify(summary), /123456789|987654321|0x[\da-f]{64,}/i);
});

test('maps a named custom error in message text without preserving its arguments', () => {
  const summary = summarizeExecutionError(new Error('execution reverted: ExcessResidual(123456789, 987654321)'));
  assert.equal(summary.guardError, 'ExcessResidual');
  assert.match(summary.error, /殘餘代幣超出允許上限/);
  assert.doesNotMatch(JSON.stringify(summary), /123456789|987654321/);
});

test('uses only a matching journal retry summary as fallback', () => {
  const journal = { id: 'execution-1', atomicRetryGuardError: 'LiquidityBelowMinimum',
    atomicRetrySelector: guard.getError('LiquidityBelowMinimum').selector,
    atomicRetryError: `unsafe raw payload 0x${'ee'.repeat(256)}` };
  const error = Object.assign(new Error('Atomic planning exceeded five minutes'), {
    executionJournalId: 'execution-1'
  });

  const matching = summarizeExecutionError(error, { fallbackJournal: journal });
  assert.equal(matching.guardError, 'LiquidityBelowMinimum');
  assert.match(matching.error, /可存入流動性低於最低限制/);
  assert.doesNotMatch(JSON.stringify(matching), /unsafe raw payload|0x[\da-f]{64,}/i);

  const staleError = Object.assign(new Error(error.message), { executionJournalId: 'execution-2' });
  const stale = summarizeExecutionError(staleError, { fallbackJournal: journal });
  assert.equal(stale.guardError, null);
  assert.match(stale.error, /五分鐘|Atomic planning/);
});

test('prefers current same-journal error fields over an earlier retry error', () => {
  const journal = { id: 'execution-1',
    guardError: 'ExcessResidual',
    errorSelector: guard.getError('ExcessResidual').selector,
    atomicRetryGuardError: 'LiquidityBelowMinimum',
    atomicRetrySelector: guard.getError('LiquidityBelowMinimum').selector };
  const error = Object.assign(new Error('execution reverted (unknown custom error)'), {
    executionJournalId: 'execution-1'
  });

  const summary = summarizeExecutionError(error, { fallbackJournal: journal });
  assert.equal(summary.guardError, 'ExcessResidual');
  assert.equal(summary.errorSelector, guard.getError('ExcessResidual').selector);
});

test('current revert and unrelated operational failures cannot inherit an earlier guard cause', () => {
  const fallbackJournal = { id: 'execution-1', guardError: 'LiquidityBelowMinimum',
    errorSelector: '0xb6470697', atomicRetryGuardError: 'ExcessResidual', atomicRetrySelector: '0x6af2a037' };
  const direct = summarizeExecutionError({ executionJournalId: 'execution-1', data: '0x12345678' }, { fallbackJournal });
  assert.equal(direct.guardError, null);
  assert.equal(direct.errorSelector, '0x12345678');
  const operational = summarizeExecutionError({ executionJournalId: 'execution-1', message: 'Insufficient gas balance' }, { fallbackJournal });
  assert.equal(operational.guardError, null);
  assert.equal(operational.error, 'Insufficient gas balance');
  const inconsistent = summarizeExecutionError({ executionJournalId: 'execution-1', message: 'unknown custom error' }, {
    fallbackJournal: { ...fallbackJournal, errorSelector: '0x6af2a037' }
  });
  assert.equal(inconsistent.guardError, null);
});

test('strips long calldata embedded in shortMessage when structured revert data is absent', () => {
  const calldata = `0xb6470697${'cd'.repeat(128)}`;
  const summary = summarizeExecutionError({
    shortMessage: `execution reverted (unknown custom error) (data="${calldata}")`
  });

  assert.doesNotMatch(JSON.stringify(summary), /b6470697|cd{20,}/i);
  assert.match(summary.error, /錯誤資料已省略/);
});
