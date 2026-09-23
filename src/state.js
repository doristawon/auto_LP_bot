import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { positions: {}, rebalanceHistory: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      }
    } catch (error) {
      throw new Error(`Unable to load state file: ${error.message}`);
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  getPosition(id) {
    return this.data.positions[id.toLowerCase()] || { outOfRangeConfirmations: 0, cooldownUntil: 0 };
  }

  setPosition(id, patch) {
    const key = id.toLowerCase();
    this.data.positions[key] = { ...this.getPosition(id), ...patch };
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
