import { type LaunchOption } from '@xmcl/core';
import type { GameLogin } from './auth.ts';
import { download } from './download.ts';
import { privateDirectory } from './workspace.ts';

// Independent unmodified upstream adapter; pin both size and SHA-256 before execution.
export const ADAPTER = Object.freeze({version:'1.2.8',size:349681,
  sha256:'9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10',
  urls:['https://authlib-injector.yushi.moe/artifact/56/authlib-injector-1.2.8.jar',
    'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.8/authlib-injector-1.2.8.jar']});
export async function adapter(root:string):Promise<string> {
  return download({path:'config/authlib-injector-'+ADAPTER.version+'.jar',policy:'managed',size:ADAPTER.size,
    sha256:ADAPTER.sha256,urls:[...ADAPTER.urls]},await privateDirectory(root,'auth-adapter'));
}

export function authenticatedOptions(login:GameLogin, agent?:LaunchOption['yggdrasilAgent']):Pick<LaunchOption,'gameProfile'|'accessToken'|'userType'|'yggdrasilAgent'> {
  if (!/^[a-f0-9]{32}$/.test(login.profile.id) || !/^[A-Za-z0-9_]{3,16}$/.test(login.profile.name)
    || !/^[\x21-\x7e]{1,16384}$/.test(login.accessToken)) throw new Error('Invalid verified game identity');
  if (login.kind==='premium') {
    if (agent) throw new Error('Premium sessions must use unmodified Mojang authentication');
    // The pinned XMCL runtime defaults to msa; its older type declaration omits msa.
    return {gameProfile:login.profile,accessToken:login.accessToken};
  }
  if (login.kind!=='offline' || !agent || !/^[a-f0-9]{64}$/i.test(login.accessToken)) throw new Error('Verified external account requires its authentication adapter');
  return {gameProfile:login.profile,accessToken:login.accessToken,userType:'mojang',yggdrasilAgent:agent};
}
