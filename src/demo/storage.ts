// The demo's storage: served from the site's origin, the app's localStorage keys (panels,
// comments, inbox, task links, change prefs) would mix with the site's and persist across visits. An in-memory Storage
// replaces both localStorage and sessionStorage before the renderer runs: every demo starts fresh and nothing is
// written to the visitor's browser.

export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number { return this.items.size; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.items.get(String(key)) ?? null; }
  setItem(key: string, value: string): void { this.items.set(String(key), String(value)); }
  removeItem(key: string): void { this.items.delete(String(key)); }
  clear(): void { this.items.clear(); }
  [name: string]: unknown;
}

export function installStorageShim(win: Window = window): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(win, name, { value: new MemoryStorage(), configurable: true, enumerable: true, writable: false });
  }
}
