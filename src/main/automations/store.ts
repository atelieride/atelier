// The automations on disk: ATELIER_HOME/automations/ holds automations.json (every
// project's automations and the user's instructions), <id>.runs.json (the last 50 runs: ids, one-line titles, states,
// costs, decisions) and <id>.seen.json (the seen ledger: task ids only). Every file 0600 and atomic; whatever is read
// is validated, and an automations file that can't be read is set aside rather than overwritten.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAutomation, type Automation, type Ledger } from '@shared/automations';
import { keepRuns, normalizeRun, type Run } from '@shared/automation-run';
import { writeFileAtomic } from '../../daemon/fsutil';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LEDGER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface Seen { lastPollAt: number | null; ledger: Ledger }

export class AutomationsStore {
  constructor(private readonly dir: string, private readonly log: (m: string) => void) {}

  loadAutomations(): Automation[] {
    const raw = this.read('automations.json');
    if (raw === null) return [];
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return this.setAside('automations.json'); }
    const list = (data as { automations?: unknown })?.automations;
    if (!Array.isArray(list)) return this.setAside('automations.json');
    const seen = new Set<string>();
    const out: Automation[] = [];
    for (const item of list) {
      const a = normalizeAutomation(item);
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    return out;
  }

  saveAutomations(list: readonly Automation[]): void {
    this.write('automations.json', { v: 1, automations: list });
  }

  loadRuns(id: string): Run[] {
    const raw = this.read(`${checked(id)}.runs.json`);
    if (raw === null) return [];
    try {
      const runs = (JSON.parse(raw) as { runs?: unknown })?.runs;
      return Array.isArray(runs) ? runs.map(normalizeRun).filter((r): r is Run => r !== null) : [];
    } catch {
      this.log(`automations: ${id}.runs.json unreadable, starting empty`);
      return [];
    }
  }

  saveRuns(id: string, runs: readonly Run[]): void {
    this.write(`${checked(id)}.runs.json`, { v: 1, runs: keepRuns(runs) });
  }

  loadSeen(id: string): Seen {
    const raw = this.read(`${checked(id)}.seen.json`);
    if (raw === null) return { lastPollAt: null, ledger: {} };
    try {
      const o = JSON.parse(raw) as { lastPollAt?: unknown; ledger?: unknown };
      const ledger: Ledger = {};
      if (o.ledger && typeof o.ledger === 'object' && !Array.isArray(o.ledger)) {
        for (const [k, v] of Object.entries(o.ledger as Record<string, unknown>)) {
          const e = v as { at?: unknown; matched?: unknown; done?: unknown } | null;
          if (LEDGER_ID.test(k) && e && Number.isInteger(e.at) && (e.at as number) >= 0 && typeof e.matched === 'boolean' && typeof e.done === 'boolean') ledger[k] = { at: e.at as number, matched: e.matched, done: e.done };
        }
      }
      const at = o.lastPollAt;
      return { lastPollAt: typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : null, ledger };
    } catch {
      this.log(`automations: ${id}.seen.json unreadable, starting empty`);
      return { lastPollAt: null, ledger: {} };
    }
  }

  saveSeen(id: string, seen: Seen): void {
    this.write(`${checked(id)}.seen.json`, { v: 1, ...seen });
  }

  /** An automation deleted: its runs and ledger go with it. */
  remove(id: string): void {
    for (const f of [`${checked(id)}.runs.json`, `${id}.seen.json`]) {
      try { unlinkSync(join(this.dir, f)); } catch { /* not there */ }
    }
  }

  private read(file: string): string | null {
    try { return readFileSync(join(this.dir, file), 'utf8'); } catch { return null; }
  }

  private write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    writeFileAtomic(join(this.dir, file), `${JSON.stringify(data)}\n`, 0o600);
  }

  private setAside(file: string): Automation[] {
    const aside = `${file}.bad-${Date.now()}`;
    try { renameSync(join(this.dir, file), join(this.dir, aside)); } catch { /* gone meanwhile */ }
    this.log(`automations: ${file} unreadable, set aside as ${aside}`);
    return [];
  }
}

function checked(id: string): string {
  if (!ID.test(id)) throw new Error('invalid automation id');
  return id;
}
