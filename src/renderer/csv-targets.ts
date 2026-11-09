// CSV viewer: the palette's CSV commands act on the CSV tab in front.
import { useApp } from './store';
import type { TabKey } from './tabs-model';

export interface CsvTarget {
  goToRow(): void;
  parseOptions(): void;
}

const targets = new Map<string, CsvTarget>();

export function registerCsvTarget(key: TabKey, target: CsvTarget): () => void {
  targets.set(key, target);
  return () => { if (targets.get(key) === target) targets.delete(key); };
}

/** The CSV tab in front's actions, or null. */
export function activeCsvTarget(): CsvTarget | null {
  const key = useApp.getState().activeKey();
  return (key && targets.get(key)) || null;
}
