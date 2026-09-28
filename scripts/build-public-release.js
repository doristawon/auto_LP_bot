import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const out = path.join(root, 'public-release');

const EXCLUDE = new Set([
  'docs/POINTS_RECONCILIATION_2026-09-27.md',
  'scripts/bootstrap-moo-lp.js',
  'scripts/deploy-idle-moo-lp.js',
  'scripts/topup-moo-lp.js',
  'scripts/build-public-release.js',
  '.github/workflows/public-release.yml'
]);

const INTERNAL_WORKFLOWS = new Set([
  '.github/workflows/eip7702-probe.yml',
  '.github/workflows/range-policy-backtest.yml',
  '.github/workflows/real-oor-rebalance-smoke.yml',
  '.github/workflows/real-wallet-replay.yml',
  '.github/workflows/reference-deposit-inspect.yml',
  '.github/workflows/reference-swap-inspect.yml',
  '.github/workflows/reference-withdraw-inspect.yml',
  '.github/workflows/v4-swap-sim.yml',
  '.github/workflows/wallet-active-smoke.yml',
  '.github/workflows/wallet-audit.yml',
  '.github/workflows/withdraw-reverse.yml'
]);

const INTERNAL_TRIGGER_RE = /^\.(?:audit|eip7702-probe|inspect|oor-smoke|range-policy|real-replay|smoke|swap-inspect|v4-sim|withdraw-inspect|withdraw-reverse)-trigger$/;

const PERSONAL_WALLET_A = '0x6f196af3b69c521eed9436abc9130699df1c50bf';
const PERSONAL_WALLET_B = '0x2ea3d6f7b1841687324819c239e6f657435fde6e';
const PUBLIC_TEST_WALLET_A = '0x00000000000000000000000000000000000000a1';
const PUBLIC_TEST_WALLET_B = '0x00000000000000000000000000000000000000a2';
const PRIVATE_REFERENCE_DEPOSIT_TX = '0x4473378d0f20e03c647fe0d5b22a482b5700af7638578046d41396b5adf2dd30';
const PRIVATE_EXAMPLE_POOL_ID = '0x31608601d541e868706aa557558a4d4f99c57e6dd13bd3362edcf05d00a16212';
const PRIVATE_MOO_POOL_ID = '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485';

const SYNTHETIC_POOL_ID = '0x' + 'ab'.repeat(32);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function shouldExclude(rel) {
  if (EXCLUDE.has(rel) || INTERNAL_WORKFLOWS.has(rel)) return true;
  if (INTERNAL_TRIGGER_RE.test(rel)) return true;
  return false;
}

function replaceAllInsensitive(text, needle, replacement) {
  const lowerNeedle = needle.toLowerCase();
  let cursor = 0;
  let outText = '';
  while (true) {
    const lower = text.toLowerCase();
    const index = lower.indexOf(lowerNeedle, cursor);
    if (index < 0) {
      outText += text.slice(cursor);
      return outText;
    }
    outText += text.slice(cursor, index) + replacement;
    cursor = index + needle.length;
  }
}

function sanitizeText(rel, input) {
  let text = input;
  text = replaceAllInsensitive(text, PERSONAL_WALLET_A, PUBLIC_TEST_WALLET_A);
  text = replaceAllInsensitive(text, PERSONAL_WALLET_A.slice(2), PUBLIC_TEST_WALLET_A.slice(2));
  text = replaceAllInsensitive(text, PERSONAL_WALLET_B, PUBLIC_TEST_WALLET_B);
  text = replaceAllInsensitive(text, PERSONAL_WALLET_B.slice(2), PUBLIC_TEST_WALLET_B.slice(2));
  text = replaceAllInsensitive(text, PRIVATE_REFERENCE_DEPOSIT_TX, '0x' + '44'.repeat(32));
  text = replaceAllInsensitive(text, PRIVATE_EXAMPLE_POOL_ID, SYNTHETIC_POOL_ID);
  text = replaceAllInsensitive(text, PRIVATE_MOO_POOL_ID, '0x' + 'cd'.repeat(32));

  if (rel === '.env.example') {
    text = text.replace(/^REFERENCE_DEPOSIT_TX=.*$/m, 'REFERENCE_DEPOSIT_TX=');
    text = text.replace(/^# Examples for emergency static lock:[\s\S]*?^# Tight range strategy/m,
      '# Examples for emergency static lock:\n# TARGET_MODE=allowlist\n# TARGET_POOL_IDS=0x' + 'ab'.repeat(32) + '\n\n# Tight range strategy');
  }

  if (rel === 'README.md') {
    text = text.replace(/^# Auto LP Bot — Fables\.fi \/ Robinhood Chain\s*/m,
      '# Auto LP Bot — Fables.fi / Robinhood Chain\n\n> Public release: this snapshot contains no production wallet identity, private transaction fixture, portfolio amount, local credential, or private repository history. Configure your own wallet and RPC only in a Git-ignored local \`.env\`.\n\n');
    text = text.replace(/\bMOO\b/g, 'TOKEN_A');
    text = text.replace(/\bZZZ\b/g, 'TOKEN_B');
  }

  if (rel === 'test/portfolio-cashflow.test.js') {
    text = text
      .replace(/initialValueUsd: 302\.6765/g, 'initialValueUsd: 100')
      .replace(/amount: 852\.384671, usd: 852\.384671/g, 'amount: 250, usd: 250')
      .replace(/amount: 0\.563616, usd: 0\.563616/g, 'amount: 1.25, usd: 1.25')
      .replace(/type === 'fee\.accrual' \? 2\.545415 : 0/g, "type === 'fee.accrual' ? 2.5 : 0")
      .replace(/amount: 1011\.61/g, 'amount: 360')
      .replace(/1011\.61 \+ 0\.002 \* 2645 - 302\.6765 - 852\.384671/g, '360 + 0.002 * 2645 - 100 - 250')
      .replace(/result\.netInvestedUsd, 302\.6765 \+ 852\.384671/g, 'result.netInvestedUsd, 100 + 250')
      .replace(/result\.rewardUsd, 0\.563616/g, 'result.rewardUsd, 1.25');
  }

  return text;
}

const syntheticDepositTest = String.raw\`import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';

const signature = 'deposit((address,address,uint24,int24,address),int24,int24,uint128,uint128,uint128,uint256)';
const abi = [
  'function deposit((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,int24 tickLower,int24 tickUpper,uint128 liquidity,uint128 amount0Max,uint128 amount1Max,uint256 deadline)'
];
const iface = new Interface(abi);

const fixture = {
  key: {
    currency0: '0x0000000000000000000000000000000000000011',
    currency1: '0x0000000000000000000000000000000000000022',
    fee: 0x800000,
    tickSpacing: 60,
    hooks: '0x00000000000000000000000000000000000000f0'
  },
  tickLower: -1200,
  tickUpper: -960,
  liquidity: 123456789012345678n,
  amount0Max: 987654321n,
  amount1Max: 123456789012345678901n,
  deadline: 2000000000
};

test('Fables deposit signature matches verified selector', () => {
  assert.equal(id(signature).slice(0, 10), '0x36a9ca1a');
});

test('synthetic deposit fixture round-trips through the verified ABI', () => {
  const data = iface.encodeFunctionData('deposit', [
    fixture.key,
    fixture.tickLower,
    fixture.tickUpper,
    fixture.liquidity,
    fixture.amount0Max,
    fixture.amount1Max,
    fixture.deadline
  ]);
  assert.equal(data.slice(0, 10), '0x36a9ca1a');
  const decoded = iface.decodeFunctionData('deposit', data);
  assert.equal(String(decoded[0].currency0).toLowerCase(), fixture.key.currency0.toLowerCase());
  assert.equal(String(decoded[0].currency1).toLowerCase(), fixture.key.currency1.toLowerCase());
  assert.equal(Number(decoded[0].fee), fixture.key.fee);
  assert.equal(Number(decoded[0].tickSpacing), fixture.key.tickSpacing);
  assert.equal(String(decoded[0].hooks).toLowerCase(), fixture.key.hooks.toLowerCase());
  assert.equal(Number(decoded[1]), fixture.tickLower);
  assert.equal(Number(decoded[2]), fixture.tickUpper);
  assert.equal(BigInt(decoded[3]), fixture.liquidity);
  assert.equal(BigInt(decoded[4]), fixture.amount0Max);
  assert.equal(BigInt(decoded[5]), fixture.amount1Max);
  assert.equal(Number(decoded[6]), fixture.deadline);
});
\`;

const syntheticWithdrawTest = String.raw\`import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';
import { FablesAdapter } from '../src/adapters/fables.js';

const SIGNATURE = 'withdrawAndClaim((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint16)';
const ABI = [
  'function withdrawAndClaim((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,int24 tickLower,int24 tickUpper,uint128 liquidity,address recipient,uint128 amount0Min,uint128 amount1Min,uint256 deadline,uint16 walk)'
];

test('verified Fables withdrawAndClaim signature matches selector', () => {
  assert.equal(id(SIGNATURE).slice(0, 10), '0x289a2a15');
});

test('adapter encodes a deterministic synthetic withdraw fixture', () => {
  const wallet = '0x00000000000000000000000000000000000000a1';
  const adapter = Object.create(FablesAdapter.prototype);
  adapter.config = { walletAddress: wallet };
  const pool = {
    key: {
      currency0: '0x0000000000000000000000000000000000000011',
      currency1: '0x0000000000000000000000000000000000000022',
      fee: 0x800000,
      tickSpacing: 60,
      hooks: '0x00000000000000000000000000000000000000f0'
    }
  };
  const position = {
    tickLower: -1200,
    tickUpper: -960,
    shares: 123456789012345678n
  };
  const encoded = adapter.encodeWithdrawAndClaim(
    pool,
    position,
    987654321n,
    123456789n,
    2000000000,
    1000
  );
  assert.equal(encoded.slice(0, 10), '0x289a2a15');

  const iface = new Interface(ABI);
  const decoded = iface.decodeFunctionData('withdrawAndClaim', encoded);
  assert.equal(String(decoded[0].currency0).toLowerCase(), pool.key.currency0.toLowerCase());
  assert.equal(String(decoded[0].currency1).toLowerCase(), pool.key.currency1.toLowerCase());
  assert.equal(Number(decoded[0].fee), pool.key.fee);
  assert.equal(Number(decoded[0].tickSpacing), pool.key.tickSpacing);
  assert.equal(Number(decoded[1]), position.tickLower);
  assert.equal(Number(decoded[2]), position.tickUpper);
  assert.equal(BigInt(decoded[3]), position.shares);
  assert.equal(String(decoded[4]).toLowerCase(), wallet.toLowerCase());
  assert.equal(BigInt(decoded[5]), 987654321n);
  assert.equal(BigInt(decoded[6]), 123456789n);
  assert.equal(Number(decoded[7]), 2000000000);
  assert.equal(Number(decoded[8]), 1000);
});
\`;

function writeFile(rel, content) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const rel of trackedFiles()) {
  if (shouldExclude(rel)) continue;
  const source = path.join(root, rel);
  const stat = fs.statSync(source);
  if (!stat.isFile()) continue;
  const content = fs.readFileSync(source);
  if (content.includes(0)) throw new Error(\`Binary tracked file not supported in public release: \${rel}\`);
  writeFile(rel, sanitizeText(rel, content.toString('utf8')));
}

writeFile('test/fables-deposit-real-tx.test.js', syntheticDepositTest);
writeFile('test/fables-withdraw-real-tx.test.js', syntheticWithdrawTest);

const packagePath = path.join(out, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
delete pkg.scripts['bootstrap:moo'];
pkg.scripts.check = pkg.scripts.check
  .split('&&')
  .map((x) => x.trim())
  .filter((x) => !x.includes('scripts/bootstrap-moo-lp.js') && !x.includes('scripts/topup-moo-lp.js') && !x.includes('scripts/deploy-idle-moo-lp.js'))
  .join(' && ');
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

writeFile('SECURITY.md', \`# Security

This public repository intentionally excludes production wallet identities, private transaction fixtures, portfolio snapshots, local credentials, and private Git history.

- Never commit a private key, mnemonic, dashboard token, managed RPC credential, or local \\\`.env\\\`.
- Use a dedicated hot wallet with limited capital.
- Keep \\\`DRY_RUN=true\\\`, \\\`ENABLE_LIVE_WRITES=false\\\`, and \\\`ENABLE_AUTO_REDEPLOY=false\\\` until the documented guard and canary checks have passed.
- Treat copied transaction calldata, wallet addresses, screenshots, logs, and accounting exports as potentially identifying data before publishing them.
\`);

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(out);

const forbiddenExact = [
  PERSONAL_WALLET_A,
  PERSONAL_WALLET_A.slice(2),
  PERSONAL_WALLET_B,
  PERSONAL_WALLET_B.slice(2),
  PRIVATE_REFERENCE_DEPOSIT_TX,
  PRIVATE_EXAMPLE_POOL_ID,
  PRIVATE_MOO_POOL_ID,
  'doristawon@gmail.com',
  'POINTS_RECONCILIATION_2026-09-27'
];

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /(?:^|\n)\s*(?:PRIVATE_KEY|GUARD_DEPLOYER_PRIVATE_KEY|DASHBOARD_TOKEN|BLOCKSCOUT_API_KEY)\s*=\s*(?!\s*(?:$|#|\.\.\.|<))[^\s#]+/m,
  /[A-Za-z]:\\Users\\[^\\\r\n]+/i,
  /\/home\/[^/\s]+\/[^\r\n]*/
];

const findings = [];
for (const file of files) {
  const rel = path.relative(out, file).replaceAll(path.sep, '/');
  const text = fs.readFileSync(file, 'utf8');
  const lower = text.toLowerCase();
  for (const exact of forbiddenExact) {
    if (lower.includes(exact.toLowerCase())) findings.push(\`\${rel}: forbidden exact value \${exact}\`);
  }
  for (const re of secretPatterns) {
    if (re.test(text)) findings.push(\`\${rel}: suspicious secret/private-path pattern \${re}\`);
  }
}

if (findings.length) {
  throw new Error('Public release privacy scan failed:\n' + findings.join('\n'));
}

const manifest = files
  .map((file) => path.relative(out, file).replaceAll(path.sep, '/'))
  .sort();

writeFile('PUBLIC_RELEASE_MANIFEST.md',
  '# Public Release Manifest\n\n'
  + 'Generated from the private production repository without Git history.\n\n'
  + '- Production wallet identities: removed/replaced with synthetic fixtures.\n'
  + '- Production reference transaction hash/calldata fixtures: removed or replaced with synthetic ABI fixtures.\n'
  + '- Production points/portfolio reconciliation note: excluded.\n'
  + '- One-off production pool deployment/top-up scripts: excluded.\n'
  + '- Private/real-wallet CI workflows and trigger files: excluded.\n'
  + '- Local credentials, data, state, logs and artifacts: excluded by tracked-file build and .gitignore.\n'
  + '- Private commit history and author email metadata: not included.\n\n'
  + \`Tracked public files: \${manifest.length}\n\`
);

console.log(\`Public release built: \${manifest.length} files\`);
console.log('Privacy scan: PASS');
