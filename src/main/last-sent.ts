/**
 * What was last sent under each key: a value equal to the last one is not a change. Keys are per
 * window ("terminals:<webContents id>") or global ("badge", "usage"); a window that registers again is forgotten.
 */
export class LastSent {
  private last = new Map<string, string>();

  changed(key: string, value: unknown): boolean {
    const json = JSON.stringify(value) ?? 'undefined';
    if (this.last.get(key) === json) return false;
    this.last.set(key, json);
    return true;
  }

  forget(prefix: string): void {
    for (const k of [...this.last.keys()]) if (k === prefix || k.startsWith(prefix + ':')) this.last.delete(k);
  }
}
