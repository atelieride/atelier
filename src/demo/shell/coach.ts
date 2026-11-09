import { h, kbd } from './dom';

// The first hint: once per visit, a toast-style coach mark pointing at the session
// that waits for the visitor. It says the honest part once ("scripted sessions") and gives the first thing to do.
// Any key or click dismisses it (and still does what it does).

const TARGET = '.session-row.state-waiting';
const FALLBACK = '.session-row';

export function showCoach(layer: HTMLElement): () => void {
  const card = h('div', { class: 'dm-coach', role: 'status' },
    h('i', { class: 'dm-coach-arrow', 'aria-hidden': 'true' }),
    h('p', { class: 'dm-coach-lead' }, 'The real app in your browser, with scripted sessions.'),
    h('p', { class: 'dm-coach-do' }, 'Someone needs you: press ', kbd('⌘J'), '.'));
  layer.append(card);

  const place = () => {
    const row = document.querySelector<HTMLElement>(TARGET) ?? document.querySelector<HTMLElement>(FALLBACK);
    const r = row?.getBoundingClientRect();
    if (!r || r.width === 0) { card.classList.add('is-free'); return; }
    card.classList.remove('is-free');
    const c = card.getBoundingClientRect();
    const top = Math.min(Math.max(8, r.top + r.height / 2 - c.height / 2), innerHeight - c.height - 8);
    card.style.left = `${Math.round(r.right + 14)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.setProperty('--arrow-y', `${Math.round(r.top + r.height / 2 - top)}px`);
  };
  place();
  // The sidebar settles (rows enter, fonts swap) during the first second: follow it, then on resize only.
  const settle = window.setInterval(place, 250);
  const stopSettle = window.setTimeout(() => clearInterval(settle), 2500);

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearInterval(settle);
    clearTimeout(stopSettle);
    removeEventListener('keydown', dismiss, true);
    removeEventListener('pointerdown', dismiss, true);
    removeEventListener('resize', place);
    card.classList.add('is-leaving');
    setTimeout(() => card.remove(), 200);
  };
  addEventListener('keydown', dismiss, true);
  addEventListener('pointerdown', dismiss, true);
  addEventListener('resize', place);
  return dismiss;
}
