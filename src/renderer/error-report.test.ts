import { expect, test } from 'vitest';
import { RENDERER_ERROR_MAX } from '@shared/api';
import { crashDetails, rendererError } from './error-report';

test('an Error becomes its message and stack, clipped to what main accepts', () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'replace')");
  const e = rendererError('boundary', err, 'Sidebar', '\n    at TermRow');
  expect(e.kind).toBe('boundary');
  expect(e.panel).toBe('Sidebar');
  expect(e.message).toBe("TypeError: Cannot read properties of undefined (reading 'replace')");
  expect(e.stack).toContain('error-report.test.ts');
  expect(e.stack).toContain('Component stack:\n    at TermRow');
  const big = rendererError('error', new Error('x'.repeat(10_000)));
  expect(big.message.length).toBeLessThanOrEqual(RENDERER_ERROR_MAX.message);
  expect((big.stack ?? '').length).toBeLessThanOrEqual(RENDERER_ERROR_MAX.stack);
});

test('anything thrown (a string, an object, undefined) still gives a message', () => {
  expect(rendererError('rejection', 'plain').message).toBe('plain');
  expect(rendererError('rejection', { code: 7 }).message).toBe('{"code":7}');
  expect(rendererError('rejection', undefined).message).toBe('undefined');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(rendererError('rejection', cyclic).message).toBe('[object Object]');
});

test('Copy details: version, panel, message and stack, ready to paste in a report', () => {
  const text = crashDetails({ kind: 'boundary', panel: 'Changes', message: 'Error: boom', stack: 'Error: boom\n    at f' }, '2.0.0');
  expect(text).toBe('Atelier 2.0.0 · Changes\nError: boom\n\nError: boom\n    at f');
});
