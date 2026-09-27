import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const POINT_BLOCK_CACHE_LIMIT = 512;

function revisionOf(raw) {
  return raw == null ? null : crypto.createHash('sha256').update(raw).digest('hex');
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

function acquireLock(file) {
  const lockFile = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(lockFile);
        throw error;
      }
      return { fd, lockFile };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt > 0) break;
      try {
        const before = fs.statSync(lockFile);
        const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (processIsRunning(Number(owner.pid))) break;
        const after = fs.statSync(lockFile);
        if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) break;
        fs.unlinkSync(lockFile);
      } catch { break; }
    }
  }
  throw new Error(`State file has another writer or an unreadable lock: ${file}`);
}

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { positions: {}, rebalanceHistory: [], cursors: {}, settings: {} };
    this.revision = null;
    this.load();
  }
  load() {
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, 'utf8');
    try { this.data = { ...this.data, ...JSON.parse(raw) }; }
    catch (error) {
      throw new Error(`State file is unreadable; inspect it and ${this.file}.bak before recovery: ${this.file}`,
        { cause: error });
    }
    this.revision = revisionOf(raw);
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const { fd: lockFd, lockFile } = acquireLock(this.file);
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const previous = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null;
      if (revisionOf(previous) !== this.revision) {
        throw new Error(`State file changed since it was loaded; refusing to overwrite another writer: ${this.file}`);
      }
      const next = JSON.stringify(this.data, null, 2);
      const tmpFd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(tmpFd, next);
        fs.fsyncSync(tmpFd);
      } finally { fs.closeSync(tmpFd); }
      if (previous != null) fs.copyFileSync(this.file, `${this.file}.bak`);
      fs.renameSync(tmp, this.file);
      this.revision = revisionOf(next);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      fs.closeSync(lockFd);
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    }
  }
  getPosition(id) {
    return this.data.positions[id.toLowerCase()] || { outOfRangeConfirmations: 0, cooldownUntil: 0 };
  }
  setPosition(id, patch) {
    const key = id.toLowerCase();
    this.data.positions[key] = { ...this.getPosition(id), ...patch };
    this.save();
  }
  getCursor(key, fallback = 0) {
    return Number(this.data.cursors[key] ?? fallback);
  }
  setCursor(key, value) {
    this.data.cursors[key] = Number(value);
    this.save();
  }
  getSetting(key, fallback = null) {
    return this.data.settings[key] ?? fallback;
  }
  setSetting(key, value) {
    this.data.settings[key] = value;
    if (key.startsWith('pointsBlockAtOrAfter:')) {
      const prefix = 'pointsBlockAtOrAfter:';
      const keys = Object.keys(this.data.settings)
        .filter((item) => item.startsWith(prefix))
        .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
      for (const obsolete of keys.slice(0, Math.max(0, keys.length - POINT_BLOCK_CACHE_LIMIT))) {
        delete this.data.settings[obsolete];
      }
    }
    this.save();
  }
  recordRebalance(entry) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.data.rebalanceHistory = this.data.rebalanceHistory.filter((x) => x.ts >= cutoff);
    this.data.rebalanceHistory.push(entry);
    this.save();
  }
  recentRebalances(windowMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    return this.data.rebalanceHistory.filter((x) => x.ts >= cutoff);
  }
}
