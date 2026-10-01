import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// State files are atomically written with JSON.stringify by the bot. Keep
// property names case-sensitive and emit only the execution phase to PowerShell.
export function readPendingExecutionPhase(source) {
  const state = JSON.parse(source);
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    throw new TypeError('Invalid state settings shape');
  }
  if (!Object.hasOwn(state.settings, 'activeRebalanceExecution')
    || state.settings.activeRebalanceExecution === null) return null;
  const journal = state.settings.activeRebalanceExecution;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || typeof journal.phase !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(journal.phase)) {
    throw new TypeError('Invalid active execution shape');
  }
  return journal.phase;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) process.exit(2);
    const phase = readPendingExecutionPhase(fs.readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(phase ?? 'none');
  } catch {
    process.exitCode = 2;
  }
}
