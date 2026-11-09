import { describe, expect, test, vi } from 'vitest';
import { demoMessage } from '../protocol';
import { createChannel, fromParent, type ChannelDeps } from './channel';

function setup(embedded = true) {
  const deps = {
    embedded, post: vi.fn(), pause: vi.fn(), resume: vi.fn(), focus: vi.fn(), key: vi.fn(), open: vi.fn(), leave: vi.fn(), requestFullscreen: vi.fn()
  } satisfies ChannelDeps;
  return { deps, ch: createChannel(deps) };
}
const types = (post: ReturnType<typeof vi.fn>) => post.mock.calls.map((c) => (c[0] as { type: string }).type);

describe('createChannel: demo → page', () => {
  test('ready is posted once', () => {
    const { deps, ch } = setup();
    ch.ready(); ch.ready();
    expect(types(deps.post)).toEqual(['ready']);
    expect(ch.isReady).toBe(true);
  });

  test('failed only before ready, once, with a bounded reason', () => {
    const { deps, ch } = setup();
    ch.fail('x'.repeat(900)); ch.fail('again');
    expect(types(deps.post)).toEqual(['failed']);
    expect((deps.post.mock.calls[0]![0] as { reason: string }).reason).toHaveLength(500);
    const b = setup();
    b.ch.ready(); b.ch.fail('late');
    expect(types(b.deps.post)).toEqual(['ready']);
  });

  test('a failed demo never says ready afterwards', () => {
    const { deps, ch } = setup();
    ch.fail('boom'); ch.ready();
    expect(types(deps.post)).toEqual(['failed']);
  });

  test('exit and full screen go to the page; opened directly, the demo leaves to / and asks the browser itself', () => {
    const { deps, ch } = setup();
    ch.exit(); ch.fullscreen(); ch.checklist(3, 8);
    expect(deps.post.mock.calls.map((c) => c[0])).toEqual([{ type: 'exit' }, { type: 'fullscreen' }, { type: 'checklist', done: 3, total: 8 }]);
    const direct = setup(false);
    direct.ch.exit(); direct.ch.fullscreen(); direct.ch.ready(); direct.ch.checklist(1, 8);
    expect(direct.deps.post).not.toHaveBeenCalled();
    expect(direct.deps.leave).toHaveBeenCalledOnce();
    expect(direct.deps.requestFullscreen).toHaveBeenCalledOnce();
  });
});

describe('createChannel: page → demo', () => {
  test('pause and resume stop and restart the clock; the tab hidden pauses it too, and both must clear', () => {
    const { deps, ch } = setup();
    ch.receive(demoMessage({ type: 'pause' }));
    expect(deps.pause).toHaveBeenCalledTimes(1);
    ch.visibility(true);
    ch.receive(demoMessage({ type: 'resume' }));
    expect(deps.resume).not.toHaveBeenCalled(); // still hidden
    ch.visibility(false);
    expect(deps.resume).toHaveBeenCalledTimes(1);
    ch.receive(demoMessage({ type: 'resume' }));
    expect(deps.resume).toHaveBeenCalledTimes(1);
    expect(deps.pause).toHaveBeenCalledTimes(1);
  });

  test('focus and key are handed over', () => {
    const { deps, ch } = setup();
    const key = { key: 'j', code: 'KeyJ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false };
    ch.receive(demoMessage({ type: 'focus' }));
    ch.receive(demoMessage({ type: 'key', key }));
    expect(deps.focus).toHaveBeenCalledOnce();
    expect(deps.key).toHaveBeenCalledWith(key);
  });

  test('open waits for ready', () => {
    const { deps, ch } = setup();
    ch.receive(demoMessage({ type: 'open', view: 'view-docker' }));
    expect(deps.open).not.toHaveBeenCalled();
    ch.ready();
    expect(deps.open).toHaveBeenCalledWith('view-docker');
    ch.receive(demoMessage({ type: 'open', view: 'view-redis' }));
    expect(deps.open).toHaveBeenLastCalledWith('view-redis');
  });

  test('anything off the protocol is ignored', () => {
    const { deps, ch } = setup();
    ch.receive({ source: 'atelier-demo', type: 'pause', extra: 1 });
    ch.receive({ type: 'pause' });
    ch.receive('pause');
    ch.receive(demoMessage({ type: 'open', view: 'Not A Command' as never }));
    expect(deps.pause).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });
});

describe('fromParent', () => {
  const parent = {};
  test('only the parent window, from this origin', () => {
    expect(fromParent({ origin: 'https://useatelier.dev', source: parent }, { origin: 'https://useatelier.dev', parent })).toBe(true);
    expect(fromParent({ origin: 'https://evil.example', source: parent }, { origin: 'https://useatelier.dev', parent })).toBe(false);
    expect(fromParent({ origin: 'https://useatelier.dev', source: {} }, { origin: 'https://useatelier.dev', parent })).toBe(false);
    expect(fromParent({ origin: 'null', source: parent }, { origin: 'null', parent })).toBe(false);
  });
});
