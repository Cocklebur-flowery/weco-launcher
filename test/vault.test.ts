import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Vault, type SecretStorage } from '../src/vault.ts';

export function fixtureStorage():SecretStorage {
  const key=randomBytes(32);
  return {available:()=>true, encrypt(plain) {
    const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,nonce);
    const body=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]);
  },decrypt(encrypted) {
    const cipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));cipher.setAuthTag(encrypted.subarray(12,28));
    return Buffer.concat([cipher.update(encrypted.subarray(28)),cipher.final()]).toString('utf8');
  }};
}

test('vault persists only ciphertext with private permissions and rejects tampering',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weco-vault-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const file=path.join(dir,'account.json');const storage=fixtureStorage();const vault=new Vault(file,storage);
  assert.equal(await vault.load(),null);
  await vault.save({platformToken:'secret-platform',refreshToken:'secret-refresh'});
  const stored=await fs.readFile(file,'utf8');assert.ok(!stored.includes('secret-platform'));assert.ok(!stored.includes('secret-refresh'));
  if(process.platform!=='win32') assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  assert.deepEqual(await new Vault(file,storage).load(),{platformToken:'secret-platform',refreshToken:'secret-refresh'});
  const changed=JSON.parse(stored);changed.ciphertext=Buffer.alloc(80).toString('base64');await fs.writeFile(file,JSON.stringify(changed));
  await assert.rejects(vault.load(),/解密/);
  await vault.clear();assert.equal(await vault.load(),null);
});
test('vault does not fall back when OS encryption is absent and rejects symlink targets',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weco-vault-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const file=path.join(dir,'account.json');const vault=new Vault(file,{available:()=>false,encrypt:()=>{throw Error('must not run');},decrypt:()=>{throw Error('must not run');}});
  await assert.rejects(vault.save({secret:'never plaintext'}),/不会改用明文/);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  if(process.platform!=='win32') {
    const outside=path.join(dir,'outside');await fs.writeFile(outside,'untouched');await fs.symlink(outside,file);
    const guarded=new Vault(file,fixtureStorage());await assert.rejects(guarded.save({secret:'x'}),/无效/);await assert.rejects(guarded.clear(),/无效/);
    assert.equal(await fs.readFile(outside,'utf8'),'untouched');
  }
});
