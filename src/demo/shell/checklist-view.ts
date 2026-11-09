import { CHECKLIST, segments, type ChecklistId, type ChecklistState } from './checklist';
import { DOWNLOAD_HREF } from './menu-model';
import { h, icon, ICONS, renderSegments } from './dom';

// "Things to try": a floating pill, bottom right, open on the first entry and collapsible. Every
// item is a "show me" button (`pick`: the shell runs its action) and ticks itself; with all of them done it becomes
// one line, "That's Atelier. Download for Mac".

export function createChecklistView(layer: HTMLElement, opts: { pick(id: ChecklistId): void }) {
  const root = h('section', { class: 'dm-check', 'aria-label': 'Things to try' });
  const ring = h('span', { class: 'dm-ring', 'aria-hidden': 'true' });
  const count = h('span', { class: 'dm-check-count mono' });
  const head = h('button', { type: 'button', class: 'dm-check-head', 'aria-expanded': 'true', 'aria-controls': 'dm-check-body' },
    ring, h('span', { class: 'dm-check-title' }, 'Things to try'), count, h('span', { class: 'dm-check-chev', 'aria-hidden': 'true' }, icon(ICONS.chevronUp, 13)));
  const buttons = CHECKLIST.map((item) => {
    const b = h('button', { type: 'button', class: 'dm-check-btn' },
      h('span', { class: 'dm-tick', 'aria-hidden': 'true' }, icon(ICONS.check, 11, 2.2)),
      h('span', { class: 'dm-check-text' }, ...renderSegments(segments(item.text))),
      h('span', { class: 'dm-check-go', 'aria-hidden': 'true' }, icon(ICONS.chevronRight, 13, 2)));
    // A click never takes the keyboard: it stays where the visitor was, and the action puts it where the app does.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => opts.pick(item.id));
    return b;
  });
  const rows = CHECKLIST.map((item, i) => h('li', { class: 'dm-check-item', 'data-item': item.id }, buttons[i]!));
  const hint = h('p', { class: 'dm-check-hint', id: 'dm-check-hint' }, 'Click one to see it.');
  const list = h('ol', { class: 'dm-check-list', 'aria-describedby': 'dm-check-hint' }, ...rows);
  root.append(head, h('div', { class: 'dm-check-body', id: 'dm-check-body' }, hint, list));
  layer.append(root);

  let open = true;
  let finished = false;
  const setOpen = (v: boolean) => {
    open = v;
    root.classList.toggle('is-collapsed', !v);
    head.setAttribute('aria-expanded', String(v));
  };
  head.addEventListener('mousedown', (e) => e.preventDefault());
  head.addEventListener('click', () => setOpen(!open));

  return {
    render(s: ChecklistState) {
      const done = s.done.size;
      const total = CHECKLIST.length;
      CHECKLIST.forEach((item, i) => {
        const row = rows[i]!;
        const was = row.classList.contains('is-done');
        const now = s.done.has(item.id);
        row.classList.toggle('is-done', now);
        if (now && !was) { row.classList.add('is-fresh'); setTimeout(() => row.classList.remove('is-fresh'), 1200); }
        buttons[i]!.setAttribute('aria-label', `${now ? 'Done: ' : ''}${buttons[i]!.textContent ?? ''}`);
      });
      count.textContent = `${done}/${total}`;
      ring.style.setProperty('--p', String(done / total));
      if (done === total && !finished) {
        finished = true;
        root.classList.add('is-finished');
        const link = h('a', { href: DOWNLOAD_HREF, target: '_top' }, 'Download for Mac');
        root.replaceChildren(h('p', { class: 'dm-check-done', role: 'status' },
          h('span', { class: 'dm-tick', 'aria-hidden': 'true' }, icon(ICONS.check, 11, 2.2)), "That's Atelier. ", link));
      }
    },
    /** Where it floats (make-way.ts: clear of the Changes panel's commit bar and drawer). */
    place(at: { right: number; bottom: number }) {
      const right = `${at.right}px`, bottom = `${at.bottom}px`;
      if (root.style.right !== right) root.style.right = right;
      if (root.style.bottom !== bottom) root.style.bottom = bottom;
    },
    /** Help › Things to Try: open it again. */
    show() { if (!finished) setOpen(true); root.classList.remove('is-hidden'); (finished ? root.querySelector('a') : head)?.focus({ preventScroll: true }); }
  };
}
