import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Vault, type SecretStorage } from '../src/vault.ts';
import { Auth } from '../src/auth.ts';
import { AuthApi, authUrl } from '../src/auth-api.ts';

function storage():SecretStorage {
  const key=randomBytes(32);
  return {available:()=>true,encrypt(plain){const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(plain,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},
    decrypt(b){const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');}};
}

test('auth preserves pending activation and never exposes bearer or candidate code to UI',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'weco-auth-client-'));t.after(()=>fs.rm(directory,{recursive:true}));
  let activated=false;let candidate=false;let rotations=0;let platform='a'.repeat(64);const game='c'.repeat(64);const challenge='d'.repeat(64);
  let mismatch=false;
  const identity={id:'183eb6c4-854b-4a10-b24c-f390d12df445',profile_id:'b50ad385-829d-3141-a216-7e7d7539ba7f',name:'TownTester',kind:'offline',status:'pending'};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    const reply=(code:number,data?:unknown)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');res.end(data?JSON.stringify(data):undefined);};
    if(req.url==='/api/v1/register'){assert.equal(body.password,'correct horse battery');reply(200,{account:identity,account_token:platform,challenge,expires_in:600});return;}
    if(req.url==='/api/v1/premium/device'){reply(503,{error:'configuration missing'});return;}
    if(req.headers.authorization!=='Bearer '+platform){reply(403,{error:'secret error must not be surfaced'});return;}
    if(req.url==='/api/v1/qq/status'){candidate=true;reply(200,{status:'pending',confirmation_code:'1234abcd'});return;}
    if(req.url==='/api/v1/qq/confirm'){assert.equal(candidate,true);assert.equal(body.confirmation_code,'1234abcd');activated=true;identity.status='active';reply(200,{account:identity});return;}
    if(req.url==='/api/v1/session/refresh'){if(!activated){reply(403);return;}rotations++;platform='b'.repeat(63)+String(rotations);reply(200,{account:identity,account_token:platform,expires_in:2592000});return;}
    if(req.url==='/api/v1/game/session'){reply(200,{accessToken:game,selectedProfile:{id:mismatch?'8'.repeat(32):identity.profile_id.replaceAll('-',''),name:identity.name}});return;}
    if(req.url==='/api/v1/logout'){reply(204);return;}
    reply(404);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const cipher=storage();const file=path.join(directory,'accounts.json');const auth=new Auth(new Vault(file,cipher),()=>({authAddress:address,localFixtures:true}));
  await auth.initialize();await auth.offline('TownTester','correct horse battery',true);
  assert.equal(auth.snapshot().account?.status,'pending');assert.equal(auth.snapshot().binding?.command,'/绑定 '+challenge);
  await assert.rejects(auth.game(),/QQ/);assert.equal(rotations,0);
  await auth.bindingStatus();assert.equal(auth.snapshot().binding?.awaitingConfirmation,true);
  assert.ok(!JSON.stringify(auth.snapshot()).includes('1234abcd'));assert.ok(!JSON.stringify(auth.snapshot()).includes(platform));
  assert.equal(activated,false,'server candidate must never activate without explicit owner confirmation');
  await auth.confirm('1234abcd');assert.equal(auth.snapshot().account?.status,'active');assert.equal(rotations,1);
  const gameLogin=await auth.game();assert.equal(gameLogin.accessToken,game);assert.equal(gameLogin.kind,'offline');
  assert.equal(auth.redact('access '+game+' session '+platform),'access [redacted] session [redacted]');
  assert.ok(!JSON.stringify(auth.snapshot()).includes(game));assert.equal(rotations,2);
  const saved=await fs.readFile(file,'utf8');assert.ok(!saved.includes('correct horse battery'));assert.ok(!saved.includes(platform));
  const restored=new Auth(new Vault(file,cipher),()=>({authAddress:address,localFixtures:true}));await restored.initialize();assert.equal(restored.snapshot().account?.name,'TownTester');
  mismatch=true;await assert.rejects(restored.game(),/身份不匹配/);assert.equal(rotations,3);
  const hostile=new Auth(new Vault(file,cipher),()=>({authAddress:'https://other.example.invalid',localFixtures:false}));await assert.rejects(hostile.initialize(),/另一个认证地址/);
  await restored.logout();assert.equal(restored.snapshot().account,null);await assert.rejects(fs.stat(file),{code:'ENOENT'});
});

test('auth requests require HTTPS, never follow credential redirects or echo raw server errors',async t=>{
  assert.throws(()=>authUrl('http://example.invalid',false),/HTTPS/);assert.throws(()=>authUrl('https://example.invalid?secret=x',false),/查询/);
  let visited=0;const server=createServer((req,res)=>{if(req.url==='/api/v1/login'){res.statusCode=302;res.setHeader('Location','/stolen');res.end('secret body');}
    else if(req.url==='/api/v1/register'){res.statusCode=403;res.end('raw password=must-not-echo');}
    else {visited++;res.end('{}');}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const api=new AuthApi('http://127.0.0.1:'+(server.address() as {port:number}).port,true);
  await assert.rejects(api.request('/api/v1/login',{password:'fixture'}),/认证请求失败/);assert.equal(visited,0);
  await assert.rejects(api.request('/api/v1/register',{}),error=>error instanceof Error && !error.message.includes('must-not-echo'));
});
