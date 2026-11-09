import { _electron as electron, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';

// Screenshot tour for UI review: fake project, fake Claude, no user files.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, env: gitEnv });

test('UI tour', async () => {
  const project = mkdtempSync(join(tmpdir(), 'atl-tour-'));
  const ui = join(project, 'app-ui');
  mkdirSync(join(ui, 'src', 'components'), { recursive: true });
  git(ui, 'init', '-q', '-b', 'dev');
  const appPath = join(ui, 'src', 'App.tsx');
  writeFileSync(appPath, `import { useState } from 'react';\n\nexport function App() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n}\n`);
  writeFileSync(join(ui, 'src', 'components', 'Panel.tsx'), 'export const Panel = () => null;\n');
  writeFileSync(join(ui, 'package.json'), '{ "name": "app-ui" }\n');
  writeFileSync(join(ui, 'README.md'), '# app-ui\n');
  writeFileSync(join(ui, 'styles.css'), 'body { margin: 0; }\n');
  writeFileSync(join(ui, '.env'), 'X=1\n');
  writeFileSync(join(ui, 'vite.config.ts'), 'export default {};\n');
  git(ui, 'add', '.');
  git(ui, 'commit', '-q', '-m', 'primo');
  const be = join(project, 'app-backend');
  mkdirSync(join(be, 'src'), { recursive: true });
  git(be, 'init', '-q', '-b', 'main');
  writeFileSync(join(be, 'src', 'server.ts'), 'export const port = 3000;\n');
  git(be, 'add', '.');
  git(be, 'commit', '-q', '-m', 'primo');

  const { env, home } = e2eEnv({ ATELIER_CLAUDE_BIN: resolve('tests/e2e/fake-claude.pl') });
  // A modified file and a new one, for the Changes panel.
  writeFileSync(appPath, readFileSync(appPath, 'utf8').replace('count + 1', 'count + 2') + '// tour\n');
  writeFileSync(join(be, 'src', 'routes.ts'), 'export const routes = [];\n');
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const shot = (n: string) => win.screenshot({ path: `test-results/tour-${n}.png` });
  const win = await app.firstWindow();
  try {
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.waitForTimeout(1000);
    await shot('0-vuoto');
    for (const name of ['Refactor auth', 'Fix flaky test']) {
      await win.locator('.btn-new').click();
      await win.getByRole('menuitem', { name: 'Claude Session' }).click();
      await win.getByPlaceholder('Session name (optional)').fill(name);
      await win.keyboard.press('Enter');
      await win.locator('.session-row', { hasText: name }).waitFor({ timeout: 15000 });
    }
    await win.waitForTimeout(2500);
    await shot('1-sessioni');
    await win.getByRole('button', { name: /Files/ }).click();
    await win.waitForTimeout(800);
    await shot('2-files');
    await win.locator('.tree-row', { hasText: 'app-ui' }).first().click();
    await win.locator('.tree-row', { hasText: 'src' }).first().click();
    await win.locator('.tree-row', { hasText: 'App.tsx' }).first().click();
    await win.waitForTimeout(1500);
    await shot('3-file-aperto');
    await win.locator('.file-view:visible .cm-content').click();
    await win.keyboard.press('Meta+ArrowDown');
    await win.keyboard.type('\nexport const extra = true;');
    await win.waitForTimeout(400);
    writeFileSync(appPath, '// changed by Claude\n');
    await win.locator('.conflict-band').waitFor({ timeout: 10000 });
    await shot('3a-conflitto');
    await win.locator('.tab').first().click({ button: 'right' });
    await win.waitForTimeout(300);
    await shot('3b-menu-tab');
    await win.keyboard.press('Escape');
    await win.locator('.btn-new').click();
    await win.waitForTimeout(300);
    await shot('3c-menu-new');
    await win.keyboard.press('Escape');
    await win.locator('.header .search').click();
    await win.waitForTimeout(500);
    await shot('4-palette');
    await win.keyboard.press('Escape');
    await win.getByRole('button', { name: /Services/ }).click();
    await win.waitForTimeout(800);
    await shot('5-services');
  } finally {
    await app.close();
    try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});
