// Makes node-pty's spawn-helper executable: npm installs it without the +x bit.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
