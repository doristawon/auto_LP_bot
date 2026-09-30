// Build a clean public source snapshot from tracked files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const requestedOut = process.argv.slice(2).find((arg) => arg.startsWith('--out='))?.slice(6)
  || 'artifacts/public-release';
const out = path.resolve(root, requestedOut);
const artifactsRoot = path.resolve(root, 'artifacts') + path.sep;
if (!out.startsWith(artifactsRoot)) {
  throw new Error('Output must be a new directory inside artifacts/.');
}
if (fs.existsSync(out)) {
  throw new Error(`Output directory already exists; choose a fresh --out path: ${path.relative(root, out)}`);
}

const EXCLUDE = new Set([
  'scripts/bootstrap-moo-lp.js',
  'scripts/deploy-idle-moo-lp.js',
  'scripts/topup-moo-lp.js',
  'scripts/build-public-release.js',
  '.github/workflows/public-release.yml',
  '.env',
  '.env.wallets.json'
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

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function shouldExclude(rel) {
  const name = path.posix.basename(rel);
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  if (/^(?:data|state|logs|_backups|artifacts|node_modules)\//.test(rel)) return true;
  return EXCLUDE.has(rel) || INTERNAL_WORKFLOWS.has(rel) || INTERNAL_TRIGGER_RE.test(path.posix.basename(rel));
}

function writeFile(rel, content) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function sanitizeText(rel, input) {
  if (rel !== '.env.example') return input;
  return input.replace(/^REFERENCE_DEPOSIT_TX=.*$/m, 'REFERENCE_DEPOSIT_TX=');
}

function localSensitiveValues() {
  const values = [];
  const publicRpcHosts = new Set(['rpc.mainnet.chain.robinhood.com']);
  const envFiles = fs.readdirSync(root)
    .filter((name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example'))
    .map((name) => path.join(root, name));
  for (const envPath of envFiles) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(WALLET_ADDRESS|VAULT_ADDRESS|PRIVATE_KEY|DASHBOARD_TOKEN|RPC_URLS?)\s*=\s*(.*?)\s*$/i);
      if (!match) continue;
      const raw = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
      if (!raw || raw.startsWith('#')) continue;
      if (/^RPC_URLS?$/i.test(match[1])) {
        for (const value of raw.split(/[\s,]+/).filter(Boolean)) {
          let hostname = '';
          try { hostname = new URL(value).hostname.toLowerCase(); } catch { /* retain malformed/private values for exact scan */ }
          if (!publicRpcHosts.has(hostname)) {
            values.push({ kind: 'rpc', value });
            try {
              const parsed = new URL(value);
              for (const part of [...parsed.pathname.split('/'), ...parsed.searchParams.values()]) {
                if (part.length >= 12) values.push({ kind: 'rpc-credential', value: part });
              }
            } catch { /* full malformed URL is checked above */ }
          }
        }
      } else {
        values.push({ kind: match[1].toLowerCase(), value: raw });
      }
    }
  }

  const walletsPath = path.join(root, '.env.wallets.json');
  if (fs.existsSync(walletsPath)) {
    const source = fs.readFileSync(walletsPath, 'utf8');
    try {
      const collect = (item, key = '') => {
        if (item && typeof item === 'object') {
          for (const [childKey, childValue] of Object.entries(item)) collect(childValue, childKey);
        } else if (typeof item === 'string' && /address|wallet|vault|private|secret|rpc|token|key/i.test(key) && item.length >= 8) {
          values.push({ kind: /vault/i.test(key) ? 'vault' : /wallet/i.test(key) ? 'wallet' : 'credential', value: item });
        }
      };
      collect(JSON.parse(source));
    } catch {
      // Invalid local configuration is not copied; report no contents.
      throw new Error('Local wallet configuration could not be parsed for the release privacy check.');
    }
  }
  // Wallets and keys may occur inside ABI words without the 0x prefix.
  for (const item of [...values]) {
    if (/^0x[0-9a-f]{40,64}$/i.test(item.value)) values.push({ ...item, value: item.value.slice(2) });
  }
  return values;
}

const secretPatterns = [
  { kind: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:PRIVATE_KEY|GUARD_DEPLOYER_PRIVATE_KEY)\s*=\s*0x[0-9a-f]{64}/i },
  { kind: 'cloud-token', pattern: /\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: 'credential-assignment', pattern: /(?:^|\n)[ \t]*(?:PRIVATE_KEY|GUARD_DEPLOYER_PRIVATE_KEY|DASHBOARD_TOKEN|BLOCKSCOUT_API_KEY)[ \t]*=[ \t]*(?![ \t]*(?:$|#|\.\.\.|<|\$\{))[^\s#]+/m },
  { kind: 'authenticated-url', pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
  { kind: 'local-path', pattern: /(?:[A-Za-z]:\\Users\\[^\\\r\n]+|\/home\/[^/\s]+\/[^\r\n]*)/i },
  { kind: 'email-address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i }
];

fs.mkdirSync(out, { recursive: true });
for (const rel of trackedFiles()) {
  if (shouldExclude(rel)) continue;
  const source = path.join(root, rel);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
  const content = fs.readFileSync(source);
  if (content.includes(0)) throw new Error(`Binary tracked file is not supported in a public source snapshot: ${rel}`);
  writeFile(rel, sanitizeText(rel, content.toString('utf8')));
}

const packagePath = path.join(out, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
delete pkg.scripts['bootstrap:moo'];
if (pkg.scripts.check) {
  pkg.scripts.check = pkg.scripts.check.split('&&').map((part) => part.trim())
    .filter((part) => !/scripts\/(?:bootstrap-moo-lp|topup-moo-lp|deploy-idle-moo-lp)\.js/.test(part))
    .join(' && ');
}
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

writeFile('SECURITY.md', [
  '# Security',
  '',
  'Configure your own wallet and RPC only in Git-ignored local configuration files.',
  '',
  '- Never commit a private key, mnemonic, dashboard token, managed RPC credential, or local `.env` file.',
  '- Use a dedicated wallet with limited capital.',
  '- Keep live writes disabled until the documented guard and canary checks have passed.',
  '- Review transaction calldata, wallet addresses, screenshots, logs, and accounting exports before publishing them.',
  ''
].join('\n'));

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(out);
const localValues = localSensitiveValues().filter(({ value }) => value.length >= 8);
for (const file of files) {
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  const rel = path.relative(out, file).split(path.sep).join('/');
  for (const { kind, pattern } of secretPatterns) {
    if (pattern.test(text)) throw new Error(`Public snapshot privacy scan failed (${kind}): ${rel}`);
  }
  for (const { kind, value } of localValues) {
    if (text.toLowerCase().includes(value.toLowerCase())) {
      throw new Error(`Public snapshot contains a value from local ${kind} configuration: ${rel}`);
    }
  }
}

const manifest = [
  '# Public Release Manifest',
  '',
  'This source snapshot is assembled from tracked project files, omitting local configuration and operational-only files.',
  '',
  `Files: ${files.length}`,
  ''
].join('\n');
writeFile('PUBLIC_RELEASE_MANIFEST.md', manifest);
console.log(`Public source snapshot created at ${path.relative(root, out)} (${files.length} files).`);
