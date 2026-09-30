import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Wallet, getAddress } from 'ethers';

function secure(file) {
  if (process.platform !== 'win32') return fs.chmodSync(file, 0o600);
  const user = process.env.USERNAME;
  if (!user) throw new Error('Windows user unavailable');
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${account}:(F)`,
    '/grant', '*S-1-5-18:(F)', '/grant', '*S-1-5-32-544:(F)'], { stdio: 'ignore', windowsHide: true });
}

export function validateWalletRecord(record) {
  try {
    const address = getAddress(record.address);
    if (/^0x0{40}$/i.test(address)) throw new Error();
    const privateKey = record.privateKey ? new Wallet(record.privateKey).privateKey : '';
    if (privateKey && new Wallet(privateKey).address !== address) throw new Error();
    return { address, privateKey, type: privateKey ? 'private-key' : 'watch-only',
      importedAt: Number(record.importedAt) || Date.now(), live: record.live === true,
      guardVerified: record.guardVerified === true };
  } catch { throw new Error('錢包地址與簽署金鑰不相符，未掛載。'); }
}

// Separate from .env so importing an additional signer never replaces the primary.
export class WalletVault {
  constructor(file = path.resolve('.env.wallets.json'), enabled = true) {
    this.file = path.resolve(file);
    this.enabled = enabled;
  }
  read() {
    if (!this.enabled || !fs.existsSync(this.file)) return [];
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      secure(this.file);
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.wallets) || data.wallets.length > 20) throw new Error();
      const records = data.wallets.map(validateWalletRecord);
      if (new Set(records.map(x => x.address.toLowerCase())).size !== records.length) throw new Error();
      return records;
    } catch { throw new Error('本機額外錢包檔無法安全讀取，請檢查 .env.wallets.json。'); }
  }
  write(records) {
    if (!this.enabled) return false;
    const wallets = records.map(validateWalletRecord);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      if (fs.existsSync(this.file)) {
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      }
      const fd = fs.openSync(temp, 'wx', 0o600);
      fs.closeSync(fd);
      secure(temp);
      fs.writeFileSync(temp, JSON.stringify({ version: 1, wallets }), 'utf8');
      fs.renameSync(temp, this.file);
      return true;
    } catch {
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw new Error('額外錢包尚未安全保存，未變更執行設定。');
    }
  }
}
