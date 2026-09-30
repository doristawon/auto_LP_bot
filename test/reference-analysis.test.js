import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReferenceArtifact } from '../src/execution/reference-analysis.js';

const topic = '0x1101ae99036692e99100b857ab62c3fcdac65cfdc42b08739812e2e2bbaec38a';
const hook = '0x08e52564bad99e05a694b4809f397edca417a080';
const userTopic = '0x' + '00'.repeat(12) + '55'.repeat(20);
const rangeId = '0x' + '11'.repeat(32);

test('finds deposit hook call and selector from callTracer', () => {
  const artifact = {
    hash: '0xabc',
    transaction: { to: '0x' + '22'.repeat(20), data: '0xdeadbeef', value: '0' },
    receipt: { logs: [{ address: hook, topics: [topic, userTopic, rangeId], data: '0x10', index: 7 }] },
    trace: { type: 'CALL', to: '0x' + '33'.repeat(20), input: '0xaaaa0000', calls: [{ type: 'CALL', to: hook, input: '0x12345678' + '00'.repeat(32), value: '0x0' }] }
  };
  const result = analyzeReferenceArtifact(artifact, topic);
  assert.equal(result.status, 'candidate_calls_found');
  assert.equal(result.deposits[0].hook, hook);
  assert.equal(result.candidateCalls[0].selector, '0x12345678');
  assert.equal(result.deposits[0].liquidity, '16');
});

test('supports parity-style raw trace action shape', () => {
  const artifact = {
    hash: '0xabc',
    receipt: { logs: [{ address: hook, topics: [topic, userTopic, rangeId], data: '0x01' }] },
    blockscout: { rawTrace: [{ type: 'call', action: { to: hook, from: '0x' + '44'.repeat(20), input: '0xaabbccdd00', value: '0x0' } }] }
  };
  const result = analyzeReferenceArtifact(artifact, topic);
  assert.equal(result.candidateCalls.length, 1);
  assert.equal(result.candidateCalls[0].selector, '0xaabbccdd');
});
