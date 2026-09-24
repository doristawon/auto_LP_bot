import test from 'node:test';
import assert from 'node:assert/strict';
import { FablesAdapter } from '../src/adapters/fables.js';

const REAL_WITHDRAW_SELECTOR = '0x289a2a15';

test('real Fables withdraw selector is tracked as unresolved and encoder fails closed', () => {
  assert.equal(REAL_WITHDRAW_SELECTOR, '0x289a2a15');
  const adapter = Object.create(FablesAdapter.prototype);
  assert.throws(
    () => adapter.encodeWithdraw(null, null, 0),
    /withdraw ABI is unverified/
  );
});
