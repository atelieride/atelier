// The JSON view's Raw: a json column's text as stored — its spacing, a key it repeats
// —, a jsonb one pretty-printed (2 spaces, numbers as written); masked as the grid shows it;
//selectable, its start laid out (256 KB) and Copy all for the whole; its scroll keys its own. Its own
// module; lazy, with the table's chunk.
import { useMemo } from 'react';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { bytesLabel } from './grid-model';
import { prettyJson, scrollKey, type JsonNode } from './json';
import { clipText, jsonMaskText } from './json-text';
import { copyOut } from './json-ui';

/** Characters laid out at most (Copy all copies the whole value). */
const RAW_MAX = 256 * 1024;

/** `stored`: a json column's text as Postgres keeps it (null: jsonb, normalized — pretty-printed from the tree). */
export function JsonRaw({ tree, stored, secret }: { tree: JsonNode; stored: string | null; secret: ((k: string) => boolean) | null }) {
  // The whole text for a stored value (masked, exactly as written otherwise); a jsonb one only as far as shown.
  const whole = useMemo(() => (stored === null ? null : secret ? jsonMaskText(stored, secret) : stored), [stored, secret]);
  const shown = useMemo(() => (whole !== null
    ? { text: whole.length > RAW_MAX ? clipText(whole, RAW_MAX) : whole, cut: whole.length > RAW_MAX }
    : prettyJson(tree, { secret, max: RAW_MAX })), [whole, tree, secret]);
  const copyAll = () => copyOut(whole ?? (shown.cut ? prettyJson(tree, { secret }).text : shown.text), tdt.json.copiedValue);
  return (
    <div className="dbj-raw">
      <div className="dbj-raw-head">
        {shown.cut && <span className="dbj-raw-note" data-tip={tdt.json.raw.cut(bytesLabel(RAW_MAX))}>{tdt.json.raw.cut(bytesLabel(RAW_MAX))}</span>}
        <span className="dbj-sp" />
        <button type="button" className="btn-ghost sm dbj-raw-copy" onClick={copyAll}><Icon name="copy" size={12} />{shown.cut ? tdt.json.raw.copyAll : tdt.copy}</button>
      </div>
      <pre className="dbj-raw-pre mono" tabIndex={0} onKeyDown={(e) => { if (scrollKey(e.key)) e.stopPropagation(); }}>{shown.text}</pre>
    </div>
  );
}
