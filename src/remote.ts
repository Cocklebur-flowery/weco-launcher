import { createPublicKey, createHash } from 'node:crypto';
import { checkedFetch } from './download.ts';
import { safeUrl, verifyEnvelope, type Release } from './release.ts';
import { object } from './auth-api.ts';

export function manifestUrl(value:string,fixtures=false):string {
  if(value.length>2048 || /\s/.test(value))throw new Error('Invalid manifest address');
  const url=new URL(safeUrl(value,fixtures));if(url.search)throw new Error('Public manifest address must not contain credentials/query tokens');return url.href;
}
export async function remoteRelease(address:string,keys:Record<string,string>,fixtures=false,signal?:AbortSignal):Promise<Release> {
  if(!Object.keys(keys).length)throw new Error('尚未配置可信发布公钥');
  const response=await checkedFetch(manifestUrl(address,fixtures),{signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),
    headers:{'Cache-Control':'no-cache'}},fixtures);
  if(response.status!==200 || !response.body){await response.body?.cancel();throw new Error('发布清单读取失败，HTTP '+response.status);}
  if(Number(response.headers.get('content-length') || 0)>8*1024**2){await response.body.cancel();throw new Error('Manifest too large');}
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try {for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>8*1024**2)throw new Error('Manifest too large');chunks.push(chunk.value);}}
  finally {await reader.cancel();}
  return verifyEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')),keys,fixtures);
}
export function distributionProfile(raw:unknown) {
  const profile=object(raw);
  if(profile.schemaVersion!==1 || Object.keys(profile).some(key=>!['schemaVersion','authAddress','manifestAddress','serverAddress','serverPort','publicKeys'].includes(key))
    || typeof profile.authAddress!=='string' || typeof profile.manifestAddress!=='string' || typeof profile.serverAddress!=='string'
    || !Number.isInteger(profile.serverPort) || Number(profile.serverPort)<1 || Number(profile.serverPort)>65535
    || !Array.isArray(profile.publicKeys) || profile.publicKeys.length>8)throw new Error('Invalid public launcher profile');
  const keys:Record<string,string>={};
  for(const pem of profile.publicKeys){
    if(typeof pem!=='string' || pem.length>16384)throw new Error('Invalid public release key');
    const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw new Error('Ed25519 public release key required');
    const id=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex').slice(0,16);keys[id]=pem;
  }
  return {settings:{authAddress:profile.authAddress,manifestAddress:manifestUrl(profile.manifestAddress),
    serverAddress:profile.serverAddress,serverPort:Number(profile.serverPort),channel:'stable' as const,autoConnect:true,localFixtures:false},keys};
}
