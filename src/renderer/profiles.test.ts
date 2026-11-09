import { expect, test } from 'vitest';
import { paletteProfileCommands, profileSubmenu } from './profiles';

const shells = [{ path: '/bin/bash', name: 'bash' }];

test('"+" menu: Terminal with Profile › one entry per profile, the default marked; disabled with an older atelierd', () => {
  const ran: string[] = [];
  const item = profileSubmenu(shells, true, 'user', (k) => ran.push(k));
  expect(item.label).toBe('Terminal with Profile');
  expect(item.disabled).toBeFalsy();
  const sub = item.submenu!.filter((x) => x !== 'sep');
  expect(sub.map((x) => x.label)).toEqual(['Atelier', 'zsh (your config)', 'bash']);
  expect(sub.map((x) => x.hint ?? '')).toEqual(['', 'default', '']);
  sub[2]!.run();
  expect(ran).toEqual(['/bin/bash']);
  expect(profileSubmenu(shells, false, 'atelier', () => {}).disabled).toBe(true);
});

test('palette: "New terminal: <profile>" for every profile, none with an older atelierd', () => {
  expect(paletteProfileCommands(shells, true).map((c) => [c.key, c.label])).toEqual([
    ['new-terminal-profile:atelier', 'New terminal: Atelier'],
    ['new-terminal-profile:user', 'New terminal: zsh (your config)'],
    ['new-terminal-profile:/bin/bash', 'New terminal: bash']
  ]);
  expect(paletteProfileCommands(shells, false)).toEqual([]);
});
