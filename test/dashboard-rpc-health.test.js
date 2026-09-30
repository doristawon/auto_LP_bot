import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardPage } from '../src/dashboard/page.js';

test('RPC cards require a successful complete probe before showing healthy', () => {
  const html = dashboardPage();
  const render = html.match(/function renderRpcList\(\)\{[^\n]+/)[0];
  const list = { innerHTML: '' };
  const context = { rpcEndpoints: [], $: () => list, esc: String,
    rpcFaultText: value => value, rpcCheckedAt: String, short: String, busy: false, control: null };
  vm.createContext(context);
  vm.runInContext(render, context);
  const renderHealth = (entry) => {
    context.rpcEndpoints = [{ id: 'rpc-id', label: 'RPC', priority: 1,
      checkedAt: Date.now(), latencyMs: 10, chainId: 4663, ...entry }];
    vm.runInContext('renderRpcList()', context);
    return list.innerHTML;
  };
  assert.match(renderHealth({ reachable: true, chainValid: true, blockNumber: 123,
    errorType: null }), /rpc-state good/);
  assert.doesNotMatch(renderHealth({ reachable: true, chainValid: true, blockNumber: null,
    errorType: 'invalid_response' }), /rpc-state good/);
  assert.doesNotMatch(renderHealth({ reachable: true, chainValid: true, blockNumber: 123,
    errorType: 'rate_limited' }), /rpc-state good/);
});
