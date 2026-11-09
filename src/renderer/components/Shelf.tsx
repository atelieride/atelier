import { useEffect, useRef, useState } from 'react';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { shelfHeadMenu, shelfRowMenu } from '../menus';
import { isOutside, missingIn, shelfDirs, shelfIndexAt, shelvable, type ShelfItem } from '../shelf';
import { TREE_PATH_TYPE, endTreeDrag, startTreeDrag } from '../terminal/drop';

/** A shelf row dragged with the system drag (reorder; on a terminal it types its path, as a row of the tree). */
const ROW_TYPE = 'text/x-atelier-shelf';
let rowDrag: ShelfItem | null = null;

const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/**
 * The files of the shelf gone from disk: each row's folder listed, again when the shelf
 * changes, the window gets the focus, a repository's HEAD or branch moves (another branch checked out), or main's
 * watcher reports a change under a shelved file (deleted from a terminal while Atelier keeps the focus).
 */
function useMissing(items: ShelfItem[]): Set<string> {
  const realRoot = useApp((s) => s.project?.realRoot ?? null);
  // An outside file is never listed (its folder is not the project's): missing when main did not grant it again.
  const ungranted = useApp((s) => s.shelfUngranted);
  const heads = useApp((s) => s.repos.map((r) => `${r.root}\u0000${r.branch ?? ''}\u0000${r.oid ?? ''}`).join('\n'));
  const nonce = useApp((s) => s.shelfNonce);
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const key = items.map((x) => x.path).join('\n');
  useEffect(() => {
    let live = true;
    const check = () => {
      const api = window.atelier?.files;
      if (!api || !items.length) { setMissing((m) => (m.size ? new Set() : m)); return; }
      void Promise.all(shelfDirs(items, realRoot).map((d) => api.list(d, true).then((es) => [d, es.map((e) => e.name)] as const, () => [d, null] as const)))
        .then((pairs) => {
          if (!live) return;
          const next = missingIn(items, new Map(pairs));
          setMissing((m) => (m.size === next.size && [...next].every((p) => m.has(p)) ? m : next));
        });
    };
    check();
    window.addEventListener('focus', check);
    return () => { live = false; window.removeEventListener('focus', check); };
    // `key` stands for the items (their paths).
  }, [key, heads, nonce, realRoot]);
  return ungranted.length ? new Set([...missing, ...ungranted.filter((p) => items.some((x) => x.path === p))]) : missing;
}

/** Where a shelf drag or drop lands now: before a row's path, or last (null). */
type Landing = { before: string | null } | null;

function Row({ item, caret, fresh, missing }: { item: ShelfItem; caret: boolean; fresh: boolean; missing: boolean }) {
  const front = useApp((s) => s.activeKey() === `f:${item.path}`);
  const open = useApp((s) => s.openFiles.some((f) => f.path === item.path));
  const dirty = useApp((s) => !!s.dirty[item.path]);
  const name = nameOf(item.rel);
  // Outside the project: a chip. Its folder only in the tooltip, as for every row
  // (2026-11-02: the name alone, the path on hover).
  const outside = useApp((s) => isOutside(item.path, s.project?.realRoot ?? null));
  const st = useApp.getState;
  const openIt = (preview: boolean) => st().openFile(item.path, item.rel, null, undefined, { preview });
  return (
    <div role="listitem" data-path={item.path} draggable
      className={`shelf-row ${front ? 'is-selected' : ''} ${open ? 'is-open' : ''} ${missing ? 'is-missing' : ''} ${caret ? 'is-caret' : ''} ${fresh ? 'is-new' : ''}`}
      onDragStart={(e) => {
        rowDrag = item;
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(ROW_TYPE, item.path);
        e.dataTransfer.setData(TREE_PATH_TYPE, '1');
        startTreeDrag(item.path);
      }}
      onDragEnd={() => { rowDrag = null; endTreeDrag(); }}
      onContextMenu={(e) => st().openMenu(e, shelfRowMenu(item, () => openIt(false)))}>
      <button type="button" className="row-main" data-tip={outside ? t.openAny.tabTip(item.rel) : item.rel}
        onClick={(e) => (e.altKey ? st().openFileToSide(item.path, item.rel) : openIt(true))}
        onDoubleClick={() => openIt(false)}>
        <span className="shelf-icon"><FileIcon name={name} /></span>
        <span className="shelf-name">{name}</span>
        {dirty && <span className="tab-dirty" aria-label={t.modified} />}
        {outside && <span className="shelf-outside" data-tip={t.openAny.outsideTip}>{t.shelf.outside}</span>}
        {missing && <span className="shelf-missing" data-tip={t.shelf.missingTip}>{t.shelf.missing}</span>}
      </button>
      <button type="button" className="row-close" aria-label={t.shelf.remove(name)} data-tip={t.shelf.removeTip}
        onClick={(e) => { e.stopPropagation(); st().removeFromShelf(item.path); }}><Icon name="x" size={13} stroke={1.8} /></button>
    </div>
  );
}

/**
 * The Shelf: project files kept at hand under Terminals. Shown while it holds files, and while a
 * file tab that can land on it is dragged (tab-drag.ts, dock-target.ts read `.shelf` and its `.shelf-row`s).
 */
export function Shelf() {
  const items = useApp((s) => s.shelf);
  const collapsed = useApp((s) => s.shelfCollapsed);
  // A file tab being dragged that the shelf takes, and whether the pointer is over the shelf (the store's target).
  const dragged = useApp((s) => (s.tabDrag?.startsWith('f:') && shelvable(s.tabDrag.slice(2), s.project?.realRoot ?? null) ? s.tabDrag.slice(2) : null));
  const tabLanding = useApp((s) => (s.tabDragTarget?.kind === 'shelf' ? s.tabDragTarget.before : undefined));
  const [rowLanding, setRowLanding] = useState<Landing>(null);
  const missing = useMissing(items);
  const box = useRef<HTMLElement>(null);

  // Rows that just arrived (a drop, a menu): a short flash, once.
  const known = useRef<Set<string> | null>(null);
  const fresh = known.current ? new Set(items.filter((x) => !known.current!.has(x.path)).map((x) => x.path)) : new Set<string>();
  useEffect(() => { known.current = new Set(items.map((x) => x.path)); }, [items]);

  // The keyboard stays in the sidebar when the row it was on goes (its X, its menu, Clear Shelf): the next row, the
  // previous one, the head, or — the shelf gone — the sidebar's last row. Only when the focus was really lost.
  const focused = useRef<string | null>(null);
  const shown = useRef(items);
  useEffect(() => {
    const was = shown.current;
    shown.current = items;
    const gone = focused.current;
    if (!gone || items.some((x) => x.path === gone)) return;
    focused.current = null;
    const i = was.findIndex((x) => x.path === gone);
    // After the menu gave the focus back (or could not: its row is gone).
    const id = setTimeout(() => {
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      const rows = [...(box.current?.querySelectorAll<HTMLElement>('.shelf-row .row-main') ?? [])];
      const sidebar = document.querySelector('.sidebar');
      const next = rows[Math.min(i, rows.length - 1)] ?? box.current?.querySelector<HTMLElement>('.shelf-toggle')
        ?? [...(sidebar?.querySelectorAll<HTMLElement>('.row-main') ?? [])].at(-1) ?? sidebar?.querySelector<HTMLElement>('.group-toggle');
      next?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [items]);

  const accepting = !!dragged;
  if (!items.length && !accepting) return null;

  // Where the dragged file (a tab, or a row) would land; no caret where it would stay put.
  const moving = dragged ?? (rowLanding ? rowDrag?.path ?? null : null);
  const landing = tabLanding !== undefined ? { before: tabLanding } : rowLanding;
  const at = moving ? items.findIndex((x) => x.path === moving) : -1;
  const stays = !!landing && at >= 0 && (landing.before === moving || landing.before === (items[at + 1]?.path ?? null));
  const caretBefore = landing && !stays && !collapsed ? landing.before : undefined;
  const over = !!landing;
  const pill = at >= 0 ? (stays ? t.shelf.already : t.shelf.move) : t.shelf.add;

  const rowsLanding = (y: number): Landing => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('.shelf-row[data-path]') ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { path: el.dataset.path!, top: r.top, height: r.height };
    });
    return { before: collapsed ? null : shelfIndexAt(rows, y) };
  };

  return (
    <section ref={box} className={`shelf ${accepting ? 'is-accepting' : ''} ${over ? 'is-over' : ''} ${collapsed ? 'is-collapsed' : ''} ${!items.length ? 'is-empty' : ''}`}
      aria-label={t.shelf.title}
      onFocus={(e) => { focused.current = (e.target as HTMLElement).closest<HTMLElement>('.shelf-row')?.dataset.path ?? null; }}
      onBlur={(e) => {
        // Into its own menu (Shift+F10) the row stays the one to come back to; anywhere else, none.
        const to = e.relatedTarget as HTMLElement | null;
        if (to && !e.currentTarget.contains(to) && !to.closest('.ctx-menu')) focused.current = null;
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ROW_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const next = rowsLanding(e.clientY);
        setRowLanding((cur) => (cur?.before === next?.before ? cur : next));
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRowLanding(null); }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(ROW_TYPE) || !rowDrag) return;
        e.preventDefault();
        const where = rowsLanding(e.clientY);
        if (where) useApp.getState().addToShelf(rowDrag.path, rowDrag.rel, where.before);
        setRowLanding(null);
      }}>
      <div className="sidebar-head shelf-head" onContextMenu={(e) => useApp.getState().openMenu(e, shelfHeadMenu())}>
        <button type="button" className="shelf-toggle" aria-expanded={!collapsed} data-tip={collapsed ? t.shelf.expand : t.shelf.collapse}
          onClick={() => useApp.getState().toggleShelfCollapsed()}>
          <span className="shelf-chevron"><Icon name="chevronDown" size={12} stroke={2} /></span>
          <span className="section-label">{t.shelf.title}</span>
          {items.length > 0 && <span className="count mono">{items.length}</span>}
        </button>
        <span className="grow" />
        {over && <span className="shelf-pill"><Icon name="shelf" size={12} stroke={1.8} />{pill}</span>}
      </div>
      {!items.length && <div className="shelf-slot">{t.shelf.dropEmpty}</div>}
      {items.length > 0 && !collapsed && (
        <div className={`list shelf-list ${caretBefore === null ? 'is-caret-end' : ''}`} role="list" aria-label={t.shelf.title}>
          {items.map((x) => <Row key={x.path} item={x} caret={caretBefore === x.path} fresh={fresh.has(x.path)} missing={missing.has(x.path)} />)}
        </div>
      )}
    </section>
  );
}
