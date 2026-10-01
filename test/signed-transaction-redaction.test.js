import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../src/logger.js';
test('broadcast error logs redact signed transactions but keep public hashes', () => {
  const signed = '0x' + 'ab'.repeat(180), hash = '0x' + 'cd'.repeat(32);
  const output = sanitize({ hash, error: `insufficient funds (transaction="${signed}")` });
  assert.equal(output.hash, hash);
  assert.equal(output.error.includes(signed), false);
  assert.equal(output.error.includes('insufficient funds'), true);
});
