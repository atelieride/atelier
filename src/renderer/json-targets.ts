// JSON navigation: the palette's JSON commands act on the JSON tab in front.
import { useApp } from './store';
import type { TabKey } from './tabs-model';

export interface JsonTarget {
  foldAll(): void;
  unfoldAll(): void;
  foldLevel(level: number): void;
  copyPath(): void;
}

const targets = new Map<string, JsonTarget>();

export function registerJsonTarget(key: TabKey, target: JsonTarget): () => void {
  targets.set(key, target);
  return () => { if (targets.get(key) === target) targets.delete(key); };
}

/** The JSON tab in front's actions, or null. */
export function activeJsonTarget(): JsonTarget | null {
  const key = useApp.getState().activeKey();
  return (key && targets.get(key)) || null;
}
