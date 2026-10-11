import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { remoteRelease, distributionProfile } from '../src/remote.ts';

test('remote Stable updates verify signatures, reuse bytes and never activate while game is running',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weco-remote-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');const pem=publicKey.export({type:'spki',format:'pem'}).toString();
  const id=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex').slice(0,16);
  let envelope:unknown;let hits=0;let broken=false;
  const server=createServer((req,res)=>{if(req.url==='/stable.json'){if(broken){res.statusCode=503;res.end();}else res.end(JSON.stringify(envelope));}
    else if(req.url==='/artifact'){hits++;res.end('mod fixture');}else{res.statusCode=404;res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const release={schemaVersion:1,channel:'stable',releaseId:'stable-1',sequence:1,activation:'active',minecraft:'1.21.1',neoforge:'21.1.250',
    platforms:['darwin-arm64','darwin-x64','win32-x64','linux-x64'],files:[{path:'mods/example.jar',size:11,
      sha256:createHash('sha256').update('mod fixture').digest('hex'),policy:'managed',urls:[base+'/artifact']}]};
  const signed=()=>{const payload=JSON.stringify(release);return{keyId:id,payload,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};};envelope=signed();
  await assert.rejects(remoteRelease(base+'/stable.json',{},true),/可信发布公钥/);assert.equal(hits,0);
  const runtime=new Runtime(path.join(dir,'data'),()=>{});await runtime.initialize();
  await runtime.configure({manifestAddress:base+'/stable.json',channel:'stable',localFixtures:true});const file=path.join(dir,'public.pem');await fs.writeFile(file,pem);await runtime.trustKey(file);
  await runtime.updateRemote();assert.equal(hits,1);assert.equal(runtime.state.releaseId,null,'no runtime yet: only predownload');
  await runtime.configure({versionId:'fixture-runtime'});await runtime.updateRemote();assert.equal(runtime.state.releaseId,'stable-1');assert.equal(hits,1);
  await runtime.updateRemote();assert.equal(hits,1);assert.equal(await fs.readFile(path.join(runtime.state.settings.workspace,'game','mods','example.jar'),'utf8'),'mod fixture');
  runtime.state.gamePid=process.pid;await assert.rejects(runtime.updateRemote(),/already running/);runtime.state.gamePid=null;
  envelope={...signed(),signature:Buffer.alloc(64).toString('base64')};await assert.rejects(runtime.updateRemote(),/signature/);assert.equal(runtime.state.releaseId,'stable-1');
  envelope=signed();broken=true;await assert.rejects(runtime.updateRemote(),/503/);assert.equal(runtime.state.releaseId,'stable-1');
  broken=false;release.sequence=2;release.releaseId='stable-2';envelope=signed();await runtime.updateRemote();assert.equal(runtime.state.releaseId,'stable-2');assert.equal(hits,1);
});
test('bundled public profile configures new players without overwriting persisted choices or accepting secrets',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weco-profile-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const {publicKey}=generateKeyPairSync('ed25519');const profile={schemaVersion:1,authAddress:'https://auth.example.invalid',manifestAddress:'https://cos.example.invalid/stable.json',serverAddress:'play.example.invalid',serverPort:25565,publicKeys:[publicKey.export({type:'spki',format:'pem'}).toString()]};
  const runtime=new Runtime(path.join(dir,'data'),()=>{});await runtime.initialize(profile);assert.equal(runtime.state.settings.channel,'stable');assert.equal(runtime.state.settings.autoConnect,true);assert.equal(runtime.state.trustedKeys,1);
  await runtime.configure({memoryMiB:6144,serverAddress:'chosen.example.invalid'});
  const reload=new Runtime(path.join(dir,'data'),()=>{});await reload.initialize(profile);assert.equal(reload.state.settings.memoryMiB,6144);assert.equal(reload.state.settings.serverAddress,'chosen.example.invalid');
  assert.throws(()=>distributionProfile({...profile,apiKey:'must-never-be-packed'}),/Invalid/);
  assert.throws(()=>distributionProfile({...profile,manifestAddress:'https://cos.example.invalid?secret=x'}),/query/);
});
