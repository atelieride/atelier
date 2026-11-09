// CSV viewer: the file bar's cell address — `G6` or `F3:G9`, the column's name, what the
// cell or range is — then Copy cell, and the green "Copied …" that replaces it for a moment.
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';

export interface CsvCrumb { address: string; column: string | null; info: string; bad?: boolean }

export function CsvAddress({ crumb, flash, onCopy }: { crumb: CsvCrumb; flash: string | null; onCopy: (() => void) | null }) {
  return (
    <>
      <span className="json-path csv-crumb" role="group" aria-label={t.csv.copyCell}>
        <span className="json-sep" aria-hidden="true">›</span>
        <span className={`csv-addr ${crumb.bad ? 'is-bad' : ''}`}>{crumb.address}</span>
        {crumb.column && <span className="csv-crumb-col">{crumb.column}</span>}
        <span className="json-type">{crumb.info}</span>
      </span>
      {flash
        ? <span className="json-copied" role="status"><Icon name="check" size={12} stroke={2} />{flash}</span>
        : onCopy && <button type="button" className="icon-btn json-copy csv-copy" aria-label={t.csv.copyCell} data-tip={t.csv.copyCell} onClick={onCopy}><Icon name="copy" size={13} stroke={1.7} /></button>}
    </>
  );
}
