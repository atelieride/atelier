import { describe, expect, test } from 'vitest';
import { CO_AUTHOR_TRAILER, MESSAGE_MAX_BYTES, branchClash, hasClaudeCoAuthor, looksSecret, stageOf, trackedCounts, upstreamKind } from './git-write';

describe('stageOf', () => {
  test.each([
    ['M.', 'all'], ['A.', 'all'], ['D.', 'all'], ['R.', 'all'],
    ['.M', 'none'], ['.D', 'none'], ['..', 'none'],
    ['MM', 'partial'], ['AM', 'partial'], ['RM', 'partial'], ['AD', 'partial']
  ] as const)('%s → %s', (xy, stage) => {
    expect(stageOf(xy)).toBe(stage);
  });
  test('a malformed XY is not staged', () => {
    expect(stageOf('')).toBe('none');
  });
});

describe('hasClaudeCoAuthor', () => {
  test('the trailer Atelier adds names Claude', () => {
    expect(hasClaudeCoAuthor(`Fix the parser\n\n${CO_AUTHOR_TRAILER}`)).toBe(true);
  });
  test('the key in another case, another Claude model, among other trailers, trailing blank lines', () => {
    expect(hasClaudeCoAuthor('Fix it\n\nBody line.\n\nSigned-off-by: Ann <a@x.test>\nco-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\n\n')).toBe(true);
    expect(hasClaudeCoAuthor('Fix it\n\nCO-AUTHORED-BY: claude <noreply@anthropic.com>')).toBe(true);
  });
  test('a Co-Authored-By naming someone else is not Claude', () => {
    expect(hasClaudeCoAuthor('Fix it\n\nCo-Authored-By: Ann Smith <ann@x.test>')).toBe(false);
    expect(hasClaudeCoAuthor('Fix it\n\nCo-Authored-By: Claudette Roy <c@x.test>')).toBe(false);
  });
  test('a mention in the body or the subject is not a trailer', () => {
    expect(hasClaudeCoAuthor('Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com> was missing,\nso this adds it back.')).toBe(false);
    expect(hasClaudeCoAuthor('Co-Authored-By: Claude <noreply@anthropic.com>')).toBe(false);
    expect(hasClaudeCoAuthor('Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nA closing paragraph.')).toBe(false);
    expect(hasClaudeCoAuthor('Ask Claude to co-author this')).toBe(false);
    expect(hasClaudeCoAuthor('')).toBe(false);
  });
});

describe('looksSecret', () => {
  test.each(['.env', '.env.local', 'apps/web/.env.production', 'config/prod.pem', 'certs/server.key', 'id_rsa', '.ssh/id_rsa.pub',
    'build/cert.p12', 'credentials.json', 'aws/credentials', 'CONFIG/PROD.PEM'])('%s looks secret', (rel) => {
    expect(looksSecret(rel)).toBe(true);
  });
  test.each(['environment.ts', 'src/env.ts', 'keyboard.ts', 'src/key.ts', 'docs/keys.md', 'my-credentials.md', 'pem.ts', 'config/.envoy/x.ts'])('%s does not', (rel) => {
    expect(looksSecret(rel)).toBe(false);
  });
});

test('the commit message cap is 64 KB', () => {
  expect(MESSAGE_MAX_BYTES).toBe(65536);
});

test('branchClash: a branch that is the new name’s folder, or lives in it (git refs can’t be both)', () => {
  expect(branchClash(['main', 'feat/x'], 'feat/x/y')).toBe('feat/x');
  expect(branchClash(['main', 'feat/x'], 'feat')).toBe('feat/x');
  expect(branchClash(['main', 'feat/x'], 'feature')).toBeNull();
  expect(branchClash(['main', 'feat/x'], 'feat/y')).toBeNull();
  // A rename into its own folder: the old name goes away first.
  expect(branchClash(['feat'], 'feat/x', 'feat')).toBeNull();
});

describe('upstreamKind: how a branch stands with its upstream for a plain push or sync', () => {
  test('none, gone, a branch of another name, or its own', () => {
    expect(upstreamKind('feat/x', null, false)).toBe('none');
    expect(upstreamKind('feat/x', undefined, false)).toBe('none');
    expect(upstreamKind('feat/x', 'origin/feat/x', true)).toBe('gone');
    expect(upstreamKind('feat/x', 'origin/feat/x', false)).toBe('own');
    expect(upstreamKind('main', 'fork/main', false)).toBe('own');
    // Made from origin/main (branch.autoSetupMerge): Push and Sync would aim at main.
    expect(upstreamKind('feat/x', 'origin/main', false)).toBe('other');
    // The remote is the first segment (Atelier pushes only to remotes without a slash): origin's feat/x is not x.
    expect(upstreamKind('x', 'origin/feat/x', false)).toBe('other');
    // A local branch as upstream (branch.<b>.remote = .).
    expect(upstreamKind('feat/x', 'main', false)).toBe('other');
    expect(upstreamKind(null, 'origin/main', false)).toBe('none');
  });

  test('trackedCounts: ahead and behind only against an upstream of its own name (never "↑209 not pushed" against main)', () => {
    expect(trackedCounts({ branch: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1 })).toEqual({ ahead: 2, behind: 1 });
    expect(trackedCounts({ branch: 'feat/x', upstream: 'origin/main', ahead: 209, behind: 3 })).toEqual({ ahead: 0, behind: 0 });
    expect(trackedCounts({ branch: 'feat/x', upstream: 'origin/feat/x', upstreamGone: true, ahead: 0, behind: 0 })).toEqual({ ahead: 0, behind: 0 });
    expect(trackedCounts({ branch: null, upstream: null, ahead: 0, behind: 0 })).toEqual({ ahead: 0, behind: 0 });
  });
});
