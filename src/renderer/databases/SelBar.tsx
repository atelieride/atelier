// The grid's action bar, as the Docker and Redis bars: "N rows" ·
// Send to <session> ⌥↩ (disabled, the reason in its tooltip, with no session) · Ask in New Session · Copy as JSON ▾
// (JSON, CSV, Markdown, SQL INSERT) · ×. It floats over the grid's foot — the rows always end with room for it and a row
// brought into view stops above it, so it hides no row, and it sits above the footer —, centered on the rows: clear of
// the scrollbars and of an inspector lying over them (`right`, `bottom`). In a narrow grid its labels fold to icons
// (names in the tooltips), then the count; too narrow for its buttons, it hides (the cell menu and ⌥↩ do the same).
// Drawn from props alone (no hooks): Grid owns the selection and the copies. Lazy, with the table's chunk and its
// stylesheet.
import './selbar.css';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import { COPY_FORMATS, type CopyFormat } from './grid-copy';

const c = tdt.claude;

export interface SelBarProps {
  /** The rows selected. */
  count: number;
  /** The session Send pastes into (its title), or none. */
  target: string | null;
  /** Room on the right (an inspector lying over the rows, the vertical scrollbar) and below (the horizontal one), in px. */
  right: number;
  bottom: number;
  /** The formats menu ▾ opened is the one on screen. */
  formatsOpen: boolean;
  onSend(): void;
  onAsk(): void;
  onCopy(fmt: CopyFormat): void;
  /** ▾: the formats menu, by the button it was opened from. */
  onFormats(e: { currentTarget: HTMLElement }): void;
  onClear(): void;
}

/** Copy as ▾: the cell menu's Copy Rows As formats. */
export function formatsMenu(copy: (fmt: CopyFormat) => void): MenuItem[] {
  return COPY_FORMATS.map((f): MenuItem => ({ id: `copy-as-${f}`, label: tdt.grid.menu.formats[f], run: () => copy(f) }));
}

export function SelBar(p: SelBarProps) {
  const send = p.target === null ? c.sendNone : c.sendTo(p.target);
  return (
    <div className="db-selwrap" style={{ right: p.right, bottom: p.bottom }}>
      <div className="db-selbar" role="toolbar" aria-label={c.rows(p.count)}>
        <span className="db-selbar-n">{c.rows(p.count)}</span>
        <span className="db-selbar-sep" aria-hidden="true" />
        <button type="button" className="btn-primary sm sel-send" aria-label={send} data-tip={p.target === null ? t.docker.noSession : c.sendTip(p.target)}
          disabled={p.target === null} onClick={p.onSend}>
          <span className="db-sel-icon"><Icon name="send" size={12} /></span>
          <span className="dk-ellipsis db-sel-label">{send}</span>{p.target !== null && <span className="kbd-in">{kbd('⌥↩')}</span>}
        </button>
        <button type="button" className="btn-ghost sm" aria-label={c.askNew} data-tip={c.askNew} onClick={p.onAsk}>
          <Icon name="sparkle" size={12} /><span className="db-sel-label">{c.askNew}</span>
        </button>
        <span className="db-split">
          <button type="button" className="btn-ghost sm" aria-label={c.copyJson} data-tip={c.copyJson} onClick={() => p.onCopy('json')}>
            <Icon name="copy" size={12} /><span className="db-sel-label">{c.copyJson}</span>
          </button>
          <button type="button" className="btn-ghost sm db-split-more" aria-label={c.formats} data-tip={c.formatsTip} aria-haspopup="menu" aria-expanded={p.formatsOpen}
            onClick={p.onFormats}>
            <Icon name="chevronDown" size={12} />
          </button>
        </span>
        <button type="button" className="icon-btn db-selbar-x" aria-label={c.clear} data-tip={c.clear} onClick={p.onClear}><Icon name="x" size={12} /></button>
      </div>
    </div>
  );
}
