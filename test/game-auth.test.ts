import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateArguments, type ResolvedVersion } from '@xmcl/core';
import { authenticatedOptions, ADAPTER } from '../src/game-auth.ts';
import type { GameLogin } from '../src/auth.ts';

test('real XMCL argument generation keeps premium on Mojang and external sessions on pinned adapter',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'weco-game-auth-'));t.after(()=>fs.rm(dir,{recursive:true}));
  const version = {id:'fixture',minecraftVersion:'1.21.1',mainClass:'net.minecraft.client.main.Main',assets:'17',type:'release',libraries:[],
    arguments:{jvm:[],game:['--username','${auth_player_name}','--uuid','${auth_uuid}','--accessToken','${auth_access_token}','--userType','${user_type}',
      '--clientId','${clientid}','--xuid','${auth_xuid}']}} as unknown as ResolvedVersion;
  const premium:GameLogin={kind:'premium',profile:{id:'069a79f444e94726a5befca90e38aaf5',name:'Notch'},accessToken:'fixture-minecraft-token',xuid:'987654321',clientId:'bc87dd1a17c345b48374986bd67d6bcf'};
  const options={version,javaPath:'java',gamePath:dir,platform:{name:'linux' as const,version:'fixture',arch:'x64'},features:{identity:{clientid:premium.clientId,auth_xuid:premium.xuid}},...authenticatedOptions(premium)};
  const args=await generateArguments(options);
  assert.equal(args[args.indexOf('--userType')+1],'msa');assert.equal(args[args.indexOf('--uuid')+1],premium.profile.id);
  assert.equal(args[args.indexOf('--accessToken')+1],premium.accessToken);assert.equal(args[args.indexOf('--xuid')+1],premium.xuid);
  assert.ok(!args.some(arg=>arg.startsWith('-javaagent:')));
  const agent={jar:path.join(dir,ADAPTER.sha256),server:'https://auth.example.invalid/yggdrasil/',prefetched:Buffer.from('{}').toString('base64')};
  assert.throws(()=>authenticatedOptions(premium,agent),/unmodified/);
  const external:GameLogin={...premium,kind:'offline',accessToken:'a'.repeat(64),xuid:'0'};
  assert.throws(()=>authenticatedOptions(external),/adapter/);
  const externalArgs=await generateArguments({...options,...authenticatedOptions(external,agent)});
  assert.equal(externalArgs[externalArgs.indexOf('--userType')+1],'mojang');
  assert.ok(externalArgs.includes('-javaagent:'+agent.jar+'='+agent.server));
  assert.ok(externalArgs.includes('-Dauthlibinjector.yggdrasil.prefetched='+agent.prefetched));
  assert.equal(ADAPTER.version,'1.2.8');assert.equal(ADAPTER.size,349681);
});
