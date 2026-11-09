import { describe, expect, test } from 'vitest';
import { parseAnswer, type AnswerBlock, type Inline } from '../../shared/companion/answer';
import { parseCatchUp } from '../../shared/companion/catchup';
import type { CatchUp } from '../../shared/companion/types';
import { suggestionsFrom, whyQuestion } from '../../renderer/companion/suggest';
import { t } from '../../renderer/i18n/en';
import { clockTime } from '../../renderer/work-view';
import { compileWorld } from '../compile/index';
import type { BeatStep } from './beats-types';
import { applyWrite } from './beats';
import { ASK_SCRIPT, type AskAnswer, type AskPhase } from '../world/ask';
import type { ScenarioName } from '../world/scenarios';
import { answerFor, catchUpFor, phaseFor, questionKey, type AskFacts } from './ask';

// Ask's script in the live demo: what a session's Catch me up and answers say,
// from where it is now. The data is checked against the app's own grammar and validators, the chips the renderer builds
// from it, and the fictional project's files.

const compiled = compileWorld();
const NOW = compiled.t0;
const root = compiled.project.root;
const sessionOf = (name: ScenarioName) => compiled.sessions.find((s) => s.scenario === name)!.terminal.session!;

function facts(name: ScenarioName | null, o: Partial<AskFacts> = {}): AskFacts {
  const s = name ? sessionOf(name) : null;
  return { scenario: name, state: s?.state ?? 'idle', activity: s?.activity ?? null, files: compiled.files, prompts: [], scripted: null, lastMessageAt: s?.lastMessageAt ?? null, now: NOW, ...o };
}
/** How the session's scripted turn ended, as the engine records it: finished or interrupted, and what it had printed. */
const ended = (output: string, interrupted = false): AskFacts['scripted'] => ({ interrupted, output });
// Lines the beats print (engine/claude.ts records the transcript, styles dropped).
const AUTH_FIRST_RUN = 'Tests  1 failed | 6 passed (7)';
const AUTH_PASSED = `${AUTH_FIRST_RUN}\nTests  7 passed (7)`;
const DB_ANSWERED = '> paid\nExisting orders become paid';
const DB_APPLIED = `${DB_ANSWERED}\nYour database is now in sync with your schema.`;
const edited = (rel: string, from: string, to: string) => {
  const text = compiled.files[rel]!;
  expect(text, rel).toContain(from);
  return { ...compiled.files, [rel]: text.replace(from, to) };
};
const AUTH_FIXED = edited('src/auth/session.ts', 'entry.expiresAt - SKEW_MS < now', 'entry.expiresAt + SKEW_MS < now');
const SCHEMA_DONE = edited('prisma/schema.prisma', '  total     Decimal\n}\n', '  total     Decimal\n  status    OrderStatus @default(pending)\n}\n\nenum OrderStatus {\n  pending\n  paid\n  shipped\n}\n');
const INVOICE_FIXED = edited('src/billing/invoice.ts', 'Math.round(net * (1 + taxRate) * 100) / 100', 'Math.round((net * (1 + taxRate) + Number.EPSILON) * 100) / 100');

/** Every phase of every scripted session, with facts that put the session there (from the compiled world's own states). */
const CASES: { name: ScenarioName; phase: string; f: AskFacts }[] = [
  { name: 'auth-refactor', phase: 'waiting', f: facts('auth-refactor') },
  { name: 'auth-refactor', phase: 'working', f: facts('auth-refactor', { state: 'running', activity: 'Bash npm test -- auth' }) },
  // Its turn finished, or Esc once "7 passed" was on screen: the second run passed.
  { name: 'auth-refactor', phase: 'fixed', f: facts('auth-refactor', { state: 'done', activity: null, files: AUTH_FIXED, scripted: ended(AUTH_PASSED) }) },
  // Esc during the second test run, before its result: the fix is written, the run didn't report.
  { name: 'auth-refactor', phase: 'interrupted', f: facts('auth-refactor', { state: 'idle', activity: null, files: AUTH_FIXED, scripted: ended(AUTH_FIRST_RUN, true) }) },
  // Esc after the first run's failure, before the fix.
  { name: 'auth-refactor', phase: 'first-run', f: facts('auth-refactor', { state: 'idle', activity: null, scripted: ended(AUTH_FIRST_RUN, true) }) },
  // Esc during the first run, before its result.
  { name: 'auth-refactor', phase: 'cut', f: facts('auth-refactor', { state: 'idle', activity: null, scripted: ended('Bash(npm test -- auth)', true) }) },
  // Declined (3 or Esc on its menu): its turn finished without a run.
  { name: 'auth-refactor', phase: 'stopped', f: facts('auth-refactor', { state: 'done', activity: null, scripted: ended("OK, I won't run it.") }) },
  { name: 'db-migration', phase: 'waiting', f: facts('db-migration') },
  { name: 'db-migration', phase: 'working', f: facts('db-migration', { state: 'running', activity: null }) },
  // Its turn finished, or Esc once "in sync" was on screen: the migration applied.
  { name: 'db-migration', phase: 'done', f: facts('db-migration', { state: 'done', activity: null, files: SCHEMA_DONE, scripted: ended(DB_APPLIED) }) },
  // Esc between the schema edit and the migration's report: the schema changed, the migration's outcome unknown.
  { name: 'db-migration', phase: 'interrupted', f: facts('db-migration', { state: 'idle', activity: null, files: SCHEMA_DONE, scripted: ended(DB_ANSWERED, true) }) },
  // Answered (1), then Esc before any change.
  { name: 'db-migration', phase: 'answered', f: facts('db-migration', { state: 'idle', activity: null, scripted: ended(DB_ANSWERED, true) }) },
  // Esc on its question: it left the column out.
  { name: 'db-migration', phase: 'skipped', f: facts('db-migration', { state: 'done', activity: null, scripted: ended("OK, I'll leave the column out for now.") }) },
  { name: 'billing-tests', phase: 'working', f: facts('billing-tests') },
  { name: 'billing-tests', phase: 'fixing', f: facts('billing-tests', { files: INVOICE_FIXED }) },
  { name: 'billing-tests', phase: 'done', f: facts('billing-tests', { state: 'done', activity: null, files: INVOICE_FIXED }) },
  // Its turn over before the fix (its Claude gone from the terminal, or stopped): nothing was fixed.
  { name: 'billing-tests', phase: 'interrupted', f: facts('billing-tests', { state: 'idle', activity: null }) },
  { name: 'onboarding-copy', phase: 'done', f: facts('onboarding-copy') },
  { name: 'docs', phase: 'working', f: facts('docs') },
  { name: 'docs', phase: 'stopped', f: facts('docs', { state: 'idle', activity: null, scripted: ended('Read(src/auth/session.ts)', true) }) }
];

// --- the project's files, as they are at startup or after any of the beats' writes ---------------------------------

/** Every text a file can have in the demo: at startup, and after each write a beat makes to it (in order, per segment). */
function textsOf(rel: string): string[] {
  const out = compiled.files[rel] !== undefined ? [compiled.files[rel]!] : [];
  for (const beat of Object.values(compiled.beats.beats)) {
    for (const steps of Object.values(beat.segments)) {
      let text: string | undefined = compiled.files[rel];
      for (const s of steps as BeatStep[]) {
        if (s.k !== 'write' || s.write.file !== rel) continue;
        const next = applyWrite(text, s.write, { answer: 'paid if shipped', prompt: 'x' });
        if (next !== null) { text = next; out.push(next); }
      }
    }
  }
  return out;
}

function fileRefs(blocks: readonly AnswerBlock[], out: Extract<Inline, { t: 'file' }>[] = []) {
  const take = (inline: readonly Inline[]) => { for (const i of inline) if (i.t === 'file') out.push(i); };
  for (const b of blocks) {
    if (b.k === 'para') take(b.inline);
    else if (b.k === 'list') b.items.forEach(take);
    else if (b.k === 'detail') fileRefs(b.body, out);
  }
  return out;
}

const extOf = (p: string) => /\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '';
/** Extensions the project's files have: `Math.round` or `order.status` are code, not files (the panel keeps them as code). */
const EXTS = new Set(Object.keys(compiled.files).map(extOf));

/** Each file an answer (or a card's text) names exists in the demo project, and its lines are inside the file. */
function expectRealRefs(md: string, where: string) {
  for (const ref of fileRefs(parseAnswer(md)).filter((r) => r.path.includes('/') || EXTS.has(extOf(r.path)))) {
    const texts = textsOf(ref.path);
    expect(texts.length, `${where}: ${ref.raw} names a file of the demo project`).toBeGreaterThan(0);
    const last = ref.to ?? ref.from;
    if (last !== null) expect(Math.max(...texts.map((x) => x.split('\n').length - 1)), `${where}: ${ref.raw} is inside the file`).toBeGreaterThanOrEqual(last);
  }
}

function expectAnswer(a: AskAnswer, where: string, o: { verdict?: boolean } = {}) {
  const blocks = parseAnswer(a.md);
  expect(blocks.length, where).toBeGreaterThan(0);
  if (o.verdict) expect(blocks[0], `${where}: starts with its verdict`).toMatchObject({ k: 'verdict' });
  // A directive that didn't parse would show as text.
  expect(JSON.stringify(blocks), `${where}: no stray directive`).not.toMatch(/:::|Verdict:/);
  expectRealRefs(a.md, where);
  for (const r of a.read ?? []) expect(textsOf(r).length, `${where}: read ${r}`).toBeGreaterThan(0);
}

const STARTERS = t.companion.starters;

describe('the script: every session, every phase', () => {
  test('every phase of every session has a case here (a new phase needs one)', () => {
    const all = Object.entries(ASK_SCRIPT.sessions).flatMap(([name, s]) => s.phases.map((p: AskPhase) => `${name}/${p.id}`));
    expect(CASES.map((c) => `${c.name}/${c.phase}`).sort()).toEqual(all.sort());
    expect(Object.keys(ASK_SCRIPT.sessions).sort()).toEqual(compiled.sessions.map((s) => s.scenario).sort());
  });

  test.each(CASES.map((c) => [`${c.name}/${c.phase}`, c] as const))('%s: the phase the session is in', (_k, c) => {
    expect(phaseFor(ASK_SCRIPT.sessions[c.name], c.f).id).toBe(c.phase);
  });

  test.each(CASES.map((c) => [`${c.name}/${c.phase}`, c] as const))('%s: its Catch me up passes the app\'s validator, final or not', (_k, c) => {
    for (const final of [false, true]) {
      const { data, read } = catchUpFor(ASK_SCRIPT, c.f, final);
      expect(parseCatchUp(data)).toEqual(data);
      expect(data.points.length).toBeGreaterThan(0);
      expect(data.choices.length).toBeGreaterThan(0);
      if (!final) expect(data.leftOpen).toBeNull();
      for (const r of read) expect(textsOf(r).length, `read ${r}`).toBeGreaterThan(0);
      // Its texts' file references are real too (the card draws them as chips).
      expectRealRefs([data.where, data.leftOpen ?? '', ...data.points.map((p) => p.note ?? ''), ...data.choices].join('\n\n'), `${c.name}/${c.phase}`);
    }
  });

  test.each(CASES.map((c) => [`${c.name}/${c.phase}`, c] as const))('%s: every chip and Why? has its scripted answer, in the grammar', (_k, c) => {
    const { data } = catchUpFor(ASK_SCRIPT, c.f, false);
    const asked = [...suggestionsFrom(data), ...data.choices.map(whyQuestion), ...STARTERS];
    // "What's left?", a Why? and a code question: three chips after every Catch me up.
    expect(suggestionsFrom(data)).toHaveLength(3);
    for (const q of asked) {
      const a = answerFor(ASK_SCRIPT, c.f, q);
      expect(a.md, `${c.name}/${c.phase}: "${q}"`).not.toBe(ASK_SCRIPT.fallback.md);
      expectAnswer(a, `${c.name}/${c.phase}: "${q}"`, { verdict: q === t.companion.whatsLeft || q === STARTERS[0] || q === STARTERS[1] });
    }
  });

  test.each(CASES.map((c) => [`${c.name}/${c.phase}`, c] as const))('%s: Help me decide answers what it asks while it waits, else says nothing is asked', (_k, c) => {
    const a = answerFor(ASK_SCRIPT, c.f, t.companion.helpDecideQuestion(c.name));
    if (c.f.state === 'waiting') {
      expect(a.md).not.toBe(ASK_SCRIPT.notAsking.md);
      expectAnswer(a, `${c.name}/${c.phase}: decide`);
    } else expect(a.md).toBe(ASK_SCRIPT.notAsking.md);
  });

  test('every answer the script holds parses, with real file references', () => {
    for (const [name, s] of Object.entries(ASK_SCRIPT.sessions)) {
      for (const [q, a] of Object.entries(s.answers)) expectAnswer(a, `${name}: "${q}"`);
      for (const p of s.phases) {
        for (const key of ['status', 'doing', 'plan', 'decide'] as const) if (p[key]) expectAnswer(p[key]!, `${name}/${p.id}.${key}`, { verdict: key === 'status' || key === 'doing' });
        for (const [q, a] of Object.entries(p.answers ?? {})) expectAnswer(a, `${name}/${p.id}: "${q}"`);
      }
    }
    for (const a of [ASK_SCRIPT.fallback, ASK_SCRIPT.notAsking, ASK_SCRIPT.nothingAsked.status, ASK_SCRIPT.visitor.plan, ASK_SCRIPT.visitor.decide]) expectAnswer(a, 'shared');
    for (const [k, a] of Object.entries(ASK_SCRIPT.visitor.status)) expectAnswer({ md: a.md.replace('{prompt}', 'add dark mode').replace('{wait}', 'Edit tokens.ts') }, `visitor.${k}`, { verdict: true });
  });

  test('no line of the script ties Ask to one platform: it runs on macOS and Windows', () => {
    expect(JSON.stringify(ASK_SCRIPT)).not.toMatch(/\b(mac|macos|windows|your pc)\b/i);
  });
});

describe('a Catch me up', () => {
  test("its trace reads the chat and Atelier's facts, then each file it read; done points carry the time the session's turn ended", () => {
    const f = facts('onboarding-copy');
    const { data, read, trace } = catchUpFor(ASK_SCRIPT, f, false);
    expect(trace).toEqual(['Read the chat', 'Read the session facts', ...read.map((r) => `Read ${r}`)]);
    expect(read).toEqual(['src/pages/welcome.tsx']);
    expect(data.points[0]).toMatchObject({ n: 1, status: 'done', at: clockTime(f.lastMessageAt!) });
  });

  test('auth-refactor while it waits: the request done, its check waiting on the test run; final adds what it left open', () => {
    const c = catchUpFor(ASK_SCRIPT, facts('auth-refactor'), false).data;
    expect(c.points.map((p) => p.status)).toEqual(['done', 'in_progress']);
    expect(c.points[1]!.note).toContain('npm test -- auth');
    expect(suggestionsFrom(c)).toEqual(["What's left?", 'Why 30 s of clock skew when a session expires?', 'How does readSession work?']);
    expect(catchUpFor(ASK_SCRIPT, facts('auth-refactor'), true).data.leftOpen).toMatch(/untested/);
  });

  test('a session the visitor prompted: its scripted points as they ended, then each prompt, the latest by the state it is in', () => {
    const prompts = [{ text: 'add dark mode', at: NOW + 1000 }, { text: 'and a footer', at: NOW + 60_000 }];
    const waiting = catchUpFor(ASK_SCRIPT, facts('onboarding-copy', { prompts, state: 'waiting', activity: 'waiting: Edit tokens.ts' }), false).data;
    expect(waiting.points.map((p) => [p.n, p.text, p.status])).toEqual([[1, 'Make the welcome page friendlier', 'done'], [2, 'add dark mode', 'done'], [3, 'and a footer', 'in_progress']]);
    expect(waiting.points[2]!.note).toBe('Waiting for you: Edit tokens.ts');
    expect(waiting.where).toBe(ASK_SCRIPT.visitor.where.waiting.replace('{wait}', 'Edit tokens.ts'));
    const done = catchUpFor(ASK_SCRIPT, facts('onboarding-copy', { prompts, state: 'done', activity: null, lastMessageAt: NOW + 90_000 }), false).data;
    expect(done.points.at(-1)).toMatchObject({ status: 'done', at: clockTime(NOW + 90_000) });
    expect(parseCatchUp(done)).toEqual(done);
    // auth-refactor declined, then prompted: its scripted phase is taken as the turn left it (stopped), not "waiting".
    const auth = catchUpFor(ASK_SCRIPT, facts('auth-refactor', { prompts: [prompts[0]!], state: 'running', activity: null }), false).data;
    expect(auth.points.map((p) => p.status)).toEqual(['done', 'not_started', 'in_progress']);
  });

  // A turn that ended without the work (Esc, its Claude gone) is never summarized as done.
  test('a turn interrupted before the work: no point claims it, the status is not "done", the card says it stopped', () => {
    for (const [name, f] of [
      ['billing-tests', facts('billing-tests', { state: 'idle', activity: null })],
      ['billing-tests', facts('billing-tests', { state: null, activity: null })],
      ['docs', facts('docs', { state: 'idle', activity: null, scripted: ended('Read(src/auth/session.ts)', true) })],
      ['auth-refactor', facts('auth-refactor', { state: 'idle', activity: null, files: AUTH_FIXED, scripted: ended(AUTH_FIRST_RUN, true) })],
      ['auth-refactor', facts('auth-refactor', { state: 'idle', activity: null, scripted: ended(AUTH_FIRST_RUN, true) })],
      ['db-migration', facts('db-migration', { state: 'idle', activity: null, files: SCHEMA_DONE, scripted: ended(DB_ANSWERED, true) })],
      ['db-migration', facts('db-migration', { state: 'idle', activity: null, scripted: ended(DB_ANSWERED, true) })]
    ] as const) {
      const c = catchUpFor(ASK_SCRIPT, f, false).data;
      expect(c.points.every((p) => p.status !== 'done' || !/rounding|checkout|auth tests|status column/i.test(p.text)), `${name}: ${JSON.stringify(c.points)}`).toBe(true);
      expect(c.where, name).not.toMatch(/^Done|all 7 auth tests pass|is applied|Now it reads/);
      expect(answerFor(ASK_SCRIPT, f, "What's left?").md, name).not.toMatch(/^Verdict: done/);
      expect(answerFor(ASK_SCRIPT, f, 'What is it doing?').md, name).not.toMatch(/^Verdict: in-progress — (Reading|Exploring)/);
    }
  });

  // Esc on the visitor's own prompt is "Stopped", never "done".
  test("a visitor's prompt interrupted with Esc: its point is Stopped (unclear), the card and the status say so", () => {
    const prompts = [{ text: 'add dark mode', at: NOW, outcome: 'finished' as const }, { text: 'tidy up the footer', at: NOW + 60_000, outcome: 'interrupted' as const }];
    const f = facts('onboarding-copy', { prompts, state: 'idle', activity: null });
    const c = catchUpFor(ASK_SCRIPT, f, false).data;
    expect(c.points.map((p) => [p.text, p.status, p.note])).toEqual([
      ['Make the welcome page friendlier', 'done', 'A warmer greeting, and a link back to the cart'],
      ['add dark mode', 'done', null],
      ['tidy up the footer', 'unclear', 'Stopped: you interrupted it']
    ]);
    expect(c.where).toBe(ASK_SCRIPT.visitor.where.stopped);
    expect(c.where).toMatch(/^Stopped: /);
    for (const q of ["What's left?", 'What is it doing?', 'How far along is it?']) {
      const md = answerFor(ASK_SCRIPT, f, q).md;
      expect(md, q).toMatch(/^Verdict: unclear — Stopped/);
      expect(md, q).toContain('Stopped: “tidy up the footer”');
    }
  });

  // The scripted turn keeps the phase it really ended in, whatever the visitor typed after (or /clear).
  test('auth and db interrupted, then prompted: their scripted points stay as the interrupt left them', () => {
    const go = [{ text: 'go on', at: NOW + 1000 }];
    const auth = facts('auth-refactor', { state: 'running', activity: null, files: AUTH_FIXED, scripted: ended(AUTH_FIRST_RUN, true), prompts: go });
    expect(phaseFor(ASK_SCRIPT.sessions['auth-refactor'], auth).id).toBe('interrupted');
    expect(catchUpFor(ASK_SCRIPT, auth, false).data.points.map((p) => p.status)).toEqual(['done', 'unclear', 'in_progress']);
    const db = facts('db-migration', { state: 'running', activity: null, files: SCHEMA_DONE, scripted: ended(DB_ANSWERED, true), prompts: go });
    expect(phaseFor(ASK_SCRIPT.sessions['db-migration'], db).id).toBe('interrupted');
    expect(catchUpFor(ASK_SCRIPT, db, false).data.points.map((p) => p.status)).toEqual(['unclear', 'in_progress']);
    // A turn that finished stays finished when prompted.
    expect(phaseFor(ASK_SCRIPT.sessions['auth-refactor'], { ...auth, scripted: ended(AUTH_PASSED) }).id).toBe('fixed');
  });

  // The interrupted phases say what the facts show, and hedge what they can't.
  test("interrupted phases claim only what the terminal shows: db's migration hedged, auth's first run told as it was", () => {
    const db = catchUpFor(ASK_SCRIPT, CASES.find((c) => c.name === 'db-migration' && c.phase === 'interrupted')!.f, false).data;
    expect(db.where).toMatch(/migrate status/);
    expect(db.where).not.toMatch(/never|not applied|not migrated/i);
    const answered = catchUpFor(ASK_SCRIPT, CASES.find((c) => c.name === 'db-migration' && c.phase === 'answered')!.f, false).data;
    expect(answered.where).toMatch(/answered its question/);
    expect(JSON.stringify(answered)).not.toMatch(/unanswered|skipped/i);
    const first = CASES.find((c) => c.name === 'auth-refactor' && c.phase === 'first-run')!.f;
    expect(catchUpFor(ASK_SCRIPT, first, false).data.where).toMatch(/1 of 7/);
    expect(answerFor(ASK_SCRIPT, first, "What's left?").md).not.toMatch(/not tested|untested|Not tested/i);
  });

  test('a new session: "Nothing asked yet", as the app says; once prompted, its prompts only', () => {
    const none = catchUpFor(ASK_SCRIPT, facts(null), false);
    expect(none.data).toEqual({ points: [], where: 'Nothing asked yet', choices: [], leftOpen: null });
    expect(parseCatchUp(none.data)).toEqual(none.data);
    const one = catchUpFor(ASK_SCRIPT, facts(null, { prompts: [{ text: 'write a changelog', at: NOW }], state: 'running' }), false).data;
    expect(one.points).toEqual([{ n: 1, text: 'write a changelog', status: 'in_progress', at: null, note: null }]);
    expect(one.where).toBe(ASK_SCRIPT.visitor.where.working);
  });

  test('points never pass the limits (12 points, 80 characters), whatever the visitor typed', () => {
    const prompts = Array.from({ length: 20 }, (_, i) => ({ text: `${'long prompt '.repeat(12)}${i}`, at: NOW + i }));
    const c: CatchUp = catchUpFor(ASK_SCRIPT, facts('docs', { prompts, state: 'done' }), true).data;
    expect(parseCatchUp(c)).toEqual(c);
    expect(c.points).toHaveLength(12);
    expect(c.points.at(-1)!.text).toMatch(/19$|…$/);
  });
});

describe('answers', () => {
  test('matched as the panel asks them: case, spacing, curly quotes and the final mark do not count', () => {
    expect(questionKey("  What’s   LEFT ")).toBe(questionKey("What's left?"));
    const f = facts('docs');
    expect(answerFor(ASK_SCRIPT, f, 'what’s left').md).toBe(answerFor(ASK_SCRIPT, f, "What's left?").md);
  });

  test('anything else: its honesty line', () => {
    const a = answerFor(ASK_SCRIPT, facts('docs'), 'Is the checkout secure?');
    expect(a.md).toBe(ASK_SCRIPT.fallback.md);
    expect(a.md).toContain("In this demo Ask answers from a script; in Atelier it reads the session's chat and code, read-only.");
    expect(a.trace).toEqual(['Read the chat']);
  });

  test('a status answer for a prompt the visitor typed fills in the prompt and what it waits for', () => {
    const f = facts('onboarding-copy', { prompts: [{ text: 'add dark mode', at: NOW }], state: 'waiting', activity: 'waiting: Edit tokens.ts' });
    const a = answerFor(ASK_SCRIPT, f, "What's left?");
    expect(a.md).toContain('add dark mode');
    expect(a.md).toContain('Edit tokens.ts');
    expect(a.md).not.toMatch(/\{prompt\}|\{wait\}/);
    expect(answerFor(ASK_SCRIPT, f, t.companion.helpDecideQuestion('onboarding-copy')).md).toBe(ASK_SCRIPT.visitor.decide.md);
    // Waiting on something atelierd doesn't name: no empty parentheses, a plain note.
    const plain = facts('onboarding-copy', { prompts: [{ text: 'add dark mode', at: NOW }], state: 'waiting', activity: 'waiting: question' });
    expect(answerFor(ASK_SCRIPT, plain, "What's left?").md).not.toMatch(/\(\s*\)|\{wait\}|an answer\)/);
    const c = catchUpFor(ASK_SCRIPT, plain, false).data;
    expect(c.where).toBe('It is on your latest prompt, and waits for your answer in its terminal.');
    expect(c.points.at(-1)!.note).toBe('Waiting for your answer');
  });

  // The visitor's text is data, never a replacement pattern ($&, $$, $', $`).
  test('a prompt holding $-patterns comes back verbatim, in the answer and the card', () => {
    const prompt = "fix the $& bug, pay $$5 and $' then $`";
    const f = facts('onboarding-copy', { prompts: [{ text: prompt, at: NOW }], state: 'running', activity: null });
    expect(answerFor(ASK_SCRIPT, f, "What's left?").md).toContain(`“${prompt}”`);
    const waiting = facts('onboarding-copy', { prompts: [{ text: prompt, at: NOW }], state: 'waiting', activity: 'waiting: Edit $&.ts' });
    expect(answerFor(ASK_SCRIPT, waiting, "What's left?").md).toContain('(Edit $&.ts)');
    expect(catchUpFor(ASK_SCRIPT, waiting, false).data.where).toContain('(Edit $&.ts)');
  });

  test("the trace: the chat, the code searched, the files read, in that order; what it read is the answer's read list", () => {
    const a = answerFor(ASK_SCRIPT, facts('auth-refactor'), 'How does readSession work?');
    expect(a.trace[0]).toBe('Read the chat');
    expect(a.trace.slice(1)).toEqual([...(a.search ?? []).map((s) => `Searched the code for '${s}'`), ...a.read.map((r) => `Read ${r}`)]);
    expect(a.read).toContain('src/auth/session.ts');
    expect(a.md).toContain(`\`${'src/auth/session.ts'}:`);
    expect(root).toBe(compiled.project.root);
  });
});
