import { memo, type MouseEvent } from 'react';
import type { TabKey } from '../tabs-model';
import { paneMenu } from '../menus';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { keepPaneKeyboard } from '../pane-focus';
import { reviewScopeTitle } from '../review';
import { historyTabTitle, revTitle } from '../scm/titles';
import { SessionGlyph } from './SessionTile';
import { CwdChip } from './CwdChip';
import { AccountChip } from './AccountChip';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { useDocker } from '../docker/store';
import { DockerPortChips } from '../docker/DockerPorts';
import { dockerTabTitle } from '../docker/DockerView';
import { parseRedisKey, redisTabTitle } from '../redis/tabs';
import { autoTabTitle } from '../automations/tabs';
import { PortChips } from './PortChips';
import { TaskChip } from './TaskChip';
import { shownState } from '../selectors';
import { useShallow } from 'zustand/react/shallow';
import { useDb } from '../databases/store';
import { DB_TAB_ICON, dbConnsIf, dbTabLabel, dbTabTip, shownDbTabsIf } from '../databases/tabs';

/**
 * A pop-out's bar for anything but a Claude session (which has its session bar): the tab's identity
 * — terminal (folder and listening ports), file, Services, review… — and whose project it is. Split panes have no header
 * any more: their strip says what they hold.
 */
export const PaneHeader = memo(function PaneHeader({ k, popout }: { k: TabKey | null; popout?: boolean }) {
  const term = useApp((s) => (k?.startsWith('t:') ? s.terminals.find((x) => x.id === k.slice(2)) : undefined));
  const file = useApp((s) => (k?.startsWith('f:') ? s.openFiles.find((f) => f.path === k.slice(2)) : undefined));
  const dirty = useApp((s) => !!file && !!s.dirty[file.path]);
  const svcErrors = useApp((s) => (k === 'services' ? s.services.reduce((n, p) => n + p.errors, 0) : 0));
  const table = useApp((s) => (k?.startsWith('db:') ? s.dbTabs.find((r) => r.key === k) : undefined));
  // A table's tooltip as its tab has it: `<connection> · <schema>.<name>`.
  const conns = useDb(dbConnsIf(!!table));
  const tableTip = table ? dbTabTip(table, (id) => conns.find((v) => v.conn.id === id)?.conn.name ?? '') : undefined;
  const title = useTabTitle(k);
  const fileName = file ? file.rel.split('/').at(-1) ?? file.rel : '';
  const fileDir = file ? file.rel.split('/').slice(0, -1).join('/') : '';
  return (
    <div className={`pane-head ${k === null ? 'is-empty' : ''}${popout ? ' is-popout' : ''}`} role="group" aria-label={title} onMouseDown={keepPaneKeyboard}>
      {term && (term.session
        ? <SessionGlyph term={term} state={shownState(term)} size={18} />
        : <span className="ph-icon"><Icon name="terminal" size={12} stroke={1.9} /></span>)}
      {file && <FileIcon name={fileName} size={15} />}
      {k === 'services' && <span className="ph-icon"><i className={`svc-dot ${svcErrors ? 'is-err' : 'is-ok'}`} /></span>}
      {k === 'review' && <span className="ph-icon"><Icon name="review" size={13} stroke={1.8} /></span>}
      {(k === 'history' || k?.startsWith('rev:')) && <span className="ph-icon"><Icon name="git" size={13} stroke={1.8} /></span>}
      {k === 'background' && <span className="ph-icon"><Icon name="bolt" size={13} stroke={1.8} /></span>}
      {k?.startsWith('dk:') && <span className="ph-icon ph-whale"><Icon name="whale" size={14} /></span>}
      {k?.startsWith('rd:') && <span className="ph-icon"><Icon name="redis" size={13} stroke={1.8} /></span>}
      {k?.startsWith('au:') && <span className="ph-icon"><Icon name="automation" size={13} stroke={1.8} /></span>}
      {table && <span className="ph-icon"><Icon name={DB_TAB_ICON[table.kind]} size={14} stroke={1.7} /></span>}
      {k === null && <span className="ph-icon is-empty"><Icon name="split" size={13} stroke={1.7} /></span>}
      <span className="ph-title" data-tip={file?.rel ?? tableTip ?? (term ? term.session?.cwd ?? term.cwd : undefined)}>{title}</span>
      {fileDir && <span className="ph-dir mono">{fileDir}</span>}
      {dirty && <span className="tab-dirty" aria-label={t.modified} />}
      {term && <TaskChip id={term.id} />}
      {term && <CwdChip term={term} />}
      {term && <AccountChip configDir={term.configDir} />}
      {term && <PortChips id={term.id} />}
      {term && !term.session && <DockerPortChips term={term} />}
      <span className="grow" />
      {popout && <PopoutProject />}
    </div>
  );
}, (a, b) => a.k === b.k && a.popout === b.popout);

/**
 * What a tab is called where it is shown: a terminal's title, a file's name, "Services", "Review · …", a Docker or
 * Redis view, History or a revision ("Empty" for an empty pane). A pane's header and a pop-out's window title use it.
 */
export function useTabTitle(k: TabKey | null): string {
  const termTitle = useApp((s) => (k?.startsWith('t:') ? s.terminals.find((x) => x.id === k.slice(2))?.title ?? '' : ''));
  const fileRel = useApp((s) => (k?.startsWith('f:') ? s.openFiles.find((f) => f.path === k.slice(2))?.rel ?? '' : ''));
  const reviewTitle = useApp((s) => (k === 'review' && s.review ? reviewScopeTitle(s.review.scope, s.terminals, s.attributions) : ''));
  const scmTitle = useApp((s) => (k === 'history' ? historyTabTitle(s) : k?.startsWith('rev:') ? revTitle(s.revFiles.find((f) => f.key === k)) : ''));
  const bgTitle = useApp((s) => (k === 'background' ? s.terminals.find((x) => x.id === s.backgroundTab?.terminalId)?.title ?? '' : ''));
  const dockerTarget = useApp((s) => (k?.startsWith('dk:') ? s.dockerTabs.find((r) => r.key === k)?.target ?? null : null));
  const dockerTitle = useDocker((s) => (dockerTarget ? dockerTabTitle(dockerTarget, s.containers) : ''));
  const redisView = k ? parseRedisKey(k) : null;
  const autoTitle = useApp((s) => { const r = k?.startsWith('au:') ? s.autoTabs.find((x) => x.key === k) : undefined; return r ? autoTabTitle(r.id, s.automations.automations) : ''; });
  // A table tab: its label as the strip shows it; for any other tab, a fixed empty list.
  const isDb = !!k?.startsWith('db:');
  const dbTabs = useApp(useShallow(shownDbTabsIf(isDb)));
  const conns = useDb(dbConnsIf(isDb));
  const table = isDb ? dbTabs.find((r) => r.key === k) : undefined;
  if (table) return dbTabLabel(table, dbTabs, (id) => conns.find((v) => v.conn.id === id)?.conn.name ?? '');
  if (k?.startsWith('t:')) return termTitle;
  if (k?.startsWith('f:')) return fileRel.split('/').at(-1) ?? fileRel;
  if (k === 'services') return t.servicesTab;
  if (k === 'review') return t.review.tab(reviewTitle);
  if (k === 'background') return t.bg.tab(bgTitle);
  if (k?.startsWith('dk:')) return dockerTitle;
  if (redisView) return redisTabTitle(redisView);
  if (k?.startsWith('au:')) return autoTitle;
  return scmTitle || t.split.empty;
}

/**
 * In a pop-out's bar, on its right before the tools and Move Back: whose project it is, a quiet
 * label of its own so it never reads as part of the tab's title or activity.
 */
export function PopoutProject() {
  const name = useApp((s) => s.project?.name ?? '');
  return <span className="popout-project" data-tip={t.popout.project(name)}><Icon name="files" size={12} stroke={1.8} /><span>{name}</span></span>;
}

/** Right-click on a pane's header: its menu (Shift+F10 reaches it through the header's buttons). */
export const paneMenuAt = (index: number) => (e: MouseEvent) => { if (!e.defaultPrevented) useApp.getState().openMenu(e, paneMenu(index)); };
