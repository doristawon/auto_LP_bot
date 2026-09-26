import http from 'node:http';
import { dashboardPage } from './page.js';
import { log } from '../logger.js';

export class DashboardServer {
  constructor(config, bot, ledger, pointsTracker) {
    this.config = config;
    this.bot = bot;
    this.ledger = ledger;
    this.pointsTracker = pointsTracker;
    this.server = null;
  }

  async start() {
    if (!this.config.dashboardEnabled || this.server) return;
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(this.config.dashboardHost);
    const sensitiveControl = Boolean(this.config.enableLiveWrites || this.config.dashboardManualControlEnabled);
    if ((!loopback || sensitiveControl) && !this.config.dashboardToken) {
      throw new Error(
        sensitiveControl
          ? 'DASHBOARD_TOKEN is required whenever live writes or dashboard manual control is enabled'
          : 'DASHBOARD_TOKEN is required when dashboard binds outside loopback'
      );
    }
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      log('error', 'dashboard.request_failed', { error: error.message });
      sendJson(res, 500, { error: error.message });
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
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!this.authorized(req, url)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, dashboardPage());
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, this.bot.snapshot || this.ledger.readSnapshot() || emptySnapshot(this.bot));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 250)));
      return sendJson(res, 200, { events: this.ledger.list({ limit }) });
    }
    if (req.method === 'GET' && url.pathname === '/api/control/status') {
      const status = await this.bot.controlStatus();
      return sendJson(res, 200, {
        ...status,
        manualControlEnabled: Boolean(this.config.dashboardManualControlEnabled)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/control/pause') {
      this.bot.setExecutionPaused(true, 'dashboard');
      return sendJson(res, 200, { ok: true, executionPaused: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/control/resume') {
      try {
        this.bot.setExecutionPaused(false, 'dashboard');
        return sendJson(res, 200, { ok: true, executionPaused: false });
      } catch (error) {
        return sendJson(res, 409, { error: error.shortMessage || error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/control/scan') {
      if (this.bot.cycleActive) {
        return sendJson(res, 409, { error: 'monitoring/execution cycle is already running' });
      }
      const snapshot = await this.bot.runOnce({ executeRebalances: false, source: 'dashboard-scan' });
      return sendJson(res, 200, {
        ok: true,
        blockNumber: snapshot?.blockNumber ?? null,
        generatedAt: snapshot?.generatedAt ?? null
      });
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
        const result = await this.bot.manualRebalance(body.poolId, body.positionId, 'dashboard');
        const status = result?.status === 'blocked' ? 409 : 200;
        return sendJson(res, status, { ok: status === 200, result });
      } catch (error) {
        return sendJson(res, 409, { error: error.shortMessage || error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/points/baseline') {
      const body = await readJsonBody(req);
      if (!Number.isFinite(Number(body.points)) || Number(body.points) < 0) return sendJson(res, 400, { error: 'invalid points' });
      const result = this.pointsTracker.setActualBaseline(Number(body.points), body.at || null);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && url.pathname === '/api/cashflow') {
      const body = await readJsonBody(req);
      const usd = Number(body.usd);
      if (!Number.isFinite(usd) || usd === 0) return sendJson(res, 400, { error: 'invalid usd' });
      this.ledger.append('cashflow.adjustment', { usd, note: String(body.note || '').slice(0, 200) });
      return sendJson(res, 200, { ok: true, usd });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  authorized(req, url) {
    if (!this.config.dashboardToken) return true;
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const header = String(req.headers['x-dashboard-token'] || '');
    const query = url.searchParams.get('token') || '';
    return [bearer, header, query].includes(this.config.dashboardToken);
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function sendHtml(res, value) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(value);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 128 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
function emptySnapshot(bot) { return { generatedAt: null, bot: { dryRun: bot?.config?.dryRun ?? true, executionPaused: bot?.executionPaused ?? true } }; }
