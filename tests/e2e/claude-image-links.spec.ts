import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { e2eEnv } from './env';
import { look } from './shots';

// Claude image links: a path Claude wrapped (here a transcript Read(…) header, cut where the row is full and
// continued after a 6-space indent, as recorded in tests/fixtures/claude-image) opens the image it names, even in
// Claude's temp folder outside the project.

const SAMPLE = resolve('tests/fixtures/claude-image/sample.png');

/** Prints `⏺ Read(<path>)` wrapped like Claude Code: full rows, continuation rows indented by 6. */
const WRAP = String.raw`
my $p = shift; my $c = (split ' ', qx(stty size </dev/tty))[1];
my $s = "\x{23FA} Read(" . $p . ")"; binmode STDOUT, ':utf8';
print substr($s, 0, $c, ''), "\n"; while (length $s) { print ' ' x 6, substr($s, 0, $c - 6, ''), "\n"; }
print "WRAPPED-DONE ", (split m{/}, $p)[-1], "\n";
`;

function longImage(root: string): string {
  // Long enough to need several rows in any window: Claude's real layout, plus deep folders.
  const dir = join(root, '-Users-me-Developer-repos-proj', '00000000-1111-4222-8333-444444444444', 'scratchpad', 'shots',
    'a-rather-long-folder-name-for-screenshots', 'another-long-folder-name-so-the-path-wraps', 'and-one-more-level-to-be-sure');
  mkdirSync(dir, { recursive: true });
  const png = join(dir, 'f24b-live-3.png');
  copyFileSync(SAMPLE, png);
  return png;
}

/** The centre of the text on the n-th rendered row after the one starting with `head`. */
async function rowPoint(win: Page, head: string, after: number) {
  return win.evaluate(({ head, after }) => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    const i = rows.findIndex((r) => (r.textContent ?? '').startsWith(head));
    const row = rows[i + after]!;
    const r = row.getBoundingClientRect();
    const text = (row.textContent ?? '').trimEnd();
    const cell = r.width / Math.max(1, (row.textContent ?? '').length);
    // Into the path part of the row (past the 6-space indent on continuation rows).
    return { x: r.left + cell * Math.min(text.length - 2, 12), y: r.top + r.height / 2 };
  }, { head, after });
}

/** Claude's temp folder, made like Claude Code makes it (private), or writable by others. */
function makeTmp(claudeTmp: string, claudeTmpPrivate = true) {
  mkdirSync(claudeTmp);
  chmodSync(claudeTmp, claudeTmpPrivate ? 0o700 : 0o777);
}

/** `tmpNow: false`: the temp folder doesn't exist when the window opens (after a reboot, before any Claude session). */
async function setup(claudeTmpPrivate = true, tmpNow = true) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cimg-')));
  const claudeTmp = join(base, 'claude-tmp');
  if (tmpNow) makeTmp(claudeTmp, claudeTmpPrivate);
  const script = join(base, 'wrap.pl');
  writeFileSync(script, WRAP);
  const { env, home } = e2eEnv({ ATELIER_TEST_CLAUDE_TMP: claudeTmp });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  return { app, win, home, base, claudeTmp, script };
}

/** Opens the first terminal and waits for its prompt (the Atelier prompt's ›), so nothing typed is lost. */
async function openTerminal(win: Page) {
  await win.getByRole('button', { name: 'Open a terminal' }).click();
  await expect(win.locator('.xterm-rows')).toContainText('›', { timeout: 10000 });
  await win.locator('.xterm-helper-textarea').focus();
}

/** Prints `png` wrapped, on a cleared screen of the terminal in front. */
async function printWrapped(win: Page, script: string, png: string) {
  await win.keyboard.type(`clear; perl ${script} ${png}\n`);
  await expect(win.locator('.xterm-rows')).toContainText(`WRAPPED-DONE ${png.split('/').at(-1)}`, { timeout: 10000 });
}

/** A ⌘-click where the pointer already is (after expectLink/expectNoLink on that point). */
async function cmdClick(win: Page, p: { x: number; y: number }) {
  await win.keyboard.down('Meta');
  await win.mouse.click(p.x, p.y);
  await win.keyboard.up('Meta');
}

/** Points at `p`; xterm puts the hand (xterm-cursor-pointer) on its screen once the link provider answered. */
async function pointAt(win: Page, p: { x: number; y: number }) {
  await win.mouse.move(p.x - 3, p.y);
  await win.mouse.move(p.x, p.y);
}
const pointer = (win: Page) => win.locator('.xterm-screen.xterm-cursor-pointer');
async function expectLink(win: Page, p: { x: number; y: number }) {
  await pointAt(win, p);
  await expect.poll(() => pointer(win).count(), { timeout: 5000 }).toBeGreaterThan(0);
}
/** No link: the provider has had time to answer (nothing marks a "no"). */
async function expectNoLink(win: Page, p: { x: number; y: number }) {
  await pointAt(win, p);
  await win.waitForTimeout(800);
  expect(await pointer(win).count()).toBe(0);
}

function stop(home: string) {
  try { process.kill((JSON.parse(readFileSync(join(home, 'atelierd.json'), 'utf8')) as { pid: number }).pid, 'SIGTERM'); } catch { /* already stopped */ }
}

test('⌘-click on the second row of a wrapped Claude temp image opens it, read-only, labelled Claude temp; a plain click on the first row too; an image no longer there gives no link', async () => {
  // The temp folder appears only once the window is up, as after a reboot.
  const { app, win, home, claudeTmp, script } = await setup(true, false);
  try {
    await win.getByRole('button', { name: 'Open a terminal' }).waitFor();
    makeTmp(claudeTmp);
    const png = longImage(claudeTmp);
    await openTerminal(win);
    await printWrapped(win, script, png);
    const head = `⏺ Read(${png.slice(0, 20)}`;
    // The block spans at least two rows; the second is a continuation.
    await expect.poll(() => win.evaluate((h) => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const i = rows.findIndex((r) => (r.textContent ?? '').startsWith(h));
      return i >= 0 && (rows[i + 1]?.textContent ?? '').startsWith('      ');
    }, head)).toBe(true);
    const p = await rowPoint(win, head, 1);
    await expectLink(win, p);
    await cmdClick(win, p);

    const view = win.locator('.image-view:visible');
    await expect(view).toBeVisible({ timeout: 10000 });
    await expect(view.locator('.crumb')).toContainText('scratchpad › shots › ');
    await expect(view.locator('.crumb b')).toHaveText('f24b-live-3.png');
    await expect(view.locator('.file-note')).toHaveText('Claude temp');
    await expect(view.locator('.file-foot')).toContainText('180 × 180 px');
    await look(win, 'test-results/claude-image-links.png');

    // With the mouse free, a plain click on the first row opens it too.
    await win.locator('.tab', { hasText: 'Terminal 1' }).click();
    await expect(view).toHaveCount(0);
    const first = await rowPoint(win, head, 0);
    await expectLink(win, first);
    await win.mouse.click(first.x, first.y);
    await expect(win.locator('.image-view:visible .crumb b')).toHaveText('f24b-live-3.png', { timeout: 10000 });

    // An image that is no longer there gives no link.
    await win.locator('.tab', { hasText: 'Terminal 1' }).click();
    await win.locator('.xterm-helper-textarea').focus();
    const gone = png.replace('f24b-live-3.png', 'gone-4.png');
    await printWrapped(win, script, gone);
    await expectNoLink(win, await rowPoint(win, `⏺ Read(${gone.slice(0, 20)}`, 1));
  } finally {
    await app.close();
    stop(home);
  }
});

/** Claude's prose naming a draft it wrote in its scratchpad, the path alone on its row with the sentence's period. */
const PROSE = String.raw`
my $p = shift; binmode STDOUT, ':utf8';
print "\x{23FA} The message for Simona is in the clipboard. It is also in\n  $p.\n\nPROSE-DONE\n";
`;

/**
 * A project and a private temp folder holding a Markdown draft, Claude's prose naming it, and an app on them. Open
 * File… picks that draft (`ATELIER_TEST_PICK_FILES`).
 */
function draftSetup() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cimg-')));
  const claudeTmp = join(base, 'claude-tmp');
  makeTmp(claudeTmp);
  const dir = join(claudeTmp, '-Users-ada-Developer-store', 'de43b06a-b603', 'scratchpad');
  mkdirSync(dir, { recursive: true });
  const md = join(dir, 'message-for-the-review.md');
  writeFileSync(md, '# Ciao Simona\n\nIl messaggio.\n');
  const script = join(base, 'prose.pl');
  writeFileSync(script, PROSE);
  const { env, home } = e2eEnv({ ATELIER_TEST_CLAUDE_TMP: claudeTmp, ATELIER_TEST_PICK_FILES: md });
  const launch = () => electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  return { md, script, home, launch };
}

/** Prints the prose naming `md` in a new terminal and ⌘-clicks the path; the draft's tab is in front. */
async function openDraftFromLink(win: Page, script: string, md: string) {
  await openTerminal(win);
  await win.keyboard.type(`clear; perl ${script} ${md}\n`);
  await expect(win.locator('.xterm-rows')).toContainText('PROSE-DONE', { timeout: 10000 });
  const p = await rowPoint(win, '⏺ The message for Simona', 1);
  await expectLink(win, p);
  await cmdClick(win, p);
  await expect(win.locator('.file-view:visible .crumb b')).toHaveText('message-for-the-review.md', { timeout: 10000 });
}

test('a Markdown draft in Claude\'s temp folder named in prose opens read-only, labelled Claude temp; Open File… on it makes it editable', async () => {
  const { md, script, home, launch } = draftSetup();
  const app = await launch();
  const win = await app.firstWindow();
  try {
    await openDraftFromLink(win, script, md);
    const view = win.locator('.file-view:visible');
    await expect(view.locator('.crumb')).toContainText('scratchpad › ');
    await expect(view.locator('.file-note.is-outside')).toHaveText('Claude temp');
    await expect(view.locator('.cm-content')).toContainText('# Ciao Simona');
    await expect(view.locator('.file-foot')).toContainText('Read-only');
    // Typing changes nothing: Atelier may read it, never write it.
    await view.locator('.cm-content').click();
    await win.keyboard.type('XYZ');
    await expect(view.locator('.cm-content')).not.toContainText('XYZ');
    await expect(view.locator('.file-foot')).toContainText('Read-only');
    expect(readFileSync(md, 'utf8')).toBe('# Ciao Simona\n\nIl messaggio.\n');
    await look(win, 'test-results/claude-temp-markdown.png', { settle: 400 });

    // Picked with Open File… (a gesture): the same tab becomes editable, and ⌘S writes it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('ev:command', 'open-file'));
    await expect(view.locator('.file-foot')).toContainText('Saved', { timeout: 10000 });
    await expect(view.locator('.file-note.is-outside')).toHaveText('Claude temp');
    await view.locator('.cm-line', { hasText: 'Il messaggio.' }).click();
    await win.keyboard.press('End');
    await win.keyboard.type(' XYZ');
    await expect(view.locator('.cm-content')).toContainText('Il messaggio. XYZ');
    await win.keyboard.press('Meta+s');
    await expect.poll(() => readFileSync(md, 'utf8')).toBe('# Ciao Simona\n\nIl messaggio. XYZ\n');
  } finally {
    await app.close();
    stop(home);
  }
});

test('a draft opened from a link and popped out stays read-only when its pop-out comes back after a relaunch', async () => {
  const { md, script, home, launch } = draftSetup();
  let app = await launch();
  const win = await app.firstWindow();
  try {
    await openDraftFromLink(win, script, md);
    await win.locator('.tab', { hasText: 'message-for-the-review.md' }).click({ button: 'right' });
    const [pop] = await Promise.all([app.waitForEvent('window'), win.getByRole('menuitem', { name: 'Move to New Window' }).click()]);
    await expect(pop.locator('.file-view .file-foot')).toContainText('Read-only', { timeout: 15000 });
    const popouts = () => { try { return (JSON.parse(readFileSync(join(home, 'ui-state.json'), 'utf8')) as { popouts?: { key: string }[] }).popouts?.map((p) => p.key) ?? []; } catch { return []; } };
    await expect.poll(popouts).toContain(`f:${md}`);
    await app.close();

    app = await launch();
    await app.firstWindow();
    let again: Page | undefined;
    await expect.poll(async () => {
      for (const p of app.windows()) if (await p.locator('.popout-bar').count().catch(() => 0)) { again = p; return true; }
      return false;
    }, { timeout: 20000 }).toBe(true);
    await expect(again!.locator('.file-view .cm-content')).toContainText('# Ciao Simona', { timeout: 15000 });
    await expect(again!.locator('.file-view .file-foot')).toContainText('Read-only');
    await expect(again!.locator('.file-view .file-note.is-outside')).toHaveText('Claude temp');
  } finally {
    await app.close();
    stop(home);
  }
});

test('a temp folder others can write to is not trusted: no link on a plain hover; a ⌘-click opens it as any outside file, not as Claude temp', async () => {
  const { app, win, home, claudeTmp, script } = await setup(false);
  try {
    const png = longImage(claudeTmp);
    await openTerminal(win);
    await printWrapped(win, script, png);
    const p = await rowPoint(win, `⏺ Read(${png.slice(0, 20)}`, 1);
    await expectNoLink(win, p);
    await cmdClick(win, p);
    await expect(win.locator('.image-view:visible .crumb b')).toHaveText('f24b-live-3.png', { timeout: 10000 });
    await expect(win.locator('.image-view:visible .file-note.is-outside')).toHaveText('Outside project');
  } finally {
    await app.close();
    stop(home);
  }
});

/**
 * Prints a message like the real one in tests/fixtures/claude-image/image-message.txt: an `[image]` row whose
 * path box leaves room for the size (`cols − 1 − size`), its continuation under the path (column 11) with the size at
 * the right, then the folder on its own row and a list of bare names.
 */
const MESSAGE = String.raw`
my ($dir, @names) = @ARGV; my $c = (split ' ', qx(stty size </dev/tty))[1]; binmode STDOUT, ':utf8';
for my $n (@names) {
  my $p = "$dir$n"; my $size = "(29.3KB)"; my $box = $c - 1 - length($size) - 11;
  print "  \x{203A} [image]", substr($p, 0, $box), "\n";
  my $rest = (" " x 11) . substr($p, $box);
  print $rest, " " x ($c - 1 - length($rest) - length($size)), $size, "\n";
}
print "\n\x{25CF} They are all in the folder:\n  $dir\n\n";
print "  - $_: a screenshot;\n" for @names;
print "MESSAGE-DONE\n";
`;

test('a real attachments message: [image] continuation, the folder, a bare name; wide characters before a path', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'notes-file.ts'), 'export {};\n');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-cimg-')));
  const claudeTmp = join(base, 'claude-tmp');
  makeTmp(claudeTmp);
  const dir = join(claudeTmp, '-Users-me-proj', '974cacb3-ed53', 'scratchpad', 'shots') + '/';
  mkdirSync(dir, { recursive: true });
  const names = ['settings-light-with-a-much-longer-name.png', 'progress-with-a-much-longer-name.png'];
  for (const n of names) copyFileSync(SAMPLE, dir + n);
  const script = join(base, 'message.pl');
  writeFileSync(script, MESSAGE);
  const urlLog = join(base, 'urls.txt');
  const { env, home } = e2eEnv({ ATELIER_TEST_CLAUDE_TMP: claudeTmp, ATELIER_TEST_URL_LOG: urlLog });
  const app = await electron.launch({ args: ['out/main/index.js', `--project=${project}`], env });
  const win = await app.firstWindow();
  try {
    await openTerminal(win);
    await win.keyboard.type(`clear; perl ${script} ${dir} ${names.join(' ')}\n`);
    await expect(win.locator('.xterm-rows')).toContainText('MESSAGE-DONE', { timeout: 10000 });
    // The [image] row isn't full: its continuation is the next row, starting at column 11.
    await expect.poll(() => win.evaluate(() => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const i = rows.findIndex((r) => (r.textContent ?? '').startsWith('  › [image]'));
      return i >= 0 && /^ {11}\S/.test(rows[i + 1]?.textContent ?? '');
    })).toBe(true);

    // 1. ⌘-click on the continuation of the second attachment.
    const p = await rowPoint(win, '  › [image]', 3);
    await expectLink(win, p);
    await cmdClick(win, p);
    await expect(win.locator('.image-view:visible .crumb b')).toHaveText(names[1]!, { timeout: 10000 });
    await expect(win.locator('.image-view:visible .file-note')).toHaveText('Claude temp');

    // 2. The bare name in the list, under the folder written above it.
    await win.locator('.tab', { hasText: 'Terminal 1' }).click();
    const bare = await rowPoint(win, `  - ${names[0]}`, 0);
    await expectLink(win, bare);
    await cmdClick(win, bare);
    await expect(win.locator('.image-view:visible .crumb b')).toHaveText(names[0]!, { timeout: 10000 });
    // Past the tab's entrance fade.
    await look(win, 'test-results/claude-image-links-message.png', { settle: 400 });

    // 3. The folder: opened in Finder (logged in tests), nothing else.
    await win.locator('.tab', { hasText: 'Terminal 1' }).click();
    const folder = await rowPoint(win, `  ${dir.slice(0, 20)}`, 0);
    await expectLink(win, folder);
    await cmdClick(win, folder);
    await expect.poll(() => { try { return readFileSync(urlLog, 'utf8'); } catch { return ''; } }).toContain(`finder:${dir.slice(0, -1)}`);

    // 4. Wide characters before a path: the link sits on the path's own cells. Six wide characters: twelve cells, six
    // code units. Counted in code units, the link would sit six cells left.
    await win.locator('.xterm-helper-textarea').focus();
    await win.keyboard.type("clear; printf '\\346\\227\\245\\346\\234\\254\\350\\252\\236\\346\\227\\245\\346\\234\\254\\350\\252\\236 src/notes-file.ts\\n'\n");
    // The printed row, not the typed command (which names the path too and is drawn first).
    await expect.poll(() => win.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')]
      .some((r) => (r.textContent ?? '').startsWith('日本語') && (r.textContent ?? '').includes('src/notes-file.ts'))), { timeout: 10000 }).toBe(true);
    // Where the last character of the path is drawn (the screen is in cells).
    const w = await win.evaluate(() => {
      const row = [...document.querySelectorAll('.xterm-rows > div')].find((r) => (r.textContent ?? '').startsWith('日本語'))!;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf('.ts');
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i + 2); range.setEnd(n, i + 3);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      throw new Error('path not drawn');
    });
    await expectLink(win, w);
    await cmdClick(win, w);
    await expect(win.locator('.file-view:visible .crumb b')).toHaveText('notes-file.ts', { timeout: 10000 });
  } finally {
    await app.close();
    stop(home);
  }
});
