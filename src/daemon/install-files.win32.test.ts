import { expect, test } from 'vitest';
import { ATELIER_BASH_SUBCOMMANDS, ATELIER_PS1, ATELIER_ZSH_SUBCOMMANDS, POWERSHELL_SUBCOMMANDS, powerShellArgs } from './install-files';

// Atelier's PowerShell and Git Bash integrations, the Windows twins of the zsh files: same `claude` rules.

test('the subcommands that get no --settings are the same list as zsh’s, in PowerShell and in Git Bash', () => {
  expect(POWERSHELL_SUBCOMMANDS).toEqual(ATELIER_ZSH_SUBCOMMANDS);
  expect(ATELIER_BASH_SUBCOMMANDS).toEqual(ATELIER_ZSH_SUBCOMMANDS);
  expect(POWERSHELL_SUBCOMMANDS).toContain('remote-control');
  for (const s of POWERSHELL_SUBCOMMANDS) expect(ATELIER_PS1).toContain(`'${s}'`);
});

test('the script reads the nonce once, emits OSC 133 and OSC 7, and never uses a backtick escape', () => {
  expect(ATELIER_PS1).toContain('ATELIER_MARK_NONCE');
  expect(ATELIER_PS1).toContain("'133;A'");
  expect(ATELIER_PS1).toContain("'133;B'");
  expect(ATELIER_PS1).toContain("'133;C'");
  expect(ATELIER_PS1).toContain("'133;D;'");
  expect(ATELIER_PS1).toContain("'7;'");
  expect(ATELIER_PS1).toContain("$global:__atelierEsc + ']' + $body + $global:__atelierBel");
  expect(ATELIER_PS1).toContain('ATELIER_INIT_CMD');
  expect(ATELIER_PS1).toContain('REAL-CLAUDE-BLOCKED');
  // Windows PowerShell 5.1 has no `e: escapes come from [char] codes.
  expect(ATELIER_PS1).not.toContain('`e');
});

test('PowerShell starts with the script dot-sourced after the user’s profile, policy bypassed for this process only', () => {
  const args = powerShellArgs('C:\\Users\\mario\\.atelier\\shell\\atelier.ps1');
  expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command']);
  expect(args.at(-1)).toMatch(/^try \{ \. 'C:\\Users\\mario\\\.atelier\\shell\\atelier\.ps1' \} catch \[System\.Management\.Automation\.PSSecurityException\] \{ /);
  // A quote in the path (a user named O'Brien) is doubled, PowerShell's single-quote escape.
  expect(powerShellArgs("C:\\Users\\o'brien\\.atelier\\shell\\atelier.ps1").at(-1)).toContain(". 'C:\\Users\\o''brien\\.atelier\\shell\\atelier.ps1'");
});

test('a Group Policy that beats -ExecutionPolicy Bypass: the terminal says why it has no states and still runs its command', () => {
  const cmd = powerShellArgs('C:\\a\\atelier.ps1').at(-1)!;
  expect(cmd).toContain('Group Policy');
  expect(cmd).toContain('ATELIER_INIT_CMD');
  expect(cmd).toContain('Invoke-Expression');
  // Windows PowerShell 5.1 mangles double quotes on its command line.
  expect(cmd).not.toContain('"');
});

test('the integration refreshes PATH from Windows’ settings and puts Atelier’s bin on it; a prompt signal for your profile', () => {
  // Git (or anything) installed after atelierd started: the registry has it, atelierd's environment doesn't.
  expect(ATELIER_PS1).toContain('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  expect(ATELIER_PS1).toContain('DoNotExpandEnvironmentNames');
  expect(ATELIER_PS1).toContain("Join-Path $env:ATELIER_HOME 'bin'");
  expect(ATELIER_PS1).toContain('ATELIER_PROMPT_NONCE');
  expect(ATELIER_PS1).toContain("'133;P'");
});

// PowerShell ends a single-quoted string on ‘ ’ ‚ ‛ too: a profile named D’Angelo (a typographic apostrophe, as Windows
// keyboards with autocorrect give it) broke the whole -Command and the terminal got no integration at all.
test('every single-quote character PowerShell knows is doubled in the script’s path', () => {
  for (const q of ["'", '‘', '’', '‚', '‛']) {
    const cmd = powerShellArgs(`C:\\Users\\D${q}Angelo\\.atelier\\shell\\atelier.ps1`).at(-1)!;
    expect(cmd, q).toContain(`. 'C:\\Users\\D${q}${q}Angelo\\.atelier\\shell\\atelier.ps1' }`);
  }
});
