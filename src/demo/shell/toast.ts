import { h, icon, ICONS } from './dom';

// The shell's one-line notices (not in the demo, the browser keeps a shortcut, paste from the menu): one at a time,
// bottom centre above the app's footer, gone after a few seconds (the timer waits while the pointer is on it).

export interface ToastContent { text: string; link?: { label: string; href: string }; after?: string }

export function createToast(layer: HTMLElement) {
  const box = h('div', { class: 'dm-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  layer.append(box);
  let timer = 0;
  let hovered = false;
  let ms = 0;
  const hide = () => { clearTimeout(timer); box.hidden = true; box.replaceChildren(); };
  const arm = () => { clearTimeout(timer); if (!hovered) timer = window.setTimeout(hide, ms); };
  box.addEventListener('pointerenter', () => { hovered = true; clearTimeout(timer); });
  box.addEventListener('pointerleave', () => { hovered = false; arm(); });
  return {
    show(c: ToastContent, duration = 4000) {
      ms = duration;
      const close = h('button', { type: 'button', class: 'dm-toast-close', 'aria-label': 'Dismiss' }, icon(ICONS.close, 12));
      close.addEventListener('mousedown', (e) => e.preventDefault());
      close.addEventListener('click', hide);
      const p = h('p', {}, c.text);
      if (c.link) p.append(' ', h('a', { href: c.link.href, target: '_top' }, c.link.label));
      if (c.after) p.append(c.after);
      box.replaceChildren(h('i', { class: 'dm-toast-dot', 'aria-hidden': 'true' }), p, close);
      // Re-run the entrance for a toast replacing another.
      box.hidden = true;
      void box.offsetWidth;
      box.hidden = false;
      arm();
    },
    hide
  };
}
