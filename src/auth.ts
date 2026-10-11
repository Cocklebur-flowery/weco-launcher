import { randomUUID } from 'node:crypto';
import { type Account, AuthApi, account, authUrl, object, text, uuid } from './auth-api.ts';
import { Vault } from './vault.ts';

type Stored = { api: string; account: Account; platformToken: string; clientToken: string; refreshToken?: string };
export type AuthView = { account: Account | null; binding: { command: string; expiresAt: number; awaitingConfirmation: boolean } | null;
  device: { userCode: string; verificationUri: string; expiresAt: number; nextPollAt: number } | null };
export type GameLogin = { kind: 'offline' | 'premium'; profile: {id:string;name:string}; accessToken:string; xuid:string; clientId:string };

function secret(value: unknown): string { return text(value,/^[a-f0-9]{64}$/i); }
function opaque(value: unknown): string { return text(value,/^[\x21-\x7e]{1,16384}$/); }
function seconds(value:unknown, maximum:number):number {
  if (!Number.isInteger(value) || Number(value)<1 || Number(value)>maximum) throw new Error('无效的认证有效期');
  return Number(value);
}

export class Auth {
  private session: Stored | null = null;
  private deviceChallenge = '';
  private view: AuthView = {account:null,binding:null,device:null};
  private secrets = new Set<string>();
  private vault:Vault;
  private settings:()=>{authAddress:string;localFixtures:boolean};
  constructor(vault:Vault, settings:()=>{authAddress:string;localFixtures:boolean}) {this.vault=vault;this.settings=settings;}
  snapshot():AuthView { return structuredClone(this.view); }
  private protect(value:string) { this.secrets.add(value);if(this.secrets.size>32)this.secrets.delete(this.secrets.values().next().value!); }
  redact(value:string):string {for(const secret of this.secrets)value=value.replaceAll(secret,'[redacted]');return value;}
  private api():AuthApi {
    const settings = this.settings(); const api = new AuthApi(settings.authAddress,settings.localFixtures);
    if (this.session && this.session.api !== api.base) throw new Error('认证地址已变化，请先退出原账号');
    return api;
  }
  private current():Stored { if (!this.session) throw new Error('请先登录账号'); return this.session; }
  private async remember(session:Stored) {
    this.protect(session.platformToken);if(session.refreshToken)this.protect(session.refreshToken);
    await this.vault.save(session);
    this.session=session;this.view.account=session.account;
  }
  async initialize() {
    const saved = await this.vault.load(); if (!saved) return;
    const data = object(saved); const settings=this.settings();
    if (data.api !== authUrl(settings.authAddress,settings.localFixtures)) throw new Error('已有账户属于另一个认证地址，请先退出账号');
    const restored:Stored={api:String(data.api),account:account(data.account),platformToken:secret(data.platformToken),clientToken:uuid(data.clientToken)};
    if (restored.account.kind==='premium') restored.refreshToken=opaque(data.refreshToken);
    this.protect(restored.platformToken);if(restored.refreshToken)this.protect(restored.refreshToken);
    this.session=restored;this.view.account=restored.account;
  }
  async offline(name: string, password: string, register: boolean) {
    if (this.session) throw new Error('请先退出当前账号');
    text(name,/^[A-Za-z0-9_]{3,16}$/);
    if (typeof password!=='string' || Buffer.byteLength(password)<12 || Buffer.byteLength(password)>128) throw new Error('密码须为 12–128 字节');
    const api=this.api(); const data=await api.request(register?'/api/v1/register':'/api/v1/login',{name,password});
    const verified=account(data.account);
    if (verified.kind!=='offline' || verified.status==='suspended') throw new Error('账号类型不匹配');
    await this.remember({api:api.base,account:verified,platformToken:secret(data.account_token),clientToken:randomUUID()});
    if (verified.status==='active') await this.renew();
    else if (register) this.setBinding(data.challenge,data.expires_in);
  }
  private setBinding(challenge:unknown, expires:unknown) {
    this.view.binding={command:'/绑定 '+secret(challenge),expiresAt:Date.now()+seconds(expires,600)*1000,awaitingConfirmation:false};
  }
  async challenge() {
    const session=this.current();if (session.account.kind!=='offline' || session.account.status!=='pending') throw new Error('账号无需 QQ 激活');
    const data=await this.api().request('/api/v1/qq/challenge',{},session.platformToken);
    this.setBinding(data.challenge,data.expires_in);
  }
  async bindingStatus() {
    const session=this.current(); const data=await this.api().request('/api/v1/qq/status',undefined,session.platformToken);
    // Do not expose or auto-confirm the candidate's code; users enter their own Bot reply.
    if (this.view.binding) this.view.binding.awaitingConfirmation=typeof data.confirmation_code==='string';
  }
  async confirm(code:string) {
    text(code,/^[a-f0-9]{8}$/i); const session=this.current();
    const data=await this.api().request('/api/v1/qq/confirm',{confirmation_code:code},session.platformToken);
    const verified=account(data.account);
    if (verified.id!==session.account.id || verified.profileId!==session.account.profileId || verified.kind!=='offline' || verified.status!=='active') throw new Error('激活身份不匹配');
    await this.remember({...session,account:verified}); await this.renew(); this.view.binding=null;
  }
  async renew() {
    const session=this.current();const data=await this.api().request('/api/v1/session/refresh',{},session.platformToken);
    const verified=account(data.account);
    if (verified.id!==session.account.id || verified.profileId!==session.account.profileId || verified.kind!==session.account.kind || verified.status!=='active') throw new Error('续期身份不匹配');
    await this.remember({...session,account:verified,platformToken:secret(data.account_token)});
  }
  async beginPremium() {
    if (this.session) throw new Error('请先退出当前账号');
    const data=await this.api().request('/api/v1/premium/device',{});
    const uri=new URL(text(data.verification_uri,/^https:\/\//));
    if (!['microsoft.com','www.microsoft.com'].includes(uri.hostname) || !['/devicelogin','/link'].includes(uri.pathname)
      || uri.username || uri.password || uri.hash || uri.search || (uri.port && uri.port!=='443')) throw new Error('不可信的微软登录地址');
    this.deviceChallenge=secret(data.challenge);
    this.view.device={userCode:text(data.user_code,/^[A-Za-z0-9-]{4,32}$/),verificationUri:uri.href,
      expiresAt:Date.now()+seconds(data.expires_in,1800)*1000,nextPollAt:Date.now()+seconds(data.interval,300)*1000};
  }
  private async premium(data:Record<string,unknown>, api:string):Promise<GameLogin> {
    const verified=account(data.account);const mc=object(data.minecraft);const profile=object(mc.profile);
    if (verified.kind!=='premium' || verified.status!=='active' || uuid(profile.id)!==verified.profileId || profile.name!==verified.name) throw new Error('正版身份不匹配');
    if (this.session && (verified.profileId!==this.session.account.profileId || verified.id!==this.session.account.id)) throw new Error('正版续期不能替换账号');
    seconds(mc.expires_in,86400);
    const game:GameLogin={kind:'premium',profile:{id:verified.profileId,name:verified.name},accessToken:opaque(mc.access_token),
      xuid:typeof mc.xuid==='string' && mc.xuid.length ? text(mc.xuid,/^[0-9]{1,32}$/):'0',clientId:uuid(mc.client_id)};
    this.protect(game.accessToken);
    await this.remember({api,account:verified,platformToken:secret(data.account_token),clientToken:this.session?.clientToken || randomUUID(),refreshToken:opaque(data.refresh_token)});
    return game;
  }
  async pollPremium() {
    if (!this.view.device || !this.deviceChallenge || Date.now()>this.view.device.expiresAt) {this.cancelPremium();throw new Error('微软授权已过期，请重新发起');}
    if (Date.now()<this.view.device.nextPollAt) return;
    const api=this.api(); const data=await api.request('/api/v1/premium/poll',{challenge:this.deviceChallenge});
    if (data.status==='pending') {this.view.device.nextPollAt=Date.now()+seconds(data.interval,300)*1000;return;}
    if (data.status!=='complete') throw new Error('无效的微软授权状态');
    await this.premium(data,api.base);this.cancelPremium();this.view.binding=null;
  }
  cancelPremium() {this.deviceChallenge='';this.view.device=null;}
  async game():Promise<GameLogin> {
    const session=this.current();if (session.account.status!=='active') throw new Error('请先完成 QQ 验证激活账号');
    const api=this.api();
    if (session.account.kind==='premium') return this.premium(await api.request('/api/v1/premium/refresh',{
      refresh_token:session.refreshToken,profile_id:session.account.profileId}),api.base);
    await this.renew();
    const data=await api.request('/api/v1/game/session',{clientToken:this.current().clientToken},this.current().platformToken);
    const profile=object(data.selectedProfile);
    if (uuid(profile.id)!==session.account.profileId || profile.name!==this.current().account.name) throw new Error('游戏会话身份不匹配');
    const accessToken=secret(data.accessToken);this.protect(accessToken);
    return {kind:'offline',profile:{id:uuid(profile.id),name:this.current().account.name},accessToken,xuid:'0',clientId:'00000000000000000000000000000000'};
  }
  async metadata():Promise<string> {
    const data=await this.api().request('/yggdrasil/');const meta=object(data.meta);
    if (typeof data.signaturePublickey!=='string' || !data.signaturePublickey.startsWith('-----BEGIN PUBLIC KEY-----') || meta['feature.non_email_login']!==true) throw new Error('无效的认证服务器配置');
    return Buffer.from(JSON.stringify(data),'utf8').toString('base64');
  }
  async logout() {
    this.cancelPremium();this.view.binding=null;
    const session=this.session;
    try {if (session) await this.api().request('/api/v1/logout',{},session.platformToken);}
    finally {await this.vault.clear();this.session=null;this.view.account=null;}
  }
}
