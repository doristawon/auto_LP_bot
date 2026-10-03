import http from 'node:http';
import { getAddress, Wallet } from 'ethers';
import { dashboardPage } from './page.js';
import { log, sanitize } from '../logger.js';

export class DashboardServer {
  constructor(config, bot, ledger, pointsTracker, fleet = null) {
    this.config = config;
    this.bot = bot;
    this.fleet = fleet;
    this.ledger = ledger;
    this.pointsTracker = pointsTracker;
    this.server = null;
  }

  async start() {
    if (!this.config.dashboardEnabled || this.server) return;
    const loopback = isLoopbackHost(this.config.dashboardHost);
    if (!loopback && !this.config.dashboardToken) {
      throw new Error('DASHBOARD_TOKEN is required when dashboard binds outside loopback');
    }
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      log('error', 'dashboard.request_failed', { error: error.message });
      sendJson(res, 500, { error: sanitize(error.message) });
    }));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.dashboardPort, this.config.dashboardHost, resolve);
    });
    log('info', 'dashboard.started', { host: this.config.dashboardHost, port: this.config.dashboardPort });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async handle(req, res) {
    if (!isAllowedDashboardHost(req, this.config.dashboardHost)) {
      return sendJson(res, 403, { error: 'invalid host' });
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, dashboardPage());
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      return sendJson(res, 200, { tokenRequired: !isLoopbackHost(this.config.dashboardHost) });
    }
    if (!this.authorized(req, url)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && !sameOriginRequest(req)) return sendJson(res, 403, { error: 'same-origin request required' });
    if (req.method === 'GET' && url.pathname === '/api/wallets') {
      return sendJson(res, 200, { defaultWalletAddress: this.fleet?.defaultWalletAddress || this.bot.config.walletAddress,
        wallets: this.fleet ? this.fleet.list() : (await this.bot.controlStatus()).walletProfiles || [] });
    }
    // Capture identity once per request. Never switch a shared server field while
    // another wallet's asynchronous request is in flight.
    let bot;
    try { bot = this.fleet ? this.fleet.getBot(req.headers['x-wallet-address']) : this.bot; }
    catch (error) { return sendJson(res, 404, { error: sanitize(error.message) }); }
    const ledger = bot.ledger || this.ledger;
    const pointsTracker = bot.points || this.pointsTracker;
    const rpcBot = this.fleet?.primary || bot;
    if (req.method === 'GET' && url.pathname === '/api/execution/status') {
      return sendJson(res, 200, bot.getExecutionStatus());
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/live') {
      if (!this.fleet) return sendJson(res, 409, { error: '多錢包管理尚未啟用。' });
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled 必須為布林值。' });
      try { return sendJson(res, 200, await this.fleet.setLive(bot.config.walletAddress, body.enabled)); }
      catch (error) { return sendJson(res, 409, { error: sanitize(error.message) }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        running: this.fleet ? this.fleet.running : Boolean(bot.running),
        cycleActive: this.fleet ? [...this.fleet.bots.values()].some(worker => worker.cycleActive) : Boolean(bot.cycleActive),
        wallets: this.fleet?.list(),
        lastSnapshotAt: bot.snapshot?.generatedAt || null
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const snapshot = bot.snapshot || ledger.readSnapshot() || emptySnapshot(bot);
      const markets = liveMarketSnapshot(bot);
      return sendJson(res, 200, {
        ...snapshot,
        blockNumber: snapshot.blockNumber ?? bot.market?.latestBlock ?? null,
        markets: markets.length ? markets : (snapshot.markets || []),
        rpcHealth: bot.rpcHealth?.length ? bot.rpcHealth : (snapshot.rpcHealth || [])
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings/rpc') {
      return sendJson(res, 200, rpcBot.getRpcSettings());
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 250)));
      return sendJson(res, 200, {
        events: ledger.list({
          limit,
          excludeTypes: new Set(['points.global_swap_fee', 'portfolio.snapshot'])
        })
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/control/status') {
      const status = await bot.controlStatus();
      return sendJson(res, 200, {
        ...status,
        multiWallet: Boolean(this.fleet),
        ...(this.fleet ? { walletProfiles: this.fleet.list(bot.config.walletAddress) } : {}),
        manualControlEnabled: Boolean(this.config.dashboardManualControlEnabled)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/intervals') {
      const body = await readJsonBody(req);
      try {
        const intervals = bot.setRuntimeIntervals(body);
        return sendJson(res, 200, { ok: true, intervals });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || '更新週期設定失敗') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/range-policy') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, { ok: true, policy: bot.setRangePolicy(body) }); }
      catch (error) { return sendJson(res, 400, { error: sanitize(error.message || '更新區間外規則失敗') }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/reconcile-manual-lp') {
      try { return sendJson(res, 200, { ok: true, recovery: await bot.resolveManualRecovery() }); }
      catch (error) { return sendJson(res, 409, { error: sanitize(error.message) }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/risk/stop-loss') {
      return sendJson(res, 200, bot.getStopLossSnapshot());
    }
    if (req.method === 'POST' && url.pathname === '/api/risk/stop-loss') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, { ok: true, stopLoss: bot.setStopLossSettings(body) }); }
      catch (error) { return sendJson(res, 409, { error: sanitize(error.message) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/stop-liquidate') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 202, { ok: true, stopLoss: bot.requestStopLiquidation(body) }); }
      catch (error) { return sendJson(res, 409, { error: sanitize(error.message) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/pause') {
      bot.setExecutionPaused(true, 'dashboard');
      return sendJson(res, 200, { ok: true, executionPaused: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/control/start') {
      const result = await bot.startExecution('dashboard');
      if (!result.ok) return sendJson(res, 409, { error: '啟動條件尚未完成，請查看控制台提示。', blockers: result.blockers });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/control/resume') {
      try {
        const result = await bot.startExecution('dashboard');
        if (!result.ok) return sendJson(res, 409, { error: '啟動條件尚未完成，請查看控制台提示。', blockers: result.blockers });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 409, { error: sanitize(error.shortMessage || error.message) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/scan') {
      if (bot.cycleActive) {
        return sendJson(res, 409, { error: 'monitoring/execution cycle is already running' });
      }
      const snapshot = await bot.runOnce({ executeRebalances: false, source: 'dashboard-scan' });
      return sendJson(res, 200, {
        ok: true,
        blockNumber: snapshot?.blockNumber ?? null,
        generatedAt: snapshot?.generatedAt ?? null
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/pools/quotes/refresh') {
      try {
        const quotes = await bot.refreshPoolQuoteProbes();
        return sendJson(res, 200, { ok: true, quoted: Object.values(quotes).filter((entry) => entry.status === 'quoted').length });
      } catch (error) {
        return sendJson(res, 409, { error: sanitize(error.message) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/points/evidence/refresh') {
      try {
        if (bot.cycleActive) throw new Error('Wait for the current wallet scan to finish');
        const result = await bot.points.refreshEvidence({
          address: bot.config.walletAddress,
          provider: bot.providers.readProvider,
          pools: bot.market.pools,
          prices: bot.market.prices,
          force: true
        });
        bot.updatePointsSnapshot(true);
        return sendJson(res, 200, { ok: result?.ok === true,
          error: result?.error || null });
      } catch (error) {
        return sendJson(res, 409, { error: sanitize(error.message) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/rpc/probe') {
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, await rpcBot.probeRpcById(body.id));
      } catch (error) {
        return sendRpcError(res, error);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/rpc') {
      const body = await readJsonBody(req);
      try {
        if (body.action === 'add') {
          const result = await (this.fleet ? this.fleet.rpcMutation('add', body.url) : bot.addRpcEndpoint(body.url));
          return sendJson(res, 200, result);
        }
        if (body.action === 'remove') {
          const result = await (this.fleet ? this.fleet.rpcMutation('remove', body.id) : bot.removeRpcEndpoint(body.id));
          return sendJson(res, 200, result);
        }
        return sendJson(res, 400, { error: { type: 'invalid_action', message: '請求的 RPC 操作無效。' } });
      } catch (error) {
        return sendRpcError(res, error);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/import') {
      const body = await readJsonBody(req);
      const type = String(body.type || '').trim().toLowerCase();
      let address = '';
      let privateKey = '';
      try {
        const secret = String(body.secret || '').trim();
        if (type === 'watch-only') {
          address = getAddress(secret);
        } else if (type === 'private-key') {
          const normalized = /^0x/i.test(secret) ? secret : '0x' + secret;
          const signer = new Wallet(normalized);
          address = signer.address;
          privateKey = signer.privateKey;
        } else if (type === 'mnemonic') {
          const phrase = secret.replace(/\s+/g, ' ');
          const signer = Wallet.fromPhrase(phrase);
          address = signer.address;
          privateKey = signer.privateKey;
        } else {
          body.secret = '';
          return sendJson(res, 400, { error: 'Wallet type must be mnemonic, private-key, or watch-only' });
        }
      } catch {
        body.secret = '';
        return sendJson(res, 400, { error: 'Wallet input did not validate; nothing was mounted' });
      }
      body.secret = '';
      try {
        const result = await (this.fleet || bot).mountWallet(address, privateKey, type);
        privateKey = '';
        return sendJson(res, 200, { ...result, persisted: Boolean(this.config.persistRuntimeCredentials) });
      } catch (error) {
        privateKey = '';
        return sendJson(res, 409, { error: sanitize(error.message || 'Wallet could not be mounted') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/wallet/select') {
      const body = await readJsonBody(req);
      try {
        if (this.fleet) {
          const selected = this.fleet.getBot(body.address);
          return sendJson(res, 200, { ok: true, address: selected.config.walletAddress, status: selected.walletImportState.status });
        }
        return sendJson(res, 200, bot.switchWallet(body.address));
      }
      catch (error) { return sendJson(res, 409, { error: sanitize(error.message || 'Wallet could not be selected') }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/pools/watch') {
      const body = await readJsonBody(req);
      try {
        const watchedPoolIds = bot.setWatchedPool(body.poolId, Boolean(body.watch));
        return sendJson(res, 200, { ok: true, watchedPoolIds });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || 'Pool could not be updated') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/pools/target') {
      const body = await readJsonBody(req);
      try {
        const target = bot.setExecutionTargetPool(body.poolId);
        return sendJson(res, 200, { ok: true, target });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || 'Execution target could not be updated') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/investment/target') {
      if (typeof bot.getInvestmentAllocationSnapshot === 'function' && (await bot.getInvestmentAllocationSnapshot())?.enabled) {
        return sendJson(res, 409, { error: '兩池配置已啟用；請先切回單池模式再修改單池目標。' });
      }
      const body = await readJsonBody(req);
      try {
        const target = bot.setInvestmentTarget(body.mode, body.poolId);
        return sendJson(res, 200, { ok: true, target });
      } catch (error) {
        return sendJson(res, 400, { error: sanitize(error.message || '再投入目標無法更新') });
      }
    }
    if (url.pathname === '/api/investment/allocation' && req.method === 'GET') {
      try {
        if (typeof bot.getInvestmentAllocationSnapshot !== 'function') {
          return sendJson(res, 503, { error: '兩池配置目前不可用，請稍後重試。' });
        }
        return sendJson(res, 200, await bot.getInvestmentAllocationSnapshot());
      } catch {
        return sendJson(res, 503, { error: '目前無法讀取兩池配置。' });
      }
    }
    if (url.pathname === '/api/investment/allocation' && req.method === 'PUT') {
      let body;
      try { body = await readJsonBody(req); } catch {
        return sendJson(res, 400, { error: '兩池配置格式無效。' });
      }
      const allocations = body.allocations;
      const poolIds = Array.isArray(allocations) ? allocations.map((item) => String(item?.poolId || '').toLowerCase()) : [];
      const validRows = Array.isArray(allocations) && allocations.length <= 2 && allocations.every((item) =>
        item && typeof item.poolId === 'string' && item.poolId.trim() &&
        Number.isInteger(item.weightBps) && item.weightBps > 0 && item.weightBps <= 10000
      );
      const validTotal = body.enabled === false || (validRows && allocations.length > 0 && allocations.reduce((sum, item) => sum + item.weightBps, 0) === 10000);
      if (typeof body.enabled !== 'boolean' || !validRows || new Set(poolIds).size !== poolIds.length || !validTotal) {
        return sendJson(res, 400, { error: '請提供最多兩個池子及有效的啟用狀態。' });
      }
      try {
        if (typeof bot.setInvestmentAllocation !== 'function') {
          return sendJson(res, 503, { error: '兩池配置目前不可用，請稍後重試。' });
        }
        if (bot.allocationUpdatePending) return sendJson(res, 409, { error: '模式切換正在處理，請稍候。' });
        bot.allocationUpdatePending = true;
        try {
          const deadline = Date.now() + 45_000;
          while ((bot.cycleActive || bot.initializing || bot.rpcManagementActive) && Date.now() < deadline) {
            const journal = bot.state?.getSetting('activeRebalanceExecution', null);
            if (bot.executor?.hasPendingWrite || (journal?.phase && !['completed', 'failed'].includes(journal.phase))) {
              return sendJson(res, 409, { error: '錢包交易尚未完成，完成或復原後才能切換模式。' });
            }
            if (body.enabled === false && bot.executionPaused === true && !bot.initializing && !bot.rpcManagementActive) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          const result = await bot.setInvestmentAllocation({ allocations: body.allocations, enabled: body.enabled });
          return sendJson(res, 200, result);
        } finally { bot.allocationUpdatePending = false; }
      } catch (error) {
        const message = String(error.message || '');
        const safe = /current wallet operation|掃描|設定更新/.test(message) ? '目前掃描或設定更新中，請稍後再切換。'
          : /queued wallet transactions|rebalance journal|execution|unfinished/.test(message) ? '錢包交易尚未完成，完成或復原後才能切換模式。'
          : /^[資每啟目錢模]/.test(message) ? sanitize(message) : '兩池配置未儲存；請確認池子與比例。';
        return sendJson(res, 409, { error: safe });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/rebalance') {
      if (!this.config.dashboardManualControlEnabled) {
        return sendJson(res, 403, { error: 'dashboard manual control is not armed' });
      }
      const body = await readJsonBody(req);
      if (String(body.confirm || '') !== 'REBALANCE') {
        return sendJson(res, 400, { error: 'manual rebalance requires confirm=REBALANCE' });
      }
      try {
        const result = await bot.manualRebalance(body.poolId, body.positionId, 'dashboard');
        const status = result?.status === 'blocked' ? 409 : 200;
        return sendJson(res, status, { ok: status === 200, result });
      } catch (error) {
        return sendJson(res, 409, { error: sanitize(error.shortMessage || error.message) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/rotate/preview') {
      if (!this.config.dashboardManualControlEnabled) {
        return sendJson(res, 403, { error: 'dashboard manual control is not armed' });
      }
      if (typeof bot.getInvestmentAllocationSnapshot === 'function' && (await bot.getInvestmentAllocationSnapshot())?.enabled) {
        return sendJson(res, 409, { error: '兩池配置已啟用；切回單池模式後才能立即換倉。' });
      }
      const body = await readJsonBody(req);
      try {
        const preview = await bot.manualImmediateRotation({
          poolId: body.poolId, positionId: body.positionId,
          destinationPoolId: body.destinationPoolId,
          maxCostBps: body.maxCostBps, previewOnly: true
        });
        return sendJson(res, 200, { ok: true, preview });
      } catch (error) {
        return sendJson(res, 409, { error: sanitize(error.message || '立即換倉預演失敗') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/rotate/execute') {
      if (!this.config.dashboardManualControlEnabled) {
        return sendJson(res, 403, { error: 'dashboard manual control is not armed' });
      }
      if (typeof bot.getInvestmentAllocationSnapshot === 'function' && (await bot.getInvestmentAllocationSnapshot())?.enabled) {
        return sendJson(res, 409, { error: '兩池配置已啟用；切回單池模式後才能立即換倉。' });
      }
      const body = await readJsonBody(req);
      if (String(body.confirm || '') !== `ROTATE_TO:${String(body.destinationPoolId || '').toLowerCase()}:${String(body.maxCostBps ?? '')}`) {
        return sendJson(res, 400, { error: 'manual immediate rotation requires target confirmation' });
      }
      try {
        const result = await bot.manualImmediateRotation({
          poolId: body.poolId, positionId: body.positionId,
          destinationPoolId: body.destinationPoolId,
          maxCostBps: body.maxCostBps, previewId: body.previewId,
          previewOnly: false, directExecute: body.direct === true
        });
        return sendJson(res, result?.status === 'completed' ? 200 : 409,
          { ok: result?.status === 'completed', result });
      } catch (error) {
        return sendJson(res, 409, { error: sanitize(error.message || '立即換倉未完成') });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/points/baseline') {
      const body = await readJsonBody(req);
      if (!Number.isFinite(Number(body.points)) || Number(body.points) < 0) return sendJson(res, 400, { error: 'invalid points' });
      const result = pointsTracker.setManualBaseline(Number(body.points), body.at || null);
      bot.updatePointsSnapshot?.(true);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && url.pathname === '/api/cashflow') {
      const body = await readJsonBody(req);
      const usd = Number(body.usd);
      if (!Number.isFinite(usd) || usd === 0) return sendJson(res, 400, { error: 'invalid usd' });
      ledger.append('cashflow.adjustment', { usd, note: String(body.note || '').slice(0, 200) });
      return sendJson(res, 200, { ok: true, usd });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  authorized(req, url) {
    if (isLoopbackHost(this.config.dashboardHost)) return true;
    if (!this.config.dashboardToken) return false;
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const header = String(req.headers['x-dashboard-token'] || '');
    return [bearer, header].includes(this.config.dashboardToken);
  }
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(normalizeHostname(host));
}

function normalizeHostname(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function requestHostname(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw || /[\r\n\s/@?#\\]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function isAllowedDashboardHost(req, dashboardHost) {
  const requested = requestHostname(req.headers.host);
  if (!requested) return false;
  const configured = normalizeHostname(dashboardHost);
  if (isLoopbackHost(configured)) return isLoopbackHost(requested);
  if (['0.0.0.0', '::'].includes(configured)) return true;
  return requested === configured;
}

function sameOriginRequest(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '').toLowerCase();
  if (!origin || !host || /[\r\n]/.test(host)) return false;
  try {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === '127.0.0.1'
      || parsed.hostname === 'localhost'
      || parsed.hostname === '[::1]'
      || parsed.hostname === '::1';
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === host && loopback;
  } catch {
    return false;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function sendRpcError(res, error) {
  const type = new Set(['busy', 'invalid_id', 'invalid_url', 'duplicate', 'last_healthy', 'wrong_chain',
    'timeout', 'rate_limited', 'quota_exhausted', 'http_error', 'transport', 'invalid_response'])
    .has(error?.message) ? error.message : 'transport';
  const messages = {
    busy: '目前掃描或執行流程進行中，請稍後再試。',
    invalid_id: '找不到此 RPC 端點，請重新載入清單。',
    invalid_url: '請輸入有效的 HTTP(S) RPC 網址；網址不可含帳號或密碼。',
    duplicate: '此 RPC 端點已存在。',
    last_healthy: '操作後必須至少保留一個健康的 Robinhood Chain RPC。',
    wrong_chain: 'RPC 無法通過 Robinhood Chain（chain ID 4663）驗證。',
    timeout: 'RPC 檢測逾時。',
    rate_limited: 'RPC 供應商目前正在限流，請稍後重試。',
    quota_exhausted: 'RPC 供應商回報額度或付費點數已用盡。',
    http_error: 'RPC 供應商回傳 HTTP 錯誤。',
    transport: '無法連線至 RPC 供應商。',
    invalid_response: 'RPC 供應商回傳無效資料。'
  };
  return sendJson(res, type === 'busy' || type === 'last_healthy' ? 409 : 400,
    { error: { type, message: messages[type] } });
}
function sendHtml(res, value) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(value);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 128 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try { resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
      finally {
        raw.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    req.on('error', reject);
  });
}
function emptySnapshot(bot) { return { generatedAt: null, bot: { dryRun: bot?.config?.dryRun ?? true, executionPaused: bot?.executionPaused ?? true } }; }
function liveMarketSnapshot(bot) {
  const pools = bot?.market?.pools || [];
  const stats = bot?.market?.fablesStats;
  const watched = new Set((bot?.state?.getSetting('watchedPoolIds', []) || []).map((id) => String(id).toLowerCase()));
  const quoteProbes = bot?.state?.getSetting('poolQuoteProbes', {}) || {};
  return pools.map((pool) => {
    const id = String(pool.id || '').toLowerCase();
    const poolStats = stats?.pools?.get(id) || null;
    return {
      id: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      token0: pool.token0.symbol,
      token1: pool.token1.symbol,
      nativeCurrency: [pool.token0, pool.token1].some((token) =>
        String(token.address).toLowerCase() === '0x0000000000000000000000000000000000000000'),
      tick: pool.state?.tick ?? null,
      paused: pool.state?.paused ?? null,
      watched: watched.has(id),
      tvlUsd: poolStats?.tvlUsd ?? null,
      volume24hUsd: poolStats?.volume24hUsd ?? null,
      fees24hUsd: poolStats?.fees24hUsd ?? null,
      aprPct: poolStats?.aprPct ?? null,
      statsObservedAt: stats?.observedAt ?? null,
      statsSource: stats?.source ?? null,
      statsTvlAvailable: stats?.tvlAvailable ?? null,
      statsVolumeAvailable: stats?.volumeAvailable ?? null,
      swapCostProbe: quoteProbes[id] || null
    };
  });
}
