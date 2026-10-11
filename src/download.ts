import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { safeUrl, type ReleaseFile } from './release.ts';
import { digest, exists } from './workspace.ts';

export type TransferProgress = { phase: string; path: string; bytes: number; total: number; reused?: boolean };
export async function checkedFetch(input: string, options: RequestInit, allowLoopback = false): Promise<Response> {
  let url = safeUrl(input, allowLoopback);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(url, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Missing redirect location');
    url = safeUrl(new URL(location, url).href, allowLoopback);
  }
  throw new Error('Too many redirects');
}
export async function download(file: ReleaseFile, directory: string, options: {
  signal?: AbortSignal; allowLoopback?: boolean; progress?: (value: TransferProgress) => void;
} = {}): Promise<string> {
  const target = path.join(directory, file.sha256);
  const partial = target + '.part';
  for (const p of [target, partial]) {
    if (await exists(p)) { const s = await fs.lstat(p); if (!s.isFile() || s.isSymbolicLink()) throw new Error('Invalid cache entry'); }
  }
  if (await exists(target)) {
    if ((await fs.stat(target)).size === file.size && await digest(target) === file.sha256) {
      options.progress?.({ phase: 'cached', path: file.path, bytes: file.size, total: file.size, reused: true }); return target;
    }
    await fs.unlink(target);
  }
  let last: unknown = new Error('No source');
  for (const url of file.urls) {
    options.signal?.throwIfAborted();
    try {
      let offset = await exists(partial) ? (await fs.stat(partial)).size : 0;
      if (offset > file.size) { await fs.unlink(partial); offset = 0; }
      if (offset === file.size && await exists(partial)) {
        if (await digest(partial) === file.sha256) { await fs.rename(partial, target); return target; }
        await fs.unlink(partial); offset = 0;
      }
      const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(options.signal ? [options.signal] : [])]);
      const response = await checkedFetch(url, { signal, headers: {
        'Accept-Encoding': 'identity', ...(offset ? { Range: 'bytes=' + offset + '-' } : {})
      } }, options.allowLoopback);
      if (![200, 206].includes(response.status) || !response.body) throw new Error('Download HTTP ' + response.status);
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (!match || Number(match[1]) !== offset || Number(match[3]) !== file.size || Number(match[2]) !== file.size - 1) throw new Error('Invalid range response');
      } else offset = 0;
      let bytes = offset;
      const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > file.size) { callback(new Error('Download exceeds declared size')); return; }
        options.progress?.({ phase: 'downloading', path: file.path, bytes, total: file.size });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as never), count,
        createWriteStream(partial, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal });
      if (bytes !== file.size || await digest(partial) !== file.sha256) {
        await fs.rm(partial, { force: true }); throw new Error('File size or checksum mismatch');
      }
      await fs.rename(partial, target);
      return target;
    } catch (error) {
      options.signal?.throwIfAborted(); last = error;
    }
  }
  throw last;
}
