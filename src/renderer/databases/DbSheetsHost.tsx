// Add / Edit Connection and Remove's confirm, where each window mounts them (the project
// window and a pop-out): their chunk loads when one opens, never with the first paint.
import { lazy, Suspense } from 'react';
import { useDb } from './store';

const DbSheets = lazy(() => import('./ConnectionSheet').then((m) => ({ default: m.DbSheets })));

export function DbSheetsHost() {
  const open = useDb((s) => s.sheet !== null);
  return open ? <Suspense fallback={null}><DbSheets /></Suspense> : null;
}
