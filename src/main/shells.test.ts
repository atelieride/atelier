import { expect, test } from 'vitest';
import { shellOptions, windowsShellOptions } from './shells';

const etc = `# List of acceptable shells for chpass(1).
/bin/bash
/bin/csh
/bin/zsh
/bin/sh
/opt/homebrew/bin/bash
/opt/homebrew/bin/fish   # comment
/bin/gone
relative/sh
`;
const exists = new Set(['/bin/bash', '/bin/csh', '/bin/zsh', '/bin/sh', '/opt/homebrew/bin/bash', '/opt/homebrew/bin/fish']);

test('shells from /etc/shells: existing executables only, zsh left out (it is "zsh (your config)"), named by their basename', () => {
  expect(shellOptions(etc, (p) => exists.has(p))).toEqual([
    { path: '/bin/bash', name: 'bash' },
    { path: '/bin/csh', name: 'csh' },
    { path: '/bin/sh', name: 'sh' },
    // Two shells with the same name: the second one shows its folder.
    { path: '/opt/homebrew/bin/bash', name: 'bash (/opt/homebrew/bin)' },
    { path: '/opt/homebrew/bin/fish', name: 'fish' }
  ]);
});

test('Windows: the shells found, the default PowerShell left out (the built-in profiles already are it)', () => {
  const list = [
    { path: 'C:/Program Files/PowerShell/7/pwsh.exe', name: 'PowerShell 7', kind: 'powershell' as const },
    { path: 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe', name: 'Windows PowerShell', kind: 'powershell' as const },
    { path: 'C:/WINDOWS/System32/cmd.exe', name: 'Command Prompt', kind: 'cmd' as const }
  ];
  expect(windowsShellOptions(list)).toEqual([
    { path: 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe', name: 'Windows PowerShell' },
    { path: 'C:/WINDOWS/System32/cmd.exe', name: 'Command Prompt' }
  ]);
});

test('no /etc/shells or an empty one: no shells', () => {
  expect(shellOptions('', () => true)).toEqual([]);
  expect(shellOptions('/bin/bash\n/bin/bash\n', () => true)).toEqual([{ path: '/bin/bash', name: 'bash' }]);
});
