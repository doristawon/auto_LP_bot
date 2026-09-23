import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { AutoLpBot } from './bot.js';
import { log } from './logger.js';

loadDotEnv();
const config = loadConfig();
const bot = new AutoLpBot(config);
const once = process.argv.includes('--once');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'bot.stopping', { signal });
    bot.stop();
  });
}

try {
  await bot.verifyNetwork();
  if (once) await bot.runOnce();
  else await bot.start();
} catch (error) {
  log('error', 'bot.fatal', { error: error.stack || error.message });
  process.exitCode = 1;
}
