// JSON navigation: the file bar's path of the value under the cursor (Source) or selected
// (Tree) — one button per segment, its type, Copy Path and the green "Copied …" that replaces it for a moment.
import { crumbs, typeLabel, type TypeInfo } from './paths';
import type { Segment } from './scan';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { kbd } from '../kbd';

export function JsonPath(p: { path: Segment[]; info: TypeInfo | null; flash: string | null; onGo: (path: Segment[]) => void; onCopy: () => void }) {
  const segs = crumbs(p.path);
  return (
    <>
      <span className="json-path" role="group" aria-label={t.json.path}>
        {segs.map((s, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className="json-sep" aria-hidden="true">›</span>
            <button type="button" className={`json-seg ${i === segs.length - 1 ? 'is-last' : ''}`} onClick={() => p.onGo(s.path)}>{s.label}</button>
          </span>
        ))}
        {p.info && <span className="json-type">{typeLabel(p.info)}</span>}
      </span>
      {p.flash
        ? <span className="json-copied" role="status"><Icon name="check" size={12} stroke={2} />{p.flash}</span>
        : <button type="button" className="icon-btn json-copy" aria-label={t.json.copyPath} data-tip={`${t.json.copyPath} · ${kbd('⌥⇧⌘C')}`} onClick={p.onCopy}><Icon name="copy" size={13} stroke={1.7} /></button>}
    </>
  );
}
