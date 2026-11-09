import { expect, test } from 'vitest';
import { Osc7Tracker, osc7Path } from './osc7';

// A terminal's current folder on Windows (OSC 7 from the PowerShell integration): parsed from the
// data main relays to windows, as the shell prints it at each prompt.

test('the URI PowerShell prints, as a canonical path', () => {
  expect(osc7Path('file:///C:/dev/p2-proj', 'win32')).toBe('C:/dev/p2-proj');
  expect(osc7Path('file:///c:/Users/me/My%20Project/%C3%A0', 'win32')).toBe('C:/Users/me/My Project/à');
  expect(osc7Path('file://PC-NAME/C:/dev', 'win32')).toBe('C:/dev');
  expect(osc7Path('file:///Users/me/x', 'posix')).toBe('/Users/me/x');
  // Not a folder Atelier can use: another scheme, a share, garbage, a relative path.
  for (const bad of ['http://x/C:/dev', 'file://server/share/x', 'file:///%E0%A4%A', 'C:/dev', 'file:///dev']) expect(osc7Path(bad, 'win32'), bad).toBe(null);
});

test('the last folder per terminal, across chunks, either terminator', () => {
  const t = new Osc7Tracker('win32');
  t.feed('a', 'PS> cd x\r\n\x1b]7;file:///C:/de');
  expect(t.cwdOf('a')).toBe(null);
  t.feed('a', 'v/x\x07\x1b]133;A;n\x07PS C:\\dev\\x> ');
  expect(t.cwdOf('a')).toBe('C:/dev/x');
  t.feed('a', '\x1b]7;file:///D:/w\x1b\\');
  expect(t.cwdOf('a')).toBe('D:/w');
  expect(t.cwdOf('b')).toBe(null);
  t.forget('a');
  expect(t.cwdOf('a')).toBe(null);
});

test('an unfinished sequence never grows without bound', () => {
  const t = new Osc7Tracker('win32');
  t.feed('a', '\x1b]7;file:///C:/' + 'x'.repeat(100_000));
  t.feed('a', '\x07');
  expect(t.cwdOf('a')).toBe(null);
  t.feed('a', '\x1b]7;file:///C:/ok\x07');
  expect(t.cwdOf('a')).toBe('C:/ok');
});
