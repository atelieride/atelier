// Screenshots for a person to look at (CLAUDE.md, Testing notes): they assert nothing, so a normal run skips them and
// the settle wait before them. ATELIER_E2E_SHOTS=1 takes them, at the path each test gives.
import type { Locator, Page } from '@playwright/test';

export const shotsOn = (): boolean => !!process.env.ATELIER_E2E_SHOTS;

type Clip = { x: number; y: number; width: number; height: number };

export async function look(target: Page | Locator, path: string, o: { settle?: number; animations?: 'disabled'; clip?: Clip } = {}): Promise<void> {
  if (!shotsOn()) return;
  if (o.settle) await ('waitForTimeout' in target ? target : target.page()).waitForTimeout(o.settle);
  const { settle: _settle, ...options } = o;
  await target.screenshot({ path, ...options });
}
