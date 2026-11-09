import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry } from '@shared/files';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { buildRows, unsureOf, type ChangeRow } from '../changes';
import { FileIcon } from './FileIcon';
import { OriginMarks } from './OriginMarks';
import { Icon } from './Icon';
import { treeMenu, treeRootMenu } from '../menus';
import type { TreeEdit } from '../store';
import { TREE_PATH_TYPE, endTreeDrag, startTreeDrag } from '../terminal/drop';
import { TREE_GIT_LETTER, treeGitMap, type TreeGit } from '../tree-git';
import { isBelow } from '@shared/paths';
import { ConfirmActions, onEscCancel, useDismiss } from '../confirms/InlineConfirm';

const expandedByProject = new Map<string, Set<string>>();
const collapseListeners = new Set<() => void>();
const revealed = new Set<number>();

/** Collapse folders (the Files header, the palette): every open folder of the project closes. */
export function collapseAllFolders(root: string): void {
  expandedByProject.get(root)?.clear();
  for (const f of collapseListeners) f();
}

/** Inline tree field: Enter confirms, Esc cancels, leaving with no name cancels. */
function TreeInput({ depth, initial, kind, onDone }: { depth: number; initial: string; kind: 'file' | 'folder' | null; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (v: string | null) => { if (done.current) return; done.current = true; onDone(v); };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // When renaming, the name without the extension is selected, as in Finder.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <div className="tree-row is-editing" style={{ paddingLeft: 6 + depth * 14 }}>
      <span className="tree-chev" />
      {kind === 'folder' ? <span className="tree-folder"><Icon name="files" size={13} /></span> : <FileIcon name={ref.current?.value || initial || 'x'} />}
      <input ref={ref} className="tree-input" defaultValue={initial} spellCheck={false} aria-label={t.fileName}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') finish(e.currentTarget.value.trim() || null); if (e.key === 'Escape') finish(null); }}
        onBlur={(e) => finish(e.currentTarget.value.trim() && e.currentTarget.value.trim() !== initial ? e.currentTarget.value.trim() : null)} />
    </div>
  );
}

async function commitEdit(edit: TreeEdit, name: string | null) {
  const st = useApp.getState();
  st.endTreeEdit();
  const root = st.project?.root;
  if (!name || !root) return;
  const rel = (p: string) => (isBelow(root, p) ? p.slice(root.length + 1) : p);
  if (edit.mode === 'rename') {
    // Unsaved changes in the files being renamed: decide what to do with them first.
    if (!(await st.confirmUnsavedUnder(edit.path, 'rename'))) return;
    const r = await window.atelier.files.rename(edit.path, name);
    if ('error' in r) { st.showToast(t.fileOpFailed(t.fileErrors[r.error] ?? r.error)); return; }
    st.renameOpenFiles(edit.path, r.path, root);
    st.bumpTree();
    return;
  }
  const kind = edit.mode === 'new-folder' ? 'folder' : 'file';
  const r = await window.atelier.files.create(edit.dir, name, kind);
  if ('error' in r) { st.showToast(t.fileOpFailed(t.fileErrors[r.error] ?? r.error)); return; }
  st.bumpTree();
  if (kind === 'file') st.openFile(r.path, rel(r.path));
}

/** The row's Move to Trash question: its name line, what goes, Move to Trash and Cancel (focused). */
function TreeTrashConfirm({ entry, depth, files }: { entry: DirEntry; depth: number; files: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = () => useApp.getState().cancelTrash();
  useDismiss(box, cancel);
  // The row goes (its folder collapsed, the file deleted, the tree closed): so does the question.
  useEffect(() => () => useApp.getState().trashRowGone(entry.path), [entry.path]);
  const title = t.confirm.trashTitle(entry.name);
  return (
    <div ref={box} className="tree-row is-confirming" role="group" aria-label={title} data-own-esc="" data-path={entry.path}
      style={{ paddingLeft: 6 + depth * 14 }} onKeyDown={onEscCancel(cancel)}>
      <div className="tree-confirm-head">
        <span className="tree-chev" aria-hidden="true" />
        {entry.dir ? <span className="tree-folder"><Icon name="files" size={13} /></span> : <FileIcon name={entry.name} />}
        <span className="tree-name">{entry.name}</span>
      </div>
      <div className="tree-confirm-body">
        <span className="tree-confirm-text"><b>{title}</b> {entry.dir ? t.confirm.trashFolder(files) : t.confirm.trashFile}</span>
        <ConfirmActions confirm={t.confirm.moveToTrash} onConfirm={() => void useApp.getState().confirmTrash()} onCancel={cancel} />
      </div>
    </div>
  );
}

// Folders the tree hides until "Show hidden" is turned on (same list as main).
const HIDDEN_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'coverage', '.turbo', '.cache']);

type GitMaps = { files: Map<string, TreeGit>; dirs: Map<string, TreeGit> };

function Node({ entry, depth, showHidden, expanded, toggle, changes, git }: { entry: DirEntry; depth: number; showHidden: boolean; expanded: Set<string>; toggle: (p: string) => void; changes: Map<string, ChangeRow>; git: GitMaps }) {
  const activeTab = useApp((s) => s.activeTab);
  const openFile = useApp((s) => s.openFile);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const treeNonce = useApp((s) => s.treeNonce);
  const edit = useApp((s) => s.treeEdit);
  const renaming = edit?.mode === 'rename' && edit.path === entry.path;
  // Move to Trash asked here: the row turns into the question.
  const trashing = useApp((s) => (s.trashAsk?.path === entry.path ? s.trashAsk : null));
  const creatingHere = edit && edit.mode !== 'rename' && edit.dir === entry.path ? edit : null;
  const change = entry.dir ? undefined : changes.get(entry.path);
  const kind = entry.dir ? git.dirs.get(entry.path) : git.files.get(entry.path);
  const open = entry.dir && expanded.has(entry.path);
  // A single click opens the file in the preview tab; a double click (or Open in the menu) keeps it open.
  const act = (preview = false) => (entry.dir ? toggle(entry.path) : openFile(entry.path, entry.rel, null, undefined, { preview }));
  useEffect(() => {
    if (open) void window.atelier.files.list(entry.path, showHidden).then(setChildren);
  }, [open, entry.path, showHidden, treeNonce]);
  if (renaming) return <TreeInput depth={depth} initial={entry.name} kind={entry.dir ? 'folder' : null} onDone={(n) => void commitEdit(edit, n)} />;
  return (
    <>
      {trashing ? <TreeTrashConfirm entry={entry} depth={depth} files={trashing.files} /> : <button type="button" className={`tree-row ${activeTab === entry.path ? 'is-active' : ''} ${entry.hidden ? 'is-hidden' : ''}`}
        style={{ paddingLeft: 6 + depth * 14, ['--depth' as string]: depth }} data-path={entry.path} data-git={!entry.dir ? kind : undefined} aria-expanded={entry.dir ? !!open : undefined}
        // ⌥-click on a file: Open to the Side (split view).
        onClick={(e) => (e.altKey && !entry.dir ? useApp.getState().openFileToSide(entry.path, entry.rel) : act(true))} onDoubleClick={() => { if (!entry.dir) act(); }} onContextMenu={(e) => useApp.getState().openMenu(e, treeMenu({ ...entry, unsure: !!change && unsureOf(change).length > 0 }, () => act()))}
        // Dragged onto a terminal, it pastes its path.
        draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(TREE_PATH_TYPE, '1'); startTreeDrag(entry.path); }} onDragEnd={endTreeDrag}>
        {Array.from({ length: depth }, (_, i) => <span key={i} className="tree-guide" style={{ left: 13 + i * 14 }} />)}
        <span className={`tree-chev ${open ? 'is-open' : ''}`} aria-hidden="true">{entry.dir && <Icon name="chevron" size={12} stroke={2} />}</span>
        {!entry.dir && <FileIcon name={entry.name} />}
        <span className={`tree-name ${entry.dir ? 'is-dir' : ''} ${kind && !entry.dir ? `g-${kind}` : ''}`}>{entry.name}</span>
        {change && <span className="tree-dots"><OriginMarks row={change} /></span>}
        {kind && !entry.dir && <span className={`tree-badge mono g-${kind}`}>{TREE_GIT_LETTER[kind]}</span>}
        {kind && entry.dir && <span className={`tree-git-dot g-${kind}`} aria-hidden="true" />}
      </button>}
      {open && creatingHere && <TreeInput depth={depth + 1} initial="" kind={creatingHere.mode === 'new-folder' ? 'folder' : 'file'} onDone={(n) => void commitEdit(creatingHere, n)} />}
      {open && children?.map((c) => <Node key={c.path} entry={c} depth={depth + 1} showHidden={showHidden} expanded={expanded} toggle={toggle} changes={changes} git={git} />)}
    </>
  );
}

export function FileTree() {
  const project = useApp((s) => s.project);
  // The starting point is the setting; the chip changes it only for this window.
  const hiddenDefault = useApp((s) => s.settings.showHiddenFiles);
  const [showHidden, setShowHidden] = useState(hiddenDefault);
  useEffect(() => { setShowHidden(hiddenDefault); }, [hiddenDefault]);
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [, force] = useState(0);
  const repos = useApp((s) => s.repos);
  const attributions = useApp((s) => s.attributions);
  const changes = useMemo(() => new Map(buildRows(repos, attributions).map((r) => [r.path, r])), [repos, attributions]);
  const root = project?.root ?? '';
  // Tree and git paths are both real paths: folders stop at the project's real root.
  const git = useMemo(() => treeGitMap(repos, project?.realRoot ?? root), [repos, project?.realRoot, root]);
  const expanded = expandedByProject.get(root) ?? new Set<string>();
  expandedByProject.set(root, expanded);
  const treeNonce = useApp((s) => s.treeNonce);
  const edit = useApp((s) => s.treeEdit);
  useEffect(() => { if (root) void window.atelier.files.list(root, showHidden).then(setRoots); }, [root, showHidden, treeNonce]);
  // New file or folder: the target folder opens to show the field.
  useEffect(() => { if (edit && edit.mode !== 'rename' && edit.dir !== root && !expanded.has(edit.dir)) { expanded.add(edit.dir); force((n) => n + 1); } }, [edit, root]);
  const creatingAtRoot = edit && edit.mode !== 'rename' && edit.dir === root ? edit : null;
  const toggle = (p: string) => { if (expanded.has(p)) expanded.delete(p); else expanded.add(p); force((n) => n + 1); };
  // Collapse folders is enabled when a folder is visibly open: a top-level one (folders inside a closed one keep their
  // state for when it reopens, but don't count).
  const anyOpen = roots.some((e) => e.dir && expanded.has(e.path));
  useEffect(() => {
    const f = () => force((n) => n + 1);
    collapseListeners.add(f);
    return () => { collapseListeners.delete(f); };
  }, []);
  // Reveal in Files: the folders containing the file are opened, then the row is scrolled into view and flashes (a
  // quiet one, Files opened with that file in front, doesn't: the row is already marked as the active one).
  const reveal = useApp((s) => s.treeReveal);
  const treeBox = useRef<HTMLDivElement>(null);
  const realRoot = project?.realRoot ?? root;
  useEffect(() => {
    // Each reveal is done once: the tree mounting again (back to Files) doesn't redo an old one.
    if (!reveal || !root || revealed.has(reveal.nonce)) return;
    // Tree rows carry real paths: a path given under the project's link is found under its real root.
    const base = isBelow(realRoot, reveal.path) ? realRoot : isBelow(root, reveal.path) ? root : null;
    if (!base) return;
    revealed.add(reveal.nonce);
    const parts = reveal.path.slice(base.length + 1).split('/');
    if (parts.slice(0, -1).some((p) => HIDDEN_DIRS.has(p))) setShowHidden(true);
    for (let i = 1; i < parts.length; i++) expanded.add(`${realRoot}/${parts.slice(0, i).join('/')}`);
    force((n) => n + 1);
    let tries = 0;
    const find = () => {
      const row = treeBox.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(`${realRoot}/${parts.join('/')}`)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        if (!reveal.quiet) { row.classList.remove('is-flash'); void row.offsetWidth; row.classList.add('is-flash'); }
      } else if (tries++ < 40) setTimeout(find, 50);
      else if (!reveal.quiet) useApp.getState().showToast(t.notInTree, undefined, 'info');
    };
    find();
  }, [reveal, root, realRoot]);
  return (
    <>
      <div className="sidebar-head">
        <span className="section-label">{t.files}</span>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label={t.menu.newFile} data-tip={t.menu.newFile} onClick={() => useApp.getState().startTreeEdit({ mode: 'new-file', dir: root })}><Icon name="plus" size={14} /></button>
        <button type="button" className={`icon-btn ${showHidden ? 'is-on' : ''}`} aria-label={t.showHidden} aria-pressed={showHidden}
          data-tip={showHidden ? t.hideHidden : t.showHidden} onClick={() => setShowHidden((v) => !v)}><Icon name={showHidden ? 'eye' : 'eye-off'} size={14} /></button>
        <button type="button" className="icon-btn" aria-label={t.collapseFolders} data-tip={t.collapseFolders} disabled={!anyOpen}
          onClick={() => collapseAllFolders(root)}><Icon name="collapseAll" size={14} /></button>
      </div>
      {/* The empty area below the rows stands for the project root. */}
      <div className="tree" ref={treeBox} onContextMenu={(e) => { if (e.target === e.currentTarget && root) useApp.getState().openMenu(e, treeRootMenu(root)); }}>
        {creatingAtRoot && <TreeInput depth={0} initial="" kind={creatingAtRoot.mode === 'new-folder' ? 'folder' : 'file'} onDone={(n) => void commitEdit(creatingAtRoot, n)} />}
        {roots.map((e) => <Node key={e.path} entry={e} depth={0} showHidden={showHidden} expanded={expanded} toggle={toggle} changes={changes} git={git} />)}
      </div>
    </>
  );
}
