import { promises as fs } from 'node:fs';
import { atomicJson, exists } from './workspace.ts';

export interface SecretStorage {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export class Vault {
  private file: string;
  private storage: SecretStorage;
  constructor(file: string, storage: SecretStorage) {this.file=file;this.storage=storage;}
  private async regular() {
    if (!await exists(this.file)) return;
    const stat = await fs.lstat(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('无效的加密账户文件');
  }
  private ready() {
    if (!this.storage.available()) throw new Error('系统安全凭据存储不可用，请启用钥匙串／密钥环后重试；不会改用明文保存');
  }
  async load(): Promise<unknown | null> {
    await this.regular();
    if (!await exists(this.file)) return null;
    this.ready();
    try {
      const envelope = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (envelope.schemaVersion !== 1 || typeof envelope.ciphertext !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw new Error();
      const plain = this.storage.decrypt(Buffer.from(envelope.ciphertext, 'base64'));
      if (Buffer.byteLength(plain) > 64 * 1024) throw new Error();
      return JSON.parse(plain);
    } catch { throw new Error('无法解密账户文件，请退出账号后重新登录'); }
  }
  async save(value: unknown) {
    this.ready(); await this.regular();
    const plain = JSON.stringify(value);
    if (Buffer.byteLength(plain) > 64 * 1024) throw new Error('账户数据过大');
    let cipher: Buffer;
    try { cipher = this.storage.encrypt(plain); } catch { throw new Error('系统凭据加密失败'); }
    if (!cipher.length || cipher.length > 96 * 1024) throw new Error('系统凭据加密失败');
    await atomicJson(this.file, { schemaVersion: 1, ciphertext: cipher.toString('base64') });
  }
  async clear() { await this.regular(); if (await exists(this.file)) await fs.unlink(this.file); }
}
