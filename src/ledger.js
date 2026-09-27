import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitize } from './logger.js';

export class LedgerStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.eventsFile = path.join(dataDir, 'events.jsonl');
    this.snapshotFile = path.join(dataDir, 'latest-snapshot.json');
    this.baselineFile = path.join(dataDir, 'portfolio-baseline.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.events = [];
    this.seenKeys = new Set();
    this.eventsOffset = 0;
    this.pendingBytes = Buffer.alloc(0);
    this.syncError = null;
    this.syncEvents();
  }
  append(type, data = {}, ts = Date.now()) {
    const event = sanitize({ id: crypto.randomUUID(), ts, iso: new Date(ts).toISOString(), type, ...data });
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`);
    this.syncEvents();
    return event;
  }
  appendUnique(eventKey, type, data = {}, ts = Date.now()) {
    this.syncEvents();
    if (this.seenKeys.has(eventKey)) return null;
    return this.append(type, { eventKey, ...data }, ts);
  }
  list({ limit = 250, type = null } = {}) {
    this.syncEvents();
    const out = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = this.events[i];
      if (!type || event.type === type) out.push(event);
    }
    return out;
  }
  all() { this.syncEvents(); return this.events.slice(); }
  writeSnapshot(snapshot) { atomicWrite(this.snapshotFile, JSON.stringify(sanitize(snapshot), null, 2)); }
  readSnapshot() { return readJson(this.snapshotFile, null); }
  readBaseline() {
    if (!fs.existsSync(this.baselineFile)) return null;
    try { return JSON.parse(fs.readFileSync(this.baselineFile, 'utf8')); }
    catch (error) {
      throw new Error(`Portfolio baseline is unreadable; refusing to silently reset accounting: ${this.baselineFile}`,
        { cause: error });
    }
  }
  writeBaseline(baseline) { atomicWrite(this.baselineFile, JSON.stringify(sanitize(baseline), null, 2)); }
  sum(field, type = null) {
    this.syncEvents();
    return this.events.reduce((sum, event) => {
      if (type && event.type !== type) return sum;
      const value = Number(event[field]);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  }

  syncEvents() {
    if (this.syncError) throw this.syncError;
    if (!fs.existsSync(this.eventsFile)) return;
    const size = fs.statSync(this.eventsFile).size;
    if (size < this.eventsOffset) {
      this.events = [];
      this.seenKeys.clear();
      this.eventsOffset = 0;
      this.pendingBytes = Buffer.alloc(0);
    }
    if (size === this.eventsOffset) return;
    const length = size - this.eventsOffset;
    const chunk = Buffer.allocUnsafe(length);
    const fd = fs.openSync(this.eventsFile, 'r');
    try {
      let read = 0;
      while (read < length) {
        const count = fs.readSync(fd, chunk, read, length - read, this.eventsOffset + read);
        if (count === 0) throw new Error('Event ledger changed while being read');
        read += count;
      }
    } finally { fs.closeSync(fd); }
    this.eventsOffset = size;
    const bytes = this.pendingBytes.length ? Buffer.concat([this.pendingBytes, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      const line = bytes.subarray(start, i).toString('utf8').trim();
      start = i + 1;
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch (error) {
        this.syncError = new Error(`Event ledger has a malformed complete row near byte ${this.eventsOffset - bytes.length + start}: ${this.eventsFile}`,
          { cause: error });
        throw this.syncError;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event) || !event.type) {
        this.syncError = new Error(`Event ledger has an invalid event near byte ${this.eventsOffset - bytes.length + start}: ${this.eventsFile}`);
        throw this.syncError;
      }
      this.events.push(event);
      if (event.eventKey) this.seenKeys.add(event.eventKey);
    }
    this.pendingBytes = Buffer.from(bytes.subarray(start));
  }
}

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
