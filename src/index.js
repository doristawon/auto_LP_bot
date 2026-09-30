import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { AutoLpBot } from './bot.js';
import { WalletFleet } from './wallet-fleet.js';
import { DashboardServer } from './dashboard/server.js';
import { log } from './logger.js';

loadDotEnv();
const config = loadConfig();
const once = process.argv.includes('--once');
const dashboardOnly = process.argv.includes('--dashboard-only');
const fleet = once ? null : new WalletFleet(config);
const bot = fleet?.primary || new AutoLpBot(config);
const dashboard = new DashboardServer(config, bot, bot.ledger, bot.points, fleet);

let shutdownPromise = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shutdownPromise) return;
    shutdownPromise = (async () => {
      log('info', 'bot.stopping', { signal });
      (fleet || bot).stop();
      await (fleet || bot).waitForCycleIdle();
      await dashboard.stop();
      log('info', 'bot.stopped', { signal });
    })().catch((error) => {
      log('error', 'bot.shutdown_failed', { error: error.stack || error.message });
      process.exitCode = 1;
    });
  });
}

try {
  if (dashboardOnly) {
    await dashboard.start();
  } else if (once) {
    await bot.initialize();
    await bot.runOnce();
  } else {
    await dashboard.start();
    await fleet.start();
  }
} catch (error) {
  log('error', 'bot.fatal', { error: error.stack || error.message });
  process.exitCode = 1;
}
