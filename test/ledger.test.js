import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/ledger.js';

test('ledger appends and deduplicates event keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ledger-'));
  const ledger = new LedgerStore(dir);
  assert.ok(ledger.appendUnique('a', 'pool.fee', { feeUsd: 2 }));
  assert.equal(ledger.appendUnique('a', 'pool.fee', { feeUsd: 99 }), null);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.sum('feeUsd', 'pool.fee'), 2);
});

test('snapshot and baseline persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ledger-'));
  const ledger = new LedgerStore(dir);
  ledger.writeSnapshot({ hello: 'world' });
  ledger.writeBaseline({ initialValueUsd: 123 });
  assert.equal(ledger.readSnapshot().hello, 'world');
  assert.equal(ledger.readBaseline().initialValueUsd, 123);
});

test('ledger incrementally includes another writer and rejects malformed complete rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ledger-'));
  const first = new LedgerStore(dir);
  const second = new LedgerStore(dir);
  first.append('first', { value: 1 });
  assert.equal(second.list().length, 1);
  assert.equal(second.appendUnique('shared', 'second', { value: 2 }).type, 'second');
  assert.equal(first.appendUnique('shared', 'duplicate'), null);
  fs.appendFileSync(first.eventsFile, '{invalid json}\n');
  assert.throws(() => first.list(), /malformed complete row/);
  assert.throws(() => first.list(), /malformed complete row/);
});

test('corrupt portfolio baseline fails closed instead of resetting PnL history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ledger-'));
  const ledger = new LedgerStore(dir);
  fs.writeFileSync(ledger.baselineFile, '{invalid json');
  assert.throws(() => ledger.readBaseline(), /refusing to silently reset accounting/);
});
