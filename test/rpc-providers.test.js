import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProviders, probeRpcEndpoint } from '../src/rpc/providers.js';

test('RPC provider applies the configured request timeout without network access', () => {
  const providers = createProviders({
    chainId: 4663,
    rpcUrls: ['https://rpc.example.invalid'],
    rpcRequestTimeoutMs: 12_000
  });

  assert.equal(providers.rawProviders[0]._getConnection().timeout, 12_000);
  assert.equal(providers.writeProvider._getConnection().timeout, 12_000);
});

async function withRpcServer(handler, fn) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    handler(JSON.parse(raw), res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/secret/path`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('RPC probe verifies chain and block and exposes no endpoint URL', async () => {
  await withRpcServer((request, res) => {
    const result = request.method === 'eth_chainId' ? '0x1237' : '0x2a';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }, async (url) => {
    const result = await probeRpcEndpoint(url, 4663);
    assert.equal(result.reachable, true);
    assert.equal(result.chainValid, true);
    assert.equal(result.blockNumber, 42);
    assert.equal(result.errorType, null);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});

test('RPC probe classifies 429 as rate_limited without retrying', async () => {
  let requests = 0;
  await withRpcServer((_request, res) => {
    requests += 1;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limit' }));
  }, async (url) => {
    const result = await probeRpcEndpoint(url, 4663);
    assert.equal(result.errorType, 'rate_limited');
    assert.equal(requests, 1);
  });
});

test('RPC probe classifies exhausted credits separately from rate limits', async () => {
  await withRpcServer((_request, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment required' }));
  }, async (url) => {
    const result = await probeRpcEndpoint(url, 4663);
    assert.equal(result.errorType, 'quota_exhausted');
  });
});

test('RPC probe classifies explicit exhausted credits in a 429 body as quota_exhausted without retrying', async () => {
  let requests = 0;
  await withRpcServer((_request, res) => {
    requests += 1;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'API credits exhausted' }));
  }, async (url) => {
    const result = await probeRpcEndpoint(url, 4663);
    assert.equal(result.errorType, 'quota_exhausted');
    assert.equal(requests, 1);
  });
});
