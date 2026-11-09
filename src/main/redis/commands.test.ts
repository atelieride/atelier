import { describe, expect, test } from 'vitest';
import { assertRead, assertWrite, commandKind } from './commands';
import { QUEUE_SCRIPTS, scriptSha } from './queue-scripts';

describe('the command allowlist', () => {
  test('reads pass, with their subcommands only', () => {
    expect(() => assertRead(['GET', 'k'])).not.toThrow();
    expect(() => assertRead(['scan', '0', 'MATCH', '*'])).not.toThrow();
    expect(() => assertRead(['MEMORY', 'USAGE', 'k', 'SAMPLES', '0'])).not.toThrow();
    expect(() => assertRead(['CLIENT', 'list'])).not.toThrow();
    expect(() => assertRead(['CONFIG', 'GET', 'dir'])).not.toThrow();
    expect(() => assertRead(['MEMORY', 'PURGE'])).toThrow(/not allowed/);
    expect(() => assertRead(['CONFIG', 'SET', 'dir', '/tmp'])).toThrow(/not allowed/);
    expect(() => assertRead(['CLIENT', 'KILL', 'ID', '3'])).toThrow(/not allowed/);
    expect(() => assertRead(['CLIENT'])).toThrow(/not allowed/);
  });

  test('writes are not reads, and unknown commands are neither', () => {
    for (const w of [['DEL', 'k'], ['SET', 'k', 'v'], ['FLUSHDB', 'ASYNC'], ['EVAL', 'return 1', '0'], ['KEYS', '*'], ['FLUSHALL'], ['SHUTDOWN'], ['DEBUG', 'SLEEP', '1']]) {
      expect(() => assertRead(w), w.join(' ')).toThrow(/not allowed/);
    }
    for (const w of [['KEYS', '*'], ['FLUSHALL'], ['SHUTDOWN'], ['CONFIG', 'SET', 'x', 'y'], ['FLUSHDB'], ['FLUSHDB', 'SYNC'], ['RENAME', 'a', 'b']]) {
      expect(() => assertWrite(w), w.join(' ')).toThrow(/not allowed/);
    }
  });

  test('writes pass assertWrite; reads pass it too (a write path may read)', () => {
    expect(() => assertWrite(['UNLINK', 'a', 'b'])).not.toThrow();
    expect(() => assertWrite(['FLUSHDB', 'async'])).not.toThrow();
    expect(() => assertWrite(['RESTORE', 'k', '0', Buffer.from('x')])).not.toThrow();
    expect(() => assertWrite(['DUMP', 'k'])).not.toThrow();
  });

  test('scripts: only the fixed queue scripts, by text or by SHA-1', () => {
    const s = QUEUE_SCRIPTS.bullmqRetry;
    expect(() => assertWrite(['EVAL', s, '1', 'k'])).not.toThrow();
    expect(() => assertWrite(['EVALSHA', scriptSha(s), '1', 'k'])).not.toThrow();
    expect(() => assertWrite(['EVAL', `${s} `, '1', 'k'])).toThrow(/not allowed/);
    expect(() => assertWrite(['EVALSHA', 'a'.repeat(40), '0'])).toThrow(/not allowed/);
  });

  test('commandKind classifies for the guard and the monitor', () => {
    expect(commandKind('get')).toBe('read');
    expect(commandKind('UNLINK')).toBe('write');
    expect(commandKind('KEYS')).toBe('unknown');
  });
});
