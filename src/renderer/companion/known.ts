import type { ClaudeAccounts } from '@shared/claude-accounts';

/** What Settings › Ask › "What I already know" keeps: CRLF as newlines, no control characters settings would refuse, capped. */
export function cleanKnown(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  // The limit counts UTF-16 units (what settings validate): never leave half of a surrogate pair at the cut.
  return clean.slice(0, max).replace(/[\ud800-\udbff]$/, clean.length > max ? '' : '$&');
}

/** The Account row's options: the session's own, then each account. Empty with one account: the row is hidden. */
export function askAccountChoices(accounts: ClaudeAccounts, sessionLabel: string): { value: string; label: string }[] {
  if (accounts.list.length < 2) return [];
  return [{ value: 'session', label: sessionLabel }, ...accounts.list.map((a) => ({ value: a.id, label: a.name }))];
}
