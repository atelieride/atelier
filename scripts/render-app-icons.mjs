// Renders the app icons the Dock gets as images:
// build/AppIcon-Docsy.icon → assets/brand/app-icon-docsy.png (Docsy's themes) and build/AppIcon.icon →
// assets/brand/app-icon-aurora.png (back to Aurora while Atelier runs), committed, so CI and other machines never
// need Icon Composer, with each source's print in app-icon-sources.json (a test catches an .icon changed without a
// render). `node scripts/render-app-icons.mjs`, by hand, after changing an .icon. Needs Xcode 26+ selected
// (xcode-select): Icon Composer's ictool draws the glass tile the way macOS draws AppIcon.icon, without the system's
// margins; sips then scales it to 824 px inside a transparent 1024 px canvas, the macOS icon grid.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ICONS, iconSourcePrint } from './render-app-icon-sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const developer = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim();
const ictool = join(developer, '..', 'Applications', 'Icon Composer.app', 'Contents', 'Executables', 'ictool');
if (!existsSync(ictool)) throw new Error(`Icon Composer's ictool not found at ${ictool}: select Xcode 26 or later with xcode-select.`);

const work = mkdtempSync(join(tmpdir(), 'atl-app-icons-'));
try {
  const prints = {};
  for (const [source, png] of APP_ICONS) {
    const tile = join(work, png);
    execFileSync(ictool, [join(ROOT, 'build', source), '--export-preview', 'macOS', 'Light', '1024', '1024', '1', tile], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (!existsSync(tile)) throw new Error(`ictool wrote no image for ${source}`);
    execFileSync('/usr/bin/sips', ['-z', '824', '824', tile], { stdio: 'ignore' });
    execFileSync('/usr/bin/sips', ['--padToHeightWidth', '1024', '1024', tile], { stdio: 'ignore' });
    const out = join(ROOT, 'assets', 'brand', png);
    renameSync(tile, out);
    prints[png] = iconSourcePrint(join(ROOT, 'build', source));
    console.log(`App icon ready: ${out}`);
  }
  writeFileSync(join(ROOT, 'assets', 'brand', 'app-icon-sources.json'), JSON.stringify(prints, null, 2) + '\n');
} finally {
  rmSync(work, { recursive: true, force: true });
}
