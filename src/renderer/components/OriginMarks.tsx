import type { MouseEvent } from 'react';
import { chipOf, dotProps, originTip, sessionOrderKey, sureBy, type ChangeRow } from '../changes';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * Who changed a row's file: the sessions that surely did, one dot each (a ring with a
 * person mark when the user said so), then one "either" chip for every unsure candidate — their colors overlapped and
 * a "?". The chip opens "Why unsure" and never the file; it sits inside the row's button, so it is a span, and the
 * keyboard way is the row's context menu (Who Changed This…).
 */
export function OriginMarks({ row, unknown = false, button = false }: { row: ChangeRow; unknown?: boolean; button?: boolean }) {
  const order = useApp((s) => sessionOrderKey(s.terminals));
  const chip = chipOf(row, order.split('\n'));
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    useApp.getState().setOriginSheet(row.path);
  };
  return (
    <>
      {unknown && row.by.length === 0 && <i className="dot unknown" title={t.unknownOrigin} />}
      {sureBy(row.by).map((b) => b.resolved
        ? <span key={b.terminalId} className="dot-resolved"><i {...dotProps(b)} title={originTip(b)} /><Icon name="person" size={9} stroke={2.2} /></span>
        : <i key={b.terminalId} {...dotProps(b)} title={originTip(b)} />)}
      {/* Outside a row button (Review) the chip is a real button, reachable with the keyboard. */}
      {chip && button && (
        <button type="button" className="either" title={chip.tip} aria-label={chip.tip} onClick={open}>
          {chip.colors.slice(0, 3).map((c, i) => <i key={i} className="either-dot" style={{ background: c }} />)}
          <span className="either-q mono" aria-hidden="true">?</span>
        </button>
      )}
      {chip && !button && (
        <span className="either" title={chip.tip} onClick={open} onDoubleClick={(e) => e.stopPropagation()}>
          {chip.colors.slice(0, 3).map((c, i) => <i key={i} className="either-dot" style={{ background: c }} />)}
          <span className="either-q mono" aria-hidden="true">?</span>
        </span>
      )}
    </>
  );
}
