// The editor's value chips: what a condition's field suggests, and adding or
// removing a value. Status and Tag take any text (the source may not use it yet); people only from the list, by id,
// with their names as the condition's labels. Pure.
import type { Condition, ConditionField, ConditionValues } from '@shared/automations';
import { t } from '../i18n/en';

/** The model's limit (normalizeAutomation keeps 20). */
export const MAX_VALUES = 20;
const MAX_SHOWN = 50;
/** The label a person gets when no name is known (normalizeAutomation's empty label). */
const UNKNOWN = '…';

export const isPeople = (f: ConditionField) => f === 'assignee' || f === 'createdBy';
/** The fields edited as chips. */
export const isChips = (f: ConditionField) => isPeople(f) || f === 'status' || f === 'tag';

export type Suggestion =
  | { kind: 'value'; value: string; label: string; color?: string; count?: number }
  | { kind: 'add'; value: string; label: string };

const lower = (s: string) => s.toLowerCase();

/** The value's name: Me, the label it was saved with, else the suggestions' name; null when unknown. */
export function personName(c: Condition, i: number, known: ConditionValues | null): string | null {
  const v = c.values[i];
  if (v === 'me') return 'Me';
  const saved = c.labels?.[i];
  if (saved && saved !== UNKNOWN) return saved;
  return known?.people.find((p) => p.id === v)?.name ?? null;
}

/** What the field's popover offers for this query, the chosen values left out. */
export function suggestions(c: Condition, query: string, known: ConditionValues | null): Suggestion[] {
  const q = lower(query.trim());
  if (isPeople(c.field)) {
    const people = [{ id: 'me', name: 'Me' }, ...(known?.people ?? [])];
    return people.filter((p) => !c.values.includes(p.id) && lower(p.name).includes(q)).slice(0, MAX_SHOWN)
      .map((p) => ({ kind: 'value', value: p.id, label: p.name, ...('count' in p ? { count: p.count } : {}) }));
  }
  const chosen = new Set(c.values.map(lower));
  const options = (c.field === 'tag' ? known?.tag : known?.status) ?? [];
  const out: Suggestion[] = options.filter((o) => !chosen.has(lower(o.name)) && lower(o.name).includes(q)).slice(0, MAX_SHOWN)
    .map((o) => ({ kind: 'value', value: o.name, label: o.name, ...(o.color ? { color: o.color } : {}), count: o.count }));
  const text = query.trim();
  if (text && !chosen.has(q) && !options.some((o) => lower(o.name) === q)) out.push({ kind: 'add', value: text, label: t.auto.editor.addValue(text) });
  return out;
}

/** The condition with one more value: never a duplicate (any case for names, exactly for ids), at most 20. */
export function addValue(c: Condition, value: string, known: ConditionValues | null): Condition {
  const v = value.trim();
  if (!v || c.values.length >= MAX_VALUES) return c;
  if (!isPeople(c.field)) return c.values.some((x) => lower(x) === lower(v)) ? c : { ...c, values: [...c.values, v] };
  if (c.values.includes(v)) return c;
  const next = { ...c, values: [...c.values, v] };
  return { ...next, labels: next.values.map((_, i) => personName(next, i, known) ?? UNKNOWN) };
}

export function removeValue(c: Condition, i: number): Condition {
  return {
    ...c, values: c.values.filter((_, j) => j !== i),
    ...(c.labels ? { labels: c.labels.filter((_, j) => j !== i) } : {})
  };
}

/** Saving: every people condition named from what is known, so the list's sentence can name them. */
export function withPeopleLabels(conditions: readonly Condition[], known: ConditionValues | null): Condition[] {
  return conditions.map((c) => (isPeople(c.field) ? { ...c, labels: c.values.map((_, i) => personName(c, i, known) ?? UNKNOWN) } : c));
}

/** Due within: a typed whole number of days, clamped to 0–365; anything else keeps `last`. */
export function daysValue(text: string, last: number): number {
  return /^\s*-?\d+\s*$/.test(text) ? Math.min(365, Math.max(0, Number(text.trim()))) : last;
}
