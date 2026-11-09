import { beforeEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACTION_TOAST_MS, useApp } from '../store';
import { ToastView, toastActions, toastInset } from './Toast';

// Toasts: up to two actions ("Committed f0d6c52 to acme-store" · Push · Undo); one-action and
// plain toasts unchanged; an optional duration (30 s Undo after a dropped stash or a deleted branch).

const html = () => renderToStaticMarkup(createElement(ToastView, { toast: useApp.getState().toast }));
beforeEach(() => useApp.setState({ toast: null }));

test('a plain toast and a one-action toast render as before', () => {
  useApp.getState().showToast('Saved', undefined, 'info');
  expect(html()).toBe('<button type="button" class="toast is-info" role="status"><i></i>Saved</button>');
  useApp.getState().showToast('Sent', { label: 'Undo', run: () => {} });
  expect(html()).toBe('<div class="toast has-action" role="status"><i></i><span class="toast-text">Sent</span><button type="button" class="toast-action">Undo</button></div>');
});

test('two actions: both buttons, in order', () => {
  useApp.getState().showToast('Committed f0d6c52 to acme-store', [{ label: 'Push', run: () => {} }, { label: 'Undo', run: () => {} }], 'info');
  expect(html()).toBe('<div class="toast has-action is-info" role="status"><i></i><span class="toast-text">Committed f0d6c52 to acme-store</span>'
    + '<button type="button" class="toast-action">Push</button><button type="button" class="toast-action">Undo</button></div>');
});

test('one action stays in `action` (existing readers unchanged); a pair adds `second`; toastActions lists them', () => {
  const a = { label: 'A', run: () => {} };
  const b = { label: 'B', run: () => {} };
  useApp.getState().showToast('one', a);
  expect(useApp.getState().toast).toMatchObject({ action: a });
  expect(useApp.getState().toast).not.toHaveProperty('second');
  useApp.getState().showToast('two', [a, b]);
  expect(useApp.getState().toast).toMatchObject({ action: a, second: b });
  expect(toastActions({})).toEqual([]);
  expect(toastActions({ action: a })).toEqual([a]);
  expect(toastActions({ action: a, second: b })).toEqual([a, b]);
});

test('a toast with its own duration holds plain toasts behind it for that long', () => {
  vi.useFakeTimers();
  try {
    useApp.getState().showToast('Dropped “wip”', { label: 'Undo', run: () => {} }, 'info', 30_000);
    expect(useApp.getState().toast).toMatchObject({ ms: 30_000 });
    vi.advanceTimersByTime(ACTION_TOAST_MS + 1000);
    useApp.getState().showToast('Something else');
    expect(useApp.getState().toast?.text).toBe('Dropped “wip”');
    vi.advanceTimersByTime(30_000);
    useApp.getState().showToast('Something else');
    expect(useApp.getState().toast?.text).toBe('Something else');
  } finally { vi.useRealTimers(); }
});

// A toast over the Changes panel hid its controls (the commit drawer's ▾ for the 8 s of "Committed … · Push · Undo"):
// with the panel open on the right, toasts sit at the bottom right of the space beside it.
test('inset: the toast moves left by the Changes panel\'s width; none, markup as before', () => {
  useApp.getState().showToast('Committed f0d6c52 to acme-store', [{ label: 'Push', run: () => {} }, { label: 'Undo', run: () => {} }], 'info');
  const at = (inset: number) => renderToStaticMarkup(createElement(ToastView, { toast: useApp.getState().toast, inset }));
  expect(at(304)).toContain('style="--toast-inset:304px"');
  expect(at(0)).not.toContain('style=');
  useApp.setState({ toast: null });
  useApp.getState().showToast('Saved', undefined, 'info');
  expect(at(280)).toBe('<button type="button" class="toast is-info" role="status" style="--toast-inset:280px"><i></i>Saved</button>');
});

test('the inset: the Changes panel\'s width when it is open on the right, else none', () => {
  expect(toastInset({ project: true, showChanges: true, swapped: false, changesWidth: 304 })).toBe(304);
  expect(toastInset({ project: true, showChanges: false, swapped: false, changesWidth: 304 })).toBe(0);
  expect(toastInset({ project: true, showChanges: true, swapped: true, changesWidth: 304 })).toBe(0);
  expect(toastInset({ project: false, showChanges: true, swapped: false, changesWidth: 304 })).toBe(0);
});
