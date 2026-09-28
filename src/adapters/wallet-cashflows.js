import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PUBLIC_EXPLORER = 'https://robinhoodchain.blockscout.com/api/v2/';
const PRO_EXPLORER = 'https://api.blockscout.com/4663/api/v2/';
const MAX_PAGES_PER_FEED = 20;

export async function fetchWalletCashflowCandidates({ wallet, usdgAddress, sinceMs, apiKey = '',
  fetchPage = fetchBlockscoutPage }) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || !/^0x[0-9a-f]{40}$/i.test(usdgAddress)) {
    throw new Error('Invalid wallet or USDG address for cashflow history');
  }
  const stem = `addresses/${wallet.toLowerCase()}/`;
  const feeds = [
    { type: 'usdg', direction: 'in', path: `${stem}token-transfers`, query: { type: 'ERC-20', filter: 'to', token: usdgAddress.toLowerCase() } },
    { type: 'usdg', direction: 'out', path: `${stem}token-transfers`, query: { type: 'ERC-20', filter: 'from', token: usdgAddress.toLowerCase() } },
    { type: 'eth', direction: 'in', path: `${stem}transactions`, query: { filter: 'to' } },
    { type: 'eth', direction: 'out', path: `${stem}transactions`, query: { filter: 'from' } }
  ];
  const candidates = [];
  for (const feed of feeds) {
    let nextPage = null;
    let complete = false;
    for (let page = 0; page < MAX_PAGES_PER_FEED; page += 1) {
      const data = await fetchPage(feed.path, { ...feed.query, ...(nextPage || {}) }, { apiKey });
      if (!Array.isArray(data?.items)) throw new Error('Explorer cashflow page is malformed');
      const items = data.items;
      for (const item of items) {
        const timestamp = Date.parse(item.timestamp);
        if (!Number.isFinite(timestamp)) throw new Error('Explorer cashflow timestamp is invalid');
        if (timestamp >= sinceMs) {
          candidates.push({ type: feed.type, direction: feed.direction, timestamp, item });
        }
      }
      const oldest = items.length ? Date.parse(items.at(-1).timestamp) : 0;
      nextPage = data.next_page_params;
      if (!nextPage || !items.length || (Number.isFinite(oldest) && oldest < sinceMs)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error('Explorer cashflow history exceeded page cap; accounting remains provisional');
  }
  return candidates;
}

export async function fetchEthUsdCloseAt(timestamp, fetchImpl = fetch) {
  const minute = Math.floor(Number(timestamp) / 60_000) * 60_000;
  if (!Number.isFinite(minute)) throw new Error('Invalid ETH transfer timestamp');
  const url = new URL('https://api.exchange.coinbase.com/products/ETH-USD/candles');
  url.searchParams.set('start', new Date(minute).toISOString());
  url.searchParams.set('end', new Date(minute + 60_000).toISOString());
  url.searchParams.set('granularity', '60');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Historical ETH/USD price HTTP ${response.status}`);
  const candles = await response.json();
  const row = Array.isArray(candles) ? candles.find((item) => Number(item?.[0]) === minute / 1000) : null;
  const close = Number(row?.[4]);
  if (!(close > 0)) throw new Error('Historical ETH/USD candle unavailable');
  return close;
}

export async function fetchNativeBalanceAt({ wallet, atMs, apiKey = '',
  fetchPage = fetchBlockscoutPage }) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || !Number.isFinite(Number(atMs))) {
    throw new Error('Invalid wallet or baseline timestamp for ETH balance history');
  }
  const path = `addresses/${wallet.toLowerCase()}/coin-balance-history`;
  let nextPage = {};
  for (let page = 0; page < MAX_PAGES_PER_FEED; page += 1) {
    const data = await fetchPage(path, nextPage, { apiKey });
    if (!Array.isArray(data?.items)) throw new Error('Explorer ETH balance page is malformed');
    for (const item of data.items) {
      const timestamp = Date.parse(item.block_timestamp);
      if (!Number.isFinite(timestamp)) throw new Error('Explorer ETH balance timestamp is invalid');
      if (timestamp <= atMs) {
        return { amount: Number(BigInt(item.value)) / 1e18,
          blockNumber: Number(item.block_number), observedAt: timestamp };
      }
    }
    if (!data.next_page_params || !data.items.length) return { amount: 0, blockNumber: null, observedAt: null };
    nextPage = data.next_page_params;
  }
  throw new Error('Explorer ETH baseline history exceeded page cap');
}

export async function fetchBlockscoutPage(path, query, { apiKey = '' } = {}) {
  const base = apiKey ? PRO_EXPLORER : PUBLIC_EXPLORER;
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  if (apiKey) url.searchParams.set('apikey', apiKey);
  if (process.platform === 'win32' && !apiKey) {
    const script = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";'
      + '$r=Invoke-RestMethod -Uri $env:LP_BOT_EXPLORER_URL -TimeoutSec 20;'
      + '$r|ConvertTo-Json -Compress -Depth 40';
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], {
      env: { ...process.env, LP_BOT_EXPLORER_URL: url.toString() },
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    return JSON.parse(stdout);
  }
  const response = await fetch(url, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Blockscout cashflow HTTP ${response.status}`);
  return response.json();
}
