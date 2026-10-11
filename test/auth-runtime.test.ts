import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';

test('runtime auth operations are serialized, remember only encrypted sessions, and gate unverified launch',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weco-runtime-auth-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const key=randomBytes(32);const storage={available:()=>true,encrypt(plain:string){const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(plain,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);},
    decrypt(b:Buffer){const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');}};
  const token='b'.repeat(64);let hits=0;
  const server=createServer(async(req,res)=>{
    hits++;const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    if(req.url==='/api/v1/register'){
      assert.equal(body.password,'correct horse battery');res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({account:{id:'183eb6c4-854b-4a10-b24c-f390d12df445',profile_id:'b50ad385-829d-3141-a216-7e7d7539ba7f',name:'TownTester',kind:'offline',status:'pending'},account_token:token,challenge:'a'.repeat(64),expires_in:600}));
    }else if(req.url==='/api/v1/logout'){assert.equal(req.headers.authorization,'Bearer '+token);res.statusCode=204;res.end();}
    else{res.statusCode=404;res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const data=path.join(dir,'profile');const runtime=new Runtime(data,()=>{},storage);await runtime.initialize();
  await assert.rejects(runtime.launch(),/请先登录/);assert.equal(hits,0);
  await assert.rejects(runtime.configure({authAddress:'http://example.invalid'}),/HTTPS/);
  await runtime.configure({localFixtures:true,authAddress:'http://127.0.0.1:'+(server.address() as {port:number}).port,channel:'stable'});
  await runtime.authenticate({action:'register',name:'TownTester',password:'correct horse battery'});
  assert.equal(runtime.state.auth.account?.status,'pending');assert.equal(runtime.state.phase,'idle');
  assert.ok(!JSON.stringify(runtime.state).includes(token));assert.ok(!JSON.stringify(runtime.state).includes('correct horse battery'));
  runtime.log('arbitrary transport dump '+token);assert.ok(runtime.state.logs.at(-1)?.includes('[redacted]'));
  const settings=await fs.readFile(path.join(data,'settings.json'),'utf8');assert.ok(!settings.includes(token));
  await assert.rejects(runtime.launch(),/QQ/);assert.equal(hits,1);
  await assert.rejects(runtime.configure({authAddress:'https://other.example.invalid'}),/退出账号/);
  const restored=new Runtime(data,()=>{},storage);await restored.initialize();assert.equal(restored.state.auth.account?.name,'TownTester');
  restored.state.gamePid=process.pid;await assert.rejects(restored.authenticate({action:'logout'}),/already running/);assert.equal(hits,1);restored.state.gamePid=null;
  await restored.authenticate({action:'logout'});assert.equal(restored.state.auth.account,null);assert.equal(hits,2);
  await assert.rejects(fs.stat(path.join(data,'accounts-v1.enc.json')),{code:'ENOENT'});
  await assert.rejects(restored.authenticate({action:'login',accessToken:'injected'} as never),/Invalid/);
});
