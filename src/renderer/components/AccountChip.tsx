import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { accountKey, accountTag, tildeDir, useAccounts, type SharedAccount } from '../accounts';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * The Claude account a session runs (or ran) as, only when it isn't the default one, like
 * the shell profile's chip: most rows stay clean. An unknown config dir shows its folder name, without a color.
 * `except`: the account its group's head already names for every session there (accountKey), not repeated here.
 */
export function AccountChip({ configDir, except }: { configDir: string | undefined; except?: string }) {
  const accounts = useAccounts();
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const home = useApp((s) => s.home);
  const tag = accountTag(configDir, accounts, defaultDir);
  if (!tag || tag.isDefault) return null;
  if (except && accountKey(configDir, accounts, defaultDir) === except) return null;
  const style = tag.color ? ({ '--acct': `var(--person-${tag.color})` } as CSSProperties) : undefined;
  // A crowded row shows a person glyph alone, in the account's color; a session row's details line, glyph and name.
  return <span className={`account-chip mono${tag.color ? '' : ' is-unknown'}`} style={style} data-tip={t.accounts.chipTip(tag.name, tildeDir(configDir ?? '', home))}><span className="chip-glyph"><Icon name="person" size={10} stroke={1.9} /></span><span className="chip-text">{tag.name}</span></span>;
}

/**
 * The account every session of a group runs as, once on the group's head (a workspace, an activity, Sessions) instead
 * of on each row: the person glyph and the name, in the account's color.
 */
export function GroupAccount({ shared }: { shared: SharedAccount | null | undefined }) {
  const home = useApp((s) => s.home);
  const el = useRef<HTMLSpanElement>(null);
  // It gives way before the group's name; a name it would cut to a stub ("C…") goes, the glyph stays (data-short).
  const check = useRef(() => {});
  check.current = () => {
    const box = el.current;
    const text = box?.querySelector<HTMLElement>('.chip-text');
    if (!box || !text) return;
    box.removeAttribute('data-short');
    if (text.scrollWidth > text.clientWidth + 0.5 && text.clientWidth < 36) box.setAttribute('data-short', '');
  };
  useLayoutEffect(() => check.current());
  useEffect(() => {
    const head = el.current?.parentElement;
    if (!head) return;
    const ro = new ResizeObserver(() => check.current());
    ro.observe(head);
    return () => ro.disconnect();
  }, [!!shared]);
  if (!shared) return null;
  const { tag, dir } = shared;
  const style = tag.color ? ({ '--acct': `var(--person-${tag.color})` } as CSSProperties) : undefined;
  return (
    <span ref={el} className={`group-account mono${tag.color ? '' : ' is-unknown'}`} style={style} data-tip={t.accounts.groupTip(tag.name, tildeDir(dir, home))}>
      <Icon name="person" size={10} stroke={1.9} /><span className="chip-text">{tag.name}</span>
    </span>
  );
}
