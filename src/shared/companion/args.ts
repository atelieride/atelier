// Ask companion: the one place that builds the `claude -p` argv.
// Read-only rests on this list (three built-in tools, restricted mode, dontAsk, secret deny rules): it is
// unit-tested exactly, and nothing else may spawn the companion.
import { isCleanAbsPath, toCanonical, toNative, trimTrailingSep } from '../paths';
import type { Platform } from '../platform';
import { UUID, type CompanionModel } from './types';

/** Ask's own list of secret file names (not `looksSecret`'s); each becomes a root-free deny rule. */
export const SECRET_PATTERNS = [
  '.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '*.p12', '*.pfx', 'credentials*', '.netrc', '.npmrc',
] as const;

/** Root-free on purpose (verified on Claude Code 2.1.316): no project path inside a gitignore-style rule to escape. */
export const DENY_RULES: readonly string[] = SECRET_PATTERNS.map((p) => `Read(//**/${p})`);

const TOOLS = 'Read,Grep,Glob';
const MODELS: readonly string[] = ['haiku', 'sonnet', 'opus'];

/**
 * The project root as `--add-dir` gets it and rules.md names it: absolute, normalized, without a trailing separator,
 * never the filesystem's root ("/" or "C:\" would expose the whole disk). macOS: a posix path. Windows:
 * a drive path, main's canonical C:/… or native, handed to Claude native
 * (C:\…, the drive upper-case: the form observed on Windows); UNC and device paths (\\server\share, \\?\…) are refused.
 */
export function companionRoot(projectRoot: string, platform: Platform): string {
  if (platform === 'win32') {
    const root = trimTrailingSep(projectRoot, 'win32');
    if (!isCleanAbsPath(root, 'win32'))
      throw new Error('companion: project root must be a normalized drive path, not a drive root, UNC or device path');
    return toNative(toCanonical(root, 'win32'), 'win32');
  }
  if (!projectRoot.startsWith('/')) throw new Error('companion: project root must be an absolute posix path');
  const root = projectRoot.replace(/\/+$/, '');
  if (root === '') throw new Error('companion: project root must not be the filesystem root');
  if (root.split('/').slice(1).some((s) => s === '' || s === '.' || s === '..'))
    throw new Error('companion: project root must be normalized');
  return root;
}

export interface CompanionArgsInput {
  model: CompanionModel;
  projectRoot: string;
  threadDir: string;
  claudeUuid: string;
  resume: boolean;
  schema?: object;
  /** Explicit: the root's and the rules file's path forms follow it (main passes currentPlatform()). */
  platform: Platform;
}

export function companionArgs(o: CompanionArgsInput): string[] {
  const root = companionRoot(o.projectRoot, o.platform);
  const rules = o.platform === 'win32' ? toNative(`${o.threadDir}\\rules.md`, 'win32') : `${o.threadDir}/rules.md`;
  if (!MODELS.includes(o.model)) throw new Error('companion: unknown model');
  // --resume takes an optional value: anything that is not a uuid could be parsed as a flag.
  if (!UUID.test(o.claudeUuid)) throw new Error('companion: claude session id must be a uuid');
  return [
    '-p', '--model', o.model,
    '--restricted', '--tools', TOOLS, '--allowedTools', TOOLS, '--permission-mode', 'dontAsk',
    '--disallowedTools', ...DENY_RULES,
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
    '--add-dir', root,
    '--append-system-prompt-file', rules,
    o.resume ? '--resume' : '--session-id', o.claudeUuid,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(o.schema ? ['--json-schema', JSON.stringify(o.schema)] : []),
  ];
}
