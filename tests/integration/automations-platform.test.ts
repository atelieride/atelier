// Automations on every platform: the first version refused everything on win32 (the launcher and
// the git guard were shell-level, macOS only). Windows has its own now (launch.ps1, the hooks under Git for Windows'
// sh, atelier-git.exe), so nothing in main or the view turns the feature off by platform.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '');

describe('automations on win32', () => {
  const wiring = strip(readFileSync(join(SRC, 'main', 'automations', 'wiring.ts'), 'utf8'));
  const index = strip(readFileSync(join(SRC, 'main', 'index.ts'), 'utf8'));
  const list = strip(readFileSync(join(SRC, 'renderer', 'automations', 'AutomationsList.tsx'), 'utf8'));

  test('no IPC refuses on win32: every channel is registered the same way', () => {
    expect(wiring).not.toContain('Automations are on macOS for now');
    expect(wiring).not.toMatch(/\bwrite\(IPC\./);
    const channels = [...wiring.matchAll(/\bon\(IPC\.(automations\w+)/g)].map((m) => m[1]).sort();
    expect(channels).toEqual(['automationsCatchUp', 'automationsCheckNow', 'automationsCloseRun', 'automationsList', 'automationsPreview', 'automationsRemove',
      'automationsSave', 'automationsScopes', 'automationsSetPaused', 'automationsSkipRun', 'automationsSourceMcp', 'automationsStartRun', 'automationsStopRun',
      'automationsTurnOff', 'automationsTurnOn']);
  });

  test('the runner starts on every platform; the view has no macOS-only notice', () => {
    expect(index).toMatch(/^\s*automations\.runner\.start\(\);/m);
    expect(index).not.toMatch(/currentPlatform\(\) !== 'win32'\) automations\.runner\.start/);
    expect(list).not.toContain('macOnly');
  });
});
