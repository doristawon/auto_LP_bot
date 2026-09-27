import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAuditRange } from '../src/tools/audit-wallet-range.js';

test('audit classifies the lower tick as in-range under Uniswap semantics', () => {
  assert.deepEqual(assessAuditRange(100, 100, 200), {
    outside: false,
    nearEdge: false,
    autoAction: 'HOLD_IN_RANGE'
  });
});

test('near-edge remains informational while the LP is still in range', () => {
  assert.deepEqual(assessAuditRange(105, 100, 200, 10), {
    outside: false,
    nearEdge: true,
    autoAction: 'HOLD_IN_RANGE_NEAR_EDGE'
  });
});

test('only true out-of-range positions request bot confirmation', () => {
  assert.deepEqual(assessAuditRange(99, 100, 200, 10), {
    outside: true,
    nearEdge: false,
    autoAction: 'WAIT_FOR_BOT_CONFIRMATION'
  });
  assert.equal(assessAuditRange(200, 100, 200).outside, true);
});
