import type { CSSProperties } from 'react';
import { accountTag, tildeDir, useAccounts } from '../accounts';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * The Claude account a session runs (or ran) as, only when it isn't the default one, like
 * the shell profile's chip: most rows stay clean. An unknown config dir shows its folder name, without a color.
 */
export function AccountChip({ configDir }: { configDir: string | undefined }) {
  const accounts = useAccounts();
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const home = useApp((s) => s.home);
  const tag = accountTag(configDir, accounts, defaultDir);
  if (!tag || tag.isDefault) return null;
  const style = tag.color ? ({ '--acct': `var(--person-${tag.color})` } as CSSProperties) : undefined;
  // A crowded row shows a person glyph alone, in the account's color.
  return <span className={`account-chip mono${tag.color ? '' : ' is-unknown'}`} style={style} data-tip={t.accounts.chipTip(tag.name, tildeDir(configDir ?? '', home))}><span className="chip-glyph"><Icon name="person" size={10} stroke={1.9} /></span><span className="chip-text">{tag.name}</span></span>;
}
