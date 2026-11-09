import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL } from '@shared/dictation';
import { renameWithRetry } from '../../daemon/fsutil';

// Dictation model in ATELIER_HOME/models (0700): downloaded only from the pinned URL, resuming from a partial
// file, and accepted only if the sha256 is the pinned one. The ".ok" mark remembers the verification (no hashing at every start).

export interface ModelSpec { file: string; url: string; size: number; sha256: string }

export class ModelStore {
  private readonly dir: string;
  private readonly spec: ModelSpec;
  private readonly fetchImpl: typeof fetch;

  constructor(o: { dir: string; spec?: ModelSpec; fetchImpl?: typeof fetch }) {
    this.dir = o.dir;
    this.spec = o.spec ?? MODEL;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  path(): string { return join(this.dir, this.spec.file); }
  get size(): number { return this.spec.size; }
  private get part(): string { return this.path() + '.part'; }
  private get ok(): string { return this.path() + '.ok'; }

  state(): 'missing' | 'ready' | 'corrupted' {
    if (!existsSync(this.path())) return 'missing';
    try {
      if (statSync(this.path()).size === this.spec.size && readFileSync(this.ok, 'utf8').trim() === this.spec.sha256) return 'ready';
    } catch { /* verification mark absent */ }
    return 'corrupted';
  }

  /** Downloads (resuming a partial), verifies and makes the model ready. */
  async download(onProgress: (received: number, total: number) => void, signal?: AbortSignal): Promise<'ready' | 'corrupted' | 'cancelled'> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let offset = existsSync(this.part) ? statSync(this.part).size : 0;
    // A complete partial (its rename failed last time, a file held on Windows): verified, never downloaded again.
    if (offset === this.spec.size) {
      if (await this.hashOf(this.part) === this.spec.sha256) { onProgress(offset, this.spec.size); return this.accept(); }
    }
    if (offset >= this.spec.size) { rmSync(this.part, { force: true }); offset = 0; }
    try {
      const res = await this.fetchImpl(this.spec.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // The server ignored the Range: start over from zero.
      if (offset && res.status !== 206) offset = 0;
      const fh = await open(this.part, offset ? 'a' : 'w', 0o600);
      let received = offset;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          await fh.write(chunk);
          received += chunk.length;
          onProgress(received, this.spec.size);
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError') return 'cancelled';
      throw err;
    }
    if (await this.hashOf(this.part) !== this.spec.sha256) { rmSync(this.part, { force: true }); return 'corrupted'; }
    return this.accept();
  }

  private hashOf(file: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  /** The verified partial becomes the model (a file held for a moment on Windows is waited out). */
  private accept(): 'ready' {
    renameWithRetry(this.part, this.path());
    writeFileSync(this.ok, this.spec.sha256 + '\n', { mode: 0o600 });
    return 'ready';
  }

  remove(): void {
    for (const p of [this.path(), this.part, this.ok]) rmSync(p, { force: true });
  }
}
