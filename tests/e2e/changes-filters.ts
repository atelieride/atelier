import { expect, type Locator } from '@playwright/test';

/**
 * Changes' Filters: group by repository or session, this workspace or all, folders —
 * behind the funnel in the panel's head. Opens the popover, picks, closes it (Esc).
 */
export async function setChangesFilter(panel: Locator, group: 'Group by' | 'Show', name: string): Promise<void> {
  await panel.getByRole('button', { name: /^Filters/ }).click();
  const pop = panel.getByRole('dialog', { name: 'Filters' });
  await expect(pop).toBeVisible();
  await pop.getByRole('radiogroup', { name: group }).getByRole('radio', { name }).click();
  await pop.press('Escape');
  await expect(pop).toHaveCount(0);
}

/** Show folders on or off (the rows' second line), from the Filters' switch. */
export async function setChangesFolders(panel: Locator, on: boolean): Promise<void> {
  await panel.getByRole('button', { name: /^Filters/ }).click();
  const pop = panel.getByRole('dialog', { name: 'Filters' });
  const sw = pop.getByRole('switch', { name: 'Show folders' });
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', String(on));
  await pop.press('Escape');
  await expect(pop).toHaveCount(0);
}

/** Group the changes by repository or by session. */
export const groupChanges = (panel: Locator, by: 'repo' | 'session') => setChangesFilter(panel, 'Group by', by === 'repo' ? 'Repository' : 'Session');
