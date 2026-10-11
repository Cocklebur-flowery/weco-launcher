import { safeUrl } from './release.ts';

export type Account = { id: string; profileId: string; name: string; kind: 'offline' | 'premium'; status: 'pending' | 'active' | 'suspended' };
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(({ 400: '请求无效，请检查账号和验证码', 403: '认证已失效或无权访问，请重新登录',
      409: '名称或 QQ 离线账号名额已被使用', 429: '操作过于频繁，请稍后重试', 503: '认证服务或官方服务暂时不可用' } as Record<number,string>)[status] || '认证请求失败');
    this.status=status;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('认证服务返回了无效数据');
  return value as Record<string,unknown>;
}
export function text(value: unknown, pattern: RegExp, maximum = 16384): string {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) throw new Error('认证服务返回了无效数据');
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value,/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i).replaceAll('-','').toLowerCase();
  if (/^0+$/.test(id)) throw new Error('认证服务返回了无效 UUID');
  return id;
}
export function account(value: unknown): Account {
  const a = object(value);
  if (!['offline','premium'].includes(String(a.kind)) || !['pending','active','suspended'].includes(String(a.status))) throw new Error('认证服务返回了无效账户');
  return { id: uuid(a.id), profileId: uuid(a.profile_id ?? a.profileId), name: text(a.name,/^[A-Za-z0-9_]{3,16}$/),
    kind: a.kind as Account['kind'], status: a.status as Account['status'] };
}
export function authUrl(value: string, fixtures: boolean): string {
  if (!value || value.length > 1024 || /\s/.test(value)) throw new Error('请先配置认证服务 HTTPS 地址');
  const url = new URL(safeUrl(value,fixtures));
  if (url.search) throw new Error('认证地址不允许查询参数');
  return url.href.replace(/\/$/,'');
}

export class AuthApi {
  readonly base: string;
  constructor(base: string, fixtures: boolean) { this.base = authUrl(base,fixtures); }
  async request(route: string, input?: unknown, bearer?: string): Promise<Record<string,unknown>> {
    if (!/^\/(?:api\/v1\/[a-z/]+|yggdrasil\/)$/i.test(route)) throw new Error('Invalid auth route');
    const response = await fetch(this.base + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : {'Content-Type':'application/json'}), ...(bearer ? {Authorization:'Bearer '+bearer} : {}) },
      ...(input === undefined ? {} : {body:JSON.stringify(input)}), redirect:'manual', signal:AbortSignal.timeout(35000) });
    if (![200,202,204].includes(response.status)) { await response.body?.cancel(); throw new AuthError(response.status); }
    if (response.status === 204) return {};
    if (!response.body || Number(response.headers.get('content-length') || 0) > 128*1024) throw new Error('认证响应过大');
    const reader = response.body.getReader(); const chunks:Uint8Array[]=[]; let bytes=0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length; if (bytes > 128*1024) throw new Error('认证响应过大');
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new Error('认证服务返回了无效数据'); }
  }
}
