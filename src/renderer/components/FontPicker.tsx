import { lazy, Suspense, useRef, useState } from 'react';
import { BUNDLED_FONT, fontStack } from '@shared/terminal-font';
import { t } from '../i18n/en';
import { Icon } from './Icon';

// Loaded on the first opening: the list and its browsing stay out of the first paint (the live demo's budget).
const FontPopover = lazy(() => import('./FontPopover').then((m) => ({ default: m.FontPopover })));

/**
 * Settings › Terminal › Font: the font in use, named in its own face, and the
 * popover that browses the others. `missing`: saved but not installed here (the row says so).
 */
export function FontPicker({ family, missing }: { family: string; missing: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} type="button" className={`set-select font-button ${open ? 'is-open' : ''} ${missing ? 'is-missing' : ''}`}
        aria-haspopup="dialog" aria-expanded={open} aria-label={t.set.termFamilyButton(family, missing)} onClick={() => setOpen((o) => !o)}>
        <span className="font-button-name" style={{ fontFamily: fontStack(family) }}>{family}</span>
        <span className="font-button-end">
          {family === BUNDLED_FONT && <span className="font-tag">{t.fontPick.default}</span>}
          <Icon name="chevronDown" size={12} stroke={1.9} />
        </span>
      </button>
      {open && <Suspense fallback={null}><FontPopover anchor={button} onClose={() => setOpen(false)} /></Suspense>}
    </>
  );
}
