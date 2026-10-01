import path from 'node:path';
import { AutoLpBot } from './bot.js';
import { WalletVault, validateWalletRecord } from './wallet-vault.js';
import { log, registerSensitiveValues } from './logger.js';
import { isRpcRateLimitError, isRpcTimeoutError } from './rpc/errors.js';
import { walletGuardConfig } from './execution/wallet-guard.js';

const STARTUP_STAGGER_MS = 15_000;
const STARTUP_RETRY_JITTER_MS = 30_000;
const MANAGEMENT_RETRY_MS = 250;

function busy(bot) {
  const phase = bot.state.getSetting('activeRebalanceExecution', null)?.phase;
  return Boolean(bot.cycleActive || bot.initializing || bot.rpcManagementActive ||
    (phase && !['completed', 'failed'].includes(phase)));
}

export class WalletFleet {
  constructor(config, { Bot = AutoLpBot, vault = new WalletVault(undefined, config.persistRuntimeCredentials),
    startupStaggerMs = STARTUP_STAGGER_MS, startupRetryJitterMs = STARTUP_RETRY_JITTER_MS,
    managementRetryMs = MANAGEMENT_RETRY_MS } = {}) {
    this.baseConfig = { ...config, rpcUrls: [...config.rpcUrls] };
    this.Bot = Bot;
    this.vault = vault;
    this.bots = new Map();
    this.records = new Map();
    this.tasks = new Map();
    this.retryTimers = new Set();
    this.launchTimers = new Map();
    this.startupStaggerMs = startupStaggerMs;
    this.startupRetryJitterMs = startupRetryJitterMs;
    this.managementRetryMs = managementRetryMs;
    this.defaultWalletAddress = config.walletAddress;
    this.running = false;
    this.managementActive = false;
    this.primary = new Bot({ ...config, rpcUrls: [...config.rpcUrls] });
    this.bots.set(config.walletAddress.toLowerCase(), this.primary);
    for (const record of vault.read()) {
      const key = record.address.toLowerCase();
      this.records.set(key, record);
      if (key === config.walletAddress.toLowerCase()) {
        // Primary credential remains owned by .env. Only its runtime mode is stored here.
        this.applyMode(this.primary, record);
      } else this.bots.set(key, this.createBot(record));
    }
  }

  createBot(record) {
    registerSensitiveValues([record.privateKey]);
    const dataDir = path.join(this.baseConfig.dataDir, 'wallets', record.address.toLowerCase());
    return new this.Bot({ ...this.baseConfig, rpcUrls: [...this.primary.config.rpcUrls],
      ...walletGuardConfig(this.baseConfig, record.address),
      walletAddress: record.address, privateKey: record.privateKey, dataDir,
      stateFile: path.join(dataDir, 'bot-state.json'),
      targetMode: 'wallet-active', targetPoolIds: [], targetSymbols: [],
      dryRun: !record.live, enableLiveWrites: Boolean(record.live && record.privateKey),
      enableAutoRedeploy: Boolean(record.live && record.privateKey && record.guardVerified),
      eip7702GuardVerified: Boolean(record.guardVerified && record.privateKey),
      eip7702GuardVerificationEnabled: Boolean(record.guardVerified && record.privateKey),
      eip7702GuardVerifiedFor: record.guardVerified ? record.address : '' });
  }

  applyMode(bot, record) {
    bot.config.dryRun = !record.live;
    bot.config.enableLiveWrites = Boolean(record.live && bot.config.privateKey);
    bot.config.enableAutoRedeploy = Boolean(record.live && record.guardVerified && bot.config.privateKey);
    bot.config.eip7702GuardVerified = Boolean(record.guardVerified && bot.config.privateKey);
    bot.config.eip7702GuardVerificationEnabled = bot.config.eip7702GuardVerified;
    bot.config.eip7702GuardVerifiedFor = record.guardVerified ? bot.config.walletAddress : '';
    bot.executor = bot.createExecutor();
  }

  getBot(address = '') {
    const bot = this.bots.get(String(address || this.defaultWalletAddress).toLowerCase());
    if (!bot) throw new Error('錢包尚未匯入；請先在錢包分頁新增。');
    return bot;
  }

  list(selectedAddress = this.defaultWalletAddress) {
    return [...this.bots.values()].map(bot => {
      const target = bot.getInvestmentTargetSnapshot() || {};
      return { address: bot.config.walletAddress,
        type: bot.config.privateKey ? 'private-key' : 'watch-only',
        signerConfigured: Boolean(bot.config.privateKey),
        active: bot.config.walletAddress.toLowerCase() === String(selectedAddress).toLowerCase(),
        executionPaused: bot.executionPaused, dryRun: bot.config.dryRun,
        cycleActive: bot.cycleActive, running: bot.running,
        poolId: target.poolId || null, pair: target.pair || null,
        walletStatus: bot.walletImportState?.status || 'scanning',
        lastSnapshotAt: bot.snapshot?.generatedAt || null,
        recoveryRequired: bot.state.getSetting('activeRebalanceExecution', null)?.phase === 'recovery_required' };
    });
  }

  async mountWallet(address, privateKey, type) {
    if (this.managementActive) throw new Error('RPC 或錢包設定更新中，請稍後再試。');
    const record = validateWalletRecord({ address, privateKey, type, live: false });
    const key = record.address.toLowerCase();
    const existing = this.bots.get(key);
    if (existing && busy(existing)) throw new Error('此錢包正在執行，請等本輪完成。');
    if (existing?.config.privateKey && !record.privateKey) {
      return { ok: true, address: existing.config.walletAddress, status: existing.walletImportState.status };
    }
    if (!existing && this.bots.size >= 20) throw new Error('最多可掛載 20 個錢包。');
    const next = new Map(this.records);
    next.set(key, record);
    this.vault.write([...next.values()]);
    registerSensitiveValues([record.privateKey]);
    let bot;
    if (existing) {
      existing.setExecutionPaused(true, 'dashboard');
      existing.config.privateKey = record.privateKey;
      this.applyMode(existing, record);
      bot = existing;
    } else {
      bot = this.createBot(record);
      bot.resumeExecutionAfterStartup = false;
      bot.setExecutionPaused(true, 'dashboard');
      this.bots.set(key, bot);
    }
    this.records = next;
    if (this.running) this.launch(bot);
    return { ok: true, address: record.address, status: bot.walletImportState.status,
      persisted: this.vault.enabled };
  }

  async setLive(address, enabled) {
    const bot = this.getBot(address);
    if (this.managementActive || busy(bot)) throw new Error('此錢包正在執行，請等本輪完成。');
    this.managementActive = true;
    bot.rpcManagementActive = true;
    try {
      if (enabled) {
        if (!bot.config.privateKey) throw new Error('此錢包尚未匯入簽署金鑰。');
        if (!bot.config.eip7702GuardAddress) throw new Error('尚未設定鏈上安全合約。');
        try { await bot.executor.assertAtomicGuardReady(); }
        catch { throw new Error('此錢包尚未完成 EIP-7702 安全合約授權；需先完成該錢包的設定。'); }
      }
      const record = validateWalletRecord({ address: bot.config.walletAddress,
        privateKey: bot.config.privateKey, live: enabled, guardVerified: Boolean(enabled) });
      const next = new Map(this.records);
      next.set(record.address.toLowerCase(), record);
      this.vault.write([...next.values()]);
      bot.setExecutionPaused(true, 'dashboard');
      this.applyMode(bot, record);
      this.records = next;
      return { ok: true, address: bot.config.walletAddress, dryRun: bot.config.dryRun, executionPaused: true };
    } finally { bot.rpcManagementActive = false; this.managementActive = false; }
  }

  async rpcMutation(action, value) {
    if (this.managementActive || [...this.bots.values()].some(busy)
      || [...this.bots.values()].some(bot => Boolean(bot.globalPointScanPromise))) {
      throw new Error('busy');
    }
    this.managementActive = true;
    const others = [...this.bots.values()].filter(bot => bot !== this.primary);
    for (const bot of others) bot.rpcManagementActive = true;
    try {
      const result = action === 'remove' ? await this.primary.removeRpcEndpoint(value)
        : await this.primary.addRpcEndpoint(value);
      for (const bot of others) {
        await bot.applyRpcUrls(this.primary.config.rpcUrls, this.primary.rpcHealth, { persist: false });
      }
      this.baseConfig.rpcUrls = [...this.primary.config.rpcUrls];
      return result;
    } finally {
      for (const bot of others) bot.rpcManagementActive = false;
      this.managementActive = false;
    }
  }

  launch(bot, { delayMs = 0 } = {}) {
    const key = bot.config.walletAddress.toLowerCase();
    if (this.tasks.has(key) || this.launchTimers.has(key)) return;
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.launchTimers.delete(key);
        this.retryTimers.delete(timer);
        if (this.running) this.launch(bot);
      }, delayMs);
      timer.unref?.();
      this.launchTimers.set(key, timer);
      this.retryTimers.add(timer);
      return;
    }
    // An initialization retry can become due while a fleet RPC probe/apply is
    // awaiting network I/O. Requeue briefly instead of starting against the
    // provider set being mutated.
    if (this.managementActive || bot.rpcManagementActive || bot.initializing) {
      this.launch(bot, { delayMs: this.managementRetryMs });
      return;
    }
    const task = bot.start().catch(error => {
      bot.running = false;
      bot.walletImportState = { status: 'failed', address: bot.config.walletAddress,
        error: '啟動掃描失敗，請檢查 RPC 後重新啟動服務。' };
      log('error', 'wallet.worker_failed', { address: bot.config.walletAddress, error: error.message });
      if (this.running) {
        const backoffMs = this.initializationRetryDelay(bot, error);
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          if (this.running) this.launch(bot);
        }, backoffMs);
        timer.unref?.();
        this.retryTimers.add(timer);
      }
    }).finally(() => this.tasks.delete(key));
    this.tasks.set(key, task);
  }

  initializationRetryDelay(bot, error) {
    const errorTypes = (bot.rpcHealth || []).map(entry => entry?.errorType);
    const baseDelay = errorTypes.some(type => type === 'rate_limited' || type === 'quota_exhausted')
      || isRpcRateLimitError(error) ? 5 * 60_000
      : errorTypes.includes('timeout') || isRpcTimeoutError(error) ? 2 * 60_000 : 60_000;
    const walletIndex = [...this.bots.keys()].indexOf(bot.config.walletAddress.toLowerCase());
    return baseDelay + Math.max(0, walletIndex) * this.startupRetryJitterMs;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    [...this.bots.values()].forEach((bot, index) => this.launch(bot, { delayMs: index * this.startupStaggerMs }));
  }
  stop() {
    this.running = false;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.launchTimers.clear();
    for (const bot of this.bots.values()) bot.stop();
  }
  async waitForCycleIdle() { await Promise.all([...this.bots.values()].map(bot => bot.waitForCycleIdle())); }
}
