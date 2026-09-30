import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistRuntimeCredentials } from '../src/runtime-credentials.js';

const oldAddress = '0x0000000000000000000000000000000000000007';
const newAddress = '0x00000000000000000000000000000000000000aa';
const oldKey = '0x' + '11'.repeat(32);
const newKey = '0x' + '22'.repeat(32);

function withEnv(values, fn) {
  const keys = new Set([...Object.keys(values), 'RPC_URLS', 'WALLET_ADDRESS', 'PRIVATE_KEY', 'EIP7702_GUARD_VERIFIED', 'EIP7702_GUARD_VERIFIED_FOR']);
  const previous = Object.fromEntries([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withEnvFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpbot-credentials-'));
  const filePath = path.join(dir, '.env');
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    return fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('watch-only persistence preserves the existing signer wallet and private key', () => {
  withEnv({
    WALLET_ADDRESS: oldAddress,
    PRIVATE_KEY: oldKey,
    EIP7702_GUARD_VERIFIED: 'true',
    EIP7702_GUARD_VERIFIED_FOR: oldAddress
  }, () => withEnvFile([
    'RPC_URLS=https://old.example',
    `WALLET_ADDRESS=${oldAddress}`,
    `PRIVATE_KEY=${oldKey}`,
    'EIP7702_GUARD_VERIFIED=true',
    `EIP7702_GUARD_VERIFIED_FOR=${oldAddress}`
  ].join('\n'), (filePath) => {
    assert.equal(persistRuntimeCredentials({
      rpcUrls: ['https://new.example'],
      walletAddress: newAddress,
      privateKey: ''
    }, { enabled: true, filePath }), true);

    const saved = fs.readFileSync(filePath, 'utf8');
    assert.match(saved, new RegExp(`WALLET_ADDRESS=${oldAddress}`));
    assert.match(saved, new RegExp(`PRIVATE_KEY=${oldKey}`));
    assert.match(saved, /RPC_URLS=https:\/\/new\.example/);
    assert.match(saved, /EIP7702_GUARD_VERIFIED=true/);
    assert.match(saved, new RegExp(`EIP7702_GUARD_VERIFIED_FOR=${oldAddress}`));
    assert.equal(process.env.WALLET_ADDRESS, oldAddress);
    assert.equal(process.env.PRIVATE_KEY, oldKey);
  }));
});

test('switching signer wallets invalidates wallet-bound guard verification', () => {
  withEnv({
    WALLET_ADDRESS: oldAddress,
    PRIVATE_KEY: oldKey,
    EIP7702_GUARD_VERIFIED: 'true',
    EIP7702_GUARD_VERIFIED_FOR: oldAddress
  }, () => withEnvFile([
    'RPC_URLS=https://old.example',
    `WALLET_ADDRESS=${oldAddress}`,
    `PRIVATE_KEY=${oldKey}`,
    'EIP7702_GUARD_VERIFIED=true',
    `EIP7702_GUARD_VERIFIED_FOR=${oldAddress}`
  ].join('\n'), (filePath) => {
    persistRuntimeCredentials({
      rpcUrls: ['https://new.example'],
      walletAddress: newAddress,
      privateKey: newKey
    }, { enabled: true, filePath });

    const saved = fs.readFileSync(filePath, 'utf8');
    assert.match(saved, new RegExp(`WALLET_ADDRESS=${newAddress}`));
    assert.match(saved, new RegExp(`PRIVATE_KEY=${newKey}`));
    assert.match(saved, /EIP7702_GUARD_VERIFIED=false/);
    assert.match(saved, /EIP7702_GUARD_VERIFIED_FOR=$/m);
    assert.equal(process.env.EIP7702_GUARD_VERIFIED, 'false');
    assert.equal(process.env.EIP7702_GUARD_VERIFIED_FOR, '');
  }));
});

test('same signer wallet can update its key without clearing guard verification', () => {
  withEnv({
    WALLET_ADDRESS: oldAddress,
    PRIVATE_KEY: oldKey,
    EIP7702_GUARD_VERIFIED: 'true',
    EIP7702_GUARD_VERIFIED_FOR: oldAddress
  }, () => withEnvFile([
    'RPC_URLS=https://old.example',
    `WALLET_ADDRESS=${oldAddress}`,
    `PRIVATE_KEY=${oldKey}`,
    'EIP7702_GUARD_VERIFIED=true',
    `EIP7702_GUARD_VERIFIED_FOR=${oldAddress}`
  ].join('\n'), (filePath) => {
    persistRuntimeCredentials({
      rpcUrls: ['https://new.example'],
      walletAddress: oldAddress.toLowerCase(),
      privateKey: newKey
    }, { enabled: true, filePath });

    const saved = fs.readFileSync(filePath, 'utf8');
    assert.match(saved, /EIP7702_GUARD_VERIFIED=true/);
    assert.match(saved, new RegExp(`EIP7702_GUARD_VERIFIED_FOR=${oldAddress}`));
    assert.match(saved, new RegExp(`PRIVATE_KEY=${newKey}`));
  }));
});
