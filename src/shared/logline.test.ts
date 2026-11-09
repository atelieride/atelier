import { describe, expect, test } from 'vitest';
import { classify, detectPort, parseAnsi, parseLogLine, pasteText, stripAnsi } from './logline';

describe('classify', () => {
  test.each([
    ['[transcription] chunk 3/7 finishReason=MAX_TOKENS · ERROR output truncated', 'error'],
    ['Error: connect ECONNREFUSED 127.0.0.1:5432', 'error'],
    ['    at Object.<anonymous> (/p/src/a.ts:12:5)', 'error'],
    ['UnhandledPromiseRejectionWarning: x', 'error'],
    ['FATAL boom', 'error'],
    ['WARN resumed from chunk 3/7', 'warn'],
    ['(node:123) Warning: deprecated', 'warn'],
    ['VITE v7.3.7  ready in 812 ms', 'ok'],
    ['GET /api/reports 200 44ms', 'info'],
    ['something', 'plain'],
    ['{"level":"error","msg":"x"}', 'error'],
    ['{"level":30,"msg":"pino info"}', 'info'],
    ['{"level":50,"msg":"pino error"}', 'error']
  ])('%s → %s', (t, l) => expect(classify(t)).toBe(l));
});

test('parseAnsi: the 16 colors are theme tokens (--log-0…15, spec themes); 256-color and truecolor stay as sent', () => {
  expect(parseAnsi('\x1b[30ma\x1b[37mb\x1b[90mc\x1b[97md\x1b[38;5;9me')).toEqual([
    { text: 'a', color: 'var(--log-0)', bold: false }, { text: 'b', color: 'var(--log-7)', bold: false },
    { text: 'c', color: 'var(--log-8)', bold: false }, { text: 'd', color: 'var(--log-15)', bold: false },
    { text: 'e', color: 'var(--log-9)', bold: false }
  ]);
});

test('parseAnsi: base colors, 256, truecolor, bold, reset; other sequences removed', () => {
  expect(parseAnsi('\x1b[31mred\x1b[0m and \x1b[1;38;2;10;20;30mrgb\x1b[39m end\x1b[K')).toEqual([
    { text: 'red', color: 'var(--log-1)', bold: false },
    { text: ' and ', color: null, bold: false },
    { text: 'rgb', color: 'rgb(10,20,30)', bold: true },
    { text: ' end', color: null, bold: true }
  ]);
  expect(stripAnsi('\x1b[2K\x1b[1Ga\x1b]0;title\x07b')).toBe('ab');
});

test('single-line JSON → key/value pairs; time extracted', () => {
  const l = parseLogLine('{"time":"2026-10-10T10:41:02.123Z","level":"info","method":"GET","status":200,"ms":38}');
  expect(l.json).toEqual([['level', 'info'], ['method', 'GET'], ['status', '200'], ['ms', '38']]);
  expect(l.time).toBe('10:41:02');
});

test('pasteText: no control characters, no escaping the bracketed paste, no Enter', () => {
  const evil = 'line \x1b[201~\rrm -rf ~\n\x1b]52;c;x\x07end\t';
  const p = pasteText(evil);
  expect(p.startsWith('\x1b[200~')).toBe(true);
  expect(p.endsWith('\x1b[201~')).toBe(true);
  const inner = p.slice('\x1b[200~'.length, -'\x1b[201~'.length);
  expect(inner).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f]/);
  // Escape sequences vanish entirely: no leftover that would close the bracketed paste.
  expect(inner).toBe('line rm -rf ~end\t');
});

test('detectPort', () => {
  expect(detectPort(['  ➜  Local:   http://localhost:8080/'])).toBe(8080);
  expect(detectPort(['Server listening on port 3000'])).toBe(3000);
  expect(detectPort(['nothing'])).toBeNull();
});

test('detectPort: the port the service listens on, not the one quoted in an error', () => {
  expect(detectPort(['Error: connect ECONNREFUSED 127.0.0.1:5432', 'Server listening on port 3999'])).toBe(3999);
  expect(detectPort(['GET http://localhost:3000/api 502 (upstream)', 'ready - started server on 0.0.0.0:8080'])).toBe(8080);
  expect(detectPort(['Error: connect ECONNREFUSED 127.0.0.1:5432'])).toBeNull();
});

test('pasteText without active bracketed paste: clean text only, still no Enter', () => {
  expect(pasteText('a\x1b[31mb\rc\n', false)).toBe('abc');
});

test('winston-style levels: the explicit level at the start of the line wins over the words', () => {
  expect(classify('info: server listening')).toBe('info');
  expect(classify('info: retry failed, will try again')).toBe('info');
  expect(classify('2026-10-10 12:00:01 error: db down')).toBe('error');
  expect(classify('warn: slow query')).toBe('warn');
  expect(classify('[ERROR] boom')).toBe('error');
  expect(classify('debug: x')).toBe('info');
});

test('pretty-printed JSON members: only a level key counts, never the words in keys or values', () => {
  expect(classify('    "error": null,')).toBe('plain');
  expect(classify('  "error": "connect ECONNREFUSED",')).toBe('plain');
  expect(classify('  "failed_jobs": 0')).toBe('plain');
  expect(classify('  "errors": [')).toBe('plain');
  expect(classify('  "last_error": {')).toBe('plain');
  expect(classify('  "level": "error",')).toBe('error');
  expect(classify('  "severity": "warning"')).toBe('warn');
  // Not a JSON member: the words still count.
  expect(classify('"payment" failed: card declined')).toBe('error');
});

test('the time is extracted only from JSON (in plain text it is already there)', () => {
  expect(parseLogLine('12:00:01 GET /api 200').time).toBeNull();
  expect(parseLogLine('{"time":"2026-10-10T12:00:01Z","msg":"x"}').time).toBe('12:00:01');
});

test("test reporters: a result line's mark wins over the words of the test's title", () => {
  // Playwright's list reporter (the site's e2e in the Background inspector): passed tests named after errors.
  expect(classify('  ✓    7 [chromium] › tests/e2e/base.spec.ts:52:1 › no page logs an error (2.1s)')).toBe('ok');
  expect(classify('  ✓  48 [chromium] › tests/e2e/demo.spec.ts:331:3 › the real demo › Redis: failed jobs; "Ask Claude Why It Failed" (1.4s)')).toBe('ok');
  expect(classify('  ✘  12 [chromium] › tests/e2e/base.spec.ts:60:1 › the footer links sit on one line (5.0s)')).toBe('error');
  expect(classify('  -   3 [chromium] › tests/e2e/base.spec.ts:70:1 › error page in Firefox')).toBe('plain');
  // Vitest, Jest, Mocha, TAP, Go, pytest.
  expect(classify(' ✓ src/shared/logline.test.ts > classify > failed jobs stay plain 3ms')).toBe('ok');
  expect(classify('   × src/shared/logline.test.ts > classify > the happy path 3ms')).toBe('error');
  expect(classify('  ↓ src/x.test.ts > retries a failed upload [skipped]')).toBe('plain');
  expect(classify(' PASS  src/errors.test.ts')).toBe('ok');
  expect(classify(' FAIL  src/happy.test.ts')).toBe('error');
  expect(classify('    ✔ reports an error to the caller')).toBe('ok');
  expect(classify('ok 3 - rejects a failed login')).toBe('ok');
  expect(classify('not ok 4 - logs in')).toBe('error');
  expect(classify('--- PASS: TestErrorPath (0.00s)')).toBe('ok');
  expect(classify('--- FAIL: TestHappyPath (0.01s)')).toBe('error');
  expect(classify('tests/test_api.py::test_error_handling PASSED                     [ 50%]')).toBe('ok');
  expect(classify('tests/test_api.py::test_happy_path FAILED                         [100%]')).toBe('error');
  // Not a result line: the words still count.
  expect(classify('Error: expect(locator).toBeVisible() failed')).toBe('error');
  expect(classify('  1 failed')).toBe('error');
  expect(classify('okay, that failed')).toBe('error');
  // Look-alikes (review): a numbered bullet, a status code after "ok", a logger's own level, a non-test PASS.
  expect(classify('- 1 error found')).toBe('error');
  expect(classify('  - 2 failed in src/a.ts')).toBe('error');
  expect(classify('ok 200 POST /api failed: ECONNREFUSED')).toBe('error');
  expect(classify('ERROR: deploy check PASSED')).toBe('error');
  expect(classify('PASS rate dropped, 3 jobs failed')).toBe('error');
  expect(classify('  -   3 tests/e2e/base.spec.ts:70:1 › error page in Firefox')).toBe('plain');
});
