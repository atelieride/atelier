import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Databases view: Atelier reads databases and never writes, and the read-only path can't be bypassed by an edit that
// looks harmless. Static guards over src/main/databases/ (statements, not words):
// 1. only postgres/client.ts imports the `pg` driver, in any form (`from`, a side-effect import, `import(…)`,
//    `require(…)`, any quote; the type shim pg-js-client.d.ts names it, as a type);
// 2. `.run(` on a session is called only by the query modules, and only with a Stmt from a builder or an object literal
//    with `text:` (never a bare string or an unknown variable);
// 3. no SQL statement that changes session or server state in a string literal (the literals inside a template's `${…}`
//    included): SET in any form (`= / TO`, SESSION, LOCAL, ROLE, TIME ZONE, TRANSACTION, NAMES, SCHEMA…), every RESET,
//    DISCARD, set_config, COPY, LISTEN, EXPLAIN ANALYZE, ANALYZE. The one exception is the client's wrapper, exactly `BEGIN
//    TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}; SET LOCAL synchronize_seqscans =
//    off; SET LOCAL max_parallel_workers_per_gather = 0` (every SET local to the transaction).
//    readOnlyRoleSql's output (a script the user copies and runs by hand) is excluded by name, and a rule keeps it from
//    ever reaching `run`;
// 4. no COMMIT literal (a transaction is never committed, only rolled back);
// 5. template literals in the SQL builders interpolate only quoteIdent(…), parameter indexes, or the module's own
//    constants; the same operands are required in `+` chains with a literal in them (the builders mostly concatenate:
//    the source is masked, literals become `¤`, quoteIdent(…) becomes `QI`, and each operand must be a literal, `QI`, a
//    number, an index, a constant, a local the module declares, or a parenthesised conditional of those). Limits: a
//    local's definition is checked where it is written but not followed across modules, a function parameter is never
//    accepted, and the text-only builders in TEXT_ONLY (DDL, role script, messages) are exempt and kept out of `run`.
const root = join(__dirname, '..', '..');
const DIR = 'src/main/databases/';
const CLIENT = 'src/main/databases/postgres/client.ts';
const CATALOG = 'src/main/databases/postgres/catalog.ts';
/** Who may call `.run(` on a session (the hub never does: it reads through these modules). */
const RUN_ALLOWED = new Set(['src/main/databases/queries.ts', CATALOG, 'src/main/databases/postgres/overview.ts']);
/** Files whose template literals build SQL (rule 5). */
const BUILDERS = new Set(['src/main/databases/postgres/sql.ts', CATALOG, 'src/main/databases/postgres/overview.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
type Source = { path: string; text: string };
const all = (): Source[] => sources(join(root, 'src')).map((p) => ({ path: posixRel(root, p), text: readFileSync(p, 'utf8') }));

/** `text`: a string's content, or a template's parts around the interpolations joined by a space. */
type Lit = { kind: 'string' | 'template'; text: string; exprs: string[] };

/** The index just past the template literal opening at `i` (its interpolations skipped whole, nested templates too). */
function templateEnd(src: string, i: number): number {
  i++;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') i += 2;
    else if (src[i] === '$' && src[i + 1] === '{') i = interpolationEnd(src, i + 2);
    else i++;
  }
  return i + 1;
}
/** The index just past the `}` that closes an interpolation whose expression starts at `i` (its strings and templates skipped). */
function interpolationEnd(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const d = src[i]!;
    if (d === "'" || d === '"') { i++; while (i < src.length && src[i] !== d) { if (src[i] === '\\') i++; i++; } i++; continue; }
    if (d === '`') { i = templateEnd(src, i); continue; }
    if (d === '{') depth++;
    else if (d === '}' && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/**
 * The string and template literals of a TypeScript source (comments and regex literals skipped), the ones inside a
 * template's `${…}` too (nested templates, strings), and the source with every literal masked as `¤` and comments
 * blanked: operands of `+` can then be told apart from the strings around them.
 */
function scan(src: string): { lits: Lit[]; masked: string } {
  const out: Lit[] = [];
  let masked = '';
  let i = 0;
  let last = ''; // last significant character, to tell a regex from a division
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; masked += ' '; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; masked += ' '; continue; }
    if (c === '/' && (last === '' || '=(,:;!&|?{}[+-*%<>~^'.includes(last))) {
      i++;
      let cls = false;
      while (i < src.length && (src[i] !== '/' || cls)) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        i++;
      }
      i++; last = '/'; masked += '¤'; continue;
    }
    if (c === "'" || c === '"') {
      let t = ''; i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') { t += src[i + 1] ?? ''; i += 2; } else t += src[i++]; }
      i++; out.push({ kind: 'string', text: t, exprs: [] }); last = c; masked += '¤'; continue;
    }
    if (c === '`') {
      const parts: string[] = []; const exprs: string[] = []; const nested: Lit[] = []; let t = ''; i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { t += src[i + 1] ?? ''; i += 2; }
        else if (src[i] === '$' && src[i + 1] === '{') {
          parts.push(t); t = '';
          const end = interpolationEnd(src, i + 2);
          const e = src.slice(i + 2, src[end - 1] === '}' ? end - 1 : end);
          exprs.push(e.trim());
          nested.push(...scan(e).lits); // the literals inside it: SQL text as much as the template's own
          i = end;
        } else t += src[i++];
      }
      i++; parts.push(t); out.push({ kind: 'template', text: parts.join(' '), exprs }, ...nested); last = '`'; masked += '¤'; continue;
    }
    if (!/\s/.test(c)) last = c;
    masked += c;
    i++;
  }
  return { lits: out, masked };
}
const literals = (src: string): Lit[] => scan(src).lits;

/** `quoteIdent(…)` calls, balanced, replaced by `QI` (their arguments are the quoter's own business). */
function maskQuoter(masked: string): string {
  let out = '';
  let i = 0;
  while (i < masked.length) {
    const m = /\bquoteIdent\s*\(/y;
    m.lastIndex = i;
    if (m.test(masked)) {
      let j = m.lastIndex; let depth = 1;
      while (j < masked.length && depth > 0) { if (masked[j] === '(') depth++; else if (masked[j] === ')') depth--; j++; }
      out += 'QI'; i = j;
    } else out += masked[i++];
  }
  return out;
}
const OPEN = '([{'; const CLOSE = ')]}';
/** Splits at depth 0 on one separator character. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = []; let depth = 0; let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (OPEN.includes(c)) depth++; else if (CLOSE.includes(c)) depth--;
    else if (c === sep && depth === 0 && !(sep === '+' && (text[i + 1] === '+' || text[i + 1] === '=' || text[i - 1] === '+'))) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts;
}
/** Characters that end an operand chain at depth 0. */
const CHAIN_STOP = ',;?:=&|<>!';
/** Every `+` chain of a masked source that has a literal in it, as the list of its operands. */
function chains(masked: string): string[][] {
  const seen = new Set<number>(); const out: string[][] = [];
  for (let at = 0; at < masked.length; at++) {
    if (masked[at] !== '+' || masked[at + 1] === '+' || masked[at + 1] === '=' || masked[at - 1] === '+') continue;
    let start = at; let depth = 0;
    while (start > 0) {
      const c = masked[start - 1]!;
      if (CLOSE.includes(c)) depth++;
      else if (OPEN.includes(c)) { if (depth === 0) break; depth--; }
      else if (depth === 0 && CHAIN_STOP.includes(c)) break;
      start--;
    }
    let end = at + 1; depth = 0;
    while (end < masked.length) {
      const c = masked[end]!;
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) { if (depth === 0) break; depth--; }
      else if (depth === 0 && CHAIN_STOP.includes(c) && !(c === '=' && masked[end + 1] === '>')) break;
      end++;
    }
    if (seen.has(start)) continue;
    seen.add(start);
    if (/\brefuse\(\s*$/.test(masked.slice(Math.max(0, start - 12), start))) continue; // refuse('…' + name): a message for the user, never SQL
    const text = masked.slice(start, end).replace(/^[\s\S]*\b(return|await)\b/, '');
    const pieces = splitTop(text, '+').map((x) => x.trim());
    if (pieces.includes('¤') || pieces.includes('QI')) out.push(pieces); // a quoted identifier is SQL text too
  }
  return out;
}
const declares = (text: string, name: string): boolean =>
  new RegExp(`\\b(const|let|var|function)\\s+${name}\\b`).test(text) || new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(text);
/**
 * An operand of a `+` chain that builds SQL: a literal, a quoted identifier, a number, an index, a constant (or a call
 * of one) or a local the module itself declares (its own definition is checked on its own), or a parenthesised
 * conditional of such operands. A local's arguments are not followed; a function parameter is not a local.
 */
function safeOperand(piece: string, text: string): boolean {
  const t = piece.trim();
  if (t === '¤' || t === 'QI' || /^\d+$/.test(t) || /^(i|n|p|idx)$/.test(t)) return true;
  // `xs.map((x) => ownBuilder(x…)).join(' AND ')`: each part comes from a builder the module declares
  const mapped = /^\w+\.map\(\([\w, ]*\) => ([A-Za-z_]\w*)\(.*\)\)\.join\(¤\)$/s.exec(t);
  if (mapped && declares(text, mapped[1]!)) return true;
  const call = /^([A-Za-z_]\w*)(\.\w+)*(\(.*\))?(\[[\w.]+\])?$/s.exec(t);
  if (call && declares(text, call[1]!)) return true;
  if (t.startsWith('(')) {
    // the opening paren must close at the very end
    let depth = 0; let closesAtEnd = true;
    for (let i = 0; i < t.length; i++) { if (t[i] === '(') depth++; else if (t[i] === ')') { depth--; if (depth === 0 && i < t.length - 1) closesAtEnd = false; } }
    if (!closesAtEnd) return false;
    const inner = t.slice(1, -1);
    const q = splitTop(inner, '?');
    const branches = q.length > 1 ? splitTop(q.slice(1).join('?'), ':') : [inner];
    return branches.every((b) => splitTop(b, '+').every((x) => safeOperand(x, text)));
  }
  return false;
}

/** The text of `export function readOnlyRoleSql` (a script for the user to run by hand), cut out. */
function withoutRoleScript(text: string): string {
  const start = text.indexOf('export function readOnlyRoleSql(');
  if (start < 0) return text;
  const end = text.indexOf('\n}\n', start);
  if (end < 0) return text; // can't find where it ends: fail closed (the script's own text gets flagged, loudly)
  return text.slice(0, start) + text.slice(end + 3);
}

/**
 * Functions that build TEXT for the user and are never executed: a role script, DDL to read and copy, a value shown in
 * the SQL popover, an error message. Their concatenations carry catalog values or user values on purpose, so rule 5
 * does not apply to them. In catalog.ts they must never reach `run` (rule `roleScriptRun`). One-line `const` arrows
 * end at the line, functions at `\n}\n`.
 */
const TEXT_ONLY: Record<string, string[]> = {
  [CATALOG]: ['readOnlyRoleSql', 'readDdl', 'columnDdl', 'valueDdl', 'foreignDdl', 'literal', 'unknownTable'],
  'src/main/databases/postgres/sql.ts': ['literal', 'columnOf']
};
function withoutTextBuilders(path: string, text: string): string {
  let out = text;
  for (const name of TEXT_ONLY[path] ?? []) {
    const m = new RegExp(`^(export )?(async )?(function ${name}\\b|const ${name} =)`, 'm').exec(out);
    if (!m) continue;
    const end = m[3]!.startsWith('const') ? out.indexOf('\n', m.index) : out.indexOf('\n}\n', m.index) + 2;
    if (end < m.index + 2) return text; // can't find where one ends: fail closed (everything gets checked, loudly)
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

/** SQL statements that change session or server state. Matched on a literal's text, statement-wise. */
const STATEMENTS: [string, RegExp][] = [
  // `SET x = …` / `SET x TO …` at a statement start (case-insensitive; "Set up" in a message is not a statement)
  ['SET', /(^|;)\s*SET\s+[\w."]+\s*(=|\bTO\b)/i],
  ['SET SESSION/LOCAL/ROLE', /\bSET\s+(SESSION|LOCAL|ROLE)\b/i],
  // The forms without `=`/TO: SET TIME ZONE, SET TRANSACTION (READ WRITE!), SET NAMES, SET SCHEMA, SET SEED, SET
  // CONSTRAINTS, SET XML OPTION
  ['SET TIME ZONE/TRANSACTION/NAMES/SCHEMA', /(^|;)\s*SET\s+(TIME\s+ZONE|TRANSACTION|NAMES|SCHEMA|SEED|CONSTRAINTS|XML\s+OPTION)\b/i],
  ['set_config', /\bset_config\s*\(/i],
  // Every RESET (ALL, a setting, ROLE, TIME ZONE, SESSION AUTHORIZATION). Statement-anchored, case-insensitive: this
  // scope (postgres/ + queries.ts) holds SQL, no UI prose
  ['RESET', /(^|;)\s*RESET\s+[\w"]/i],
  // DISCARD ALL / PLANS / SEQUENCES / TEMP(ORARY): the session's state thrown away (ALL resets every setting, the role
  // too). Its target written, or interpolated (a template's `${…}` reads as nothing after it).
  ['DISCARD', /(^|;)\s*DISCARD(\s+(ALL|PLANS|SEQUENCES|TEMP|TEMPORARY)\b|\s*(;|$))/i],
  ['COPY', /(^|;)\s*COPY\s+[\w"(]/i],
  ['LISTEN', /(^|;)\s*(LISTEN|UNLISTEN|NOTIFY)\s+[\w"]/i],
  ['EXPLAIN ANALYZE', /\bEXPLAIN\b[^;]*\bANALY[SZ]E\b/i],
  ['ANALYZE', /(^|;)\s*ANALY[SZ]E\b(\s+[\w".]+)?\s*(;|$)/i]
];
/**
 * The client's two wrappers (rule 3's one exception) as template literals' text (their parts around
 * the one interpolation joined by a space) and that interpolation: every statement's, and a `stable` one's (a keyless
 * page). Nothing else, no other spelling, may SET.
 */
const PLAIN_WRAPPER = 'BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout =  ';
const STABLE_WRAPPER = 'BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout =  ; SET LOCAL synchronize_seqscans = off; SET LOCAL max_parallel_workers_per_gather = 0';
const WRAPPER_EXPRS = ['ctx.timeoutSec * 1000'];
const isWrapper = (l: Lit): boolean =>
  l.kind === 'template' && (l.text === PLAIN_WRAPPER || l.text === STABLE_WRAPPER) && JSON.stringify(l.exprs) === JSON.stringify(WRAPPER_EXPRS);
/** The client holds exactly the two wrappers, once each (a copy would be a third place to drift). */
const wrapperProblems = (text: string): string[] => {
  const found = literals(text).filter(isWrapper).map((l) => l.text);
  return [PLAIN_WRAPPER, STABLE_WRAPPER].flatMap((w) => {
    const n = found.filter((x) => x === w).length;
    return n === 1 ? [] : [`${w === PLAIN_WRAPPER ? 'plain' : 'stable'} wrapper ×${n}`];
  });
};

/** What rule 5 accepts inside `${…}`, with why. */
const SAFE_INTERPOLATIONS: [string, RegExp][] = [
  ['an identifier through the quoter (quoteIdent(…) is masked to QI first, so its closing paren must end the operand)', /^QI$/],
  ['a $-parameter index', /^(i|n|p|idx)$/],
  ['a constant of the module (SCREAMING_CASE, declared there)', /^[A-Z][A-Z0-9_]*$/],
  ['a lookup in a constant table of the module (declared there)', /^[A-Z][A-Z0-9_]*\[[\w.]+\]$/]
];

/** The `pg` driver (or a module of it) named as a module: `from 'pg'`, a side-effect `import 'pg'`, `import(…)`, `require(…)`, any quote. */
const PG_MODULE = /\bfrom\s*(['"`])pg(\/[^'"`]*)?\1|\bimport\s*(['"`])pg(\/[^'"`]*)?\3|\b(require|import)\s*\(\s*(['"`])pg(\/[^'"`]*)?\6\s*\)/;

const rules = {
  pgImports: (files: Source[]) => files.filter((f) => f.path !== CLIENT && !/\.d\.ts$/.test(f.path) && PG_MODULE.test(f.text)).map((f) => f.path),
  /** `.run` (any form: called, taken, `?.(`, `.call`, ['run']) or a destructured `run`, outside the query modules. */
  runCallers: (files: Source[]) => files.filter((f) => f.path.startsWith(DIR) && !RUN_ALLOWED.has(f.path) && /\.run\b|\[\s*['"]run['"]\s*\]|\{[^{}]*\brun\b[^{}]*\}\s*=[^=>]|\(\s*\{[^{}]*\brun\b[^{}]*\}\s*[:,)]/.test(f.text)).map((f) => f.path),
  /** In the query modules `.run` is only ever called, with a builder's Stmt or an object literal with `text:`; `run` is never taken or destructured. */
  runArguments: (files: Source[]) => files.filter((f) => RUN_ALLOWED.has(f.path)).flatMap((f) => [
    ...[...f.text.matchAll(/\.run\b(?!\s*\(\s*(\{\s*text\s*:|\w*Stmt\b|stmt\b|st\b))([^)]{0,40})/g)].map((m) => `${f.path}: .run${m[2]!.trim()}`),
    ...[...f.text.matchAll(/\{[^{}]*\brun\b[^{}]*\}\s*=[^=>]|\[\s*['"]run['"]\s*\]/g)].map((m) => `${f.path}: ${m[0]}`)
  ]),
  /**
   * The user's role script is text to copy, never an argument of `run`: in the query modules `readOnlyRoleSql` appears
   * only as its definition, as `return readOnlyRoleSql(…)` (the call that hands the script to the user), and in a named
   * import under its own name (an alias would hide the calls from this rule).
   */
  roleScriptRun: (files: Source[]) => files.filter((f) => RUN_ALLOWED.has(f.path)).flatMap((f) => {
    // An import ends at its `from '…'` (with or without a semicolon after it).
    const imports = [...f.text.matchAll(/^import\s[^;]*?\bfrom\s*['"][^'"]*['"]/gm)].map((m) => [m.index, m.index + m[0].length] as const);
    const inImport = (i: number) => imports.some(([a, b]) => i >= a && i < b);
    return [...f.text.matchAll(/(.{0,20})\breadOnlyRoleSql\b(\s+as\b)?/g)]
      .filter((m) => !/(export function |return )$/.test(m[1]!) && !(inImport(m.index + m[1]!.length) && !m[2]))
      .map(() => `${f.path}: readOnlyRoleSql`)
      .concat([...f.text.matchAll(/\.run\s*\([^;]*\b(readDdl|columnDdl|valueDdl|foreignDdl)\b/g)].map((m) => `${f.path}: ${m[1]!}`));
  }),
  statements: (files: Source[]) => files
    .filter((f) => (f.path.startsWith(DIR + 'postgres/') || f.path === DIR + 'queries.ts') && !/\.d\.ts$/.test(f.path))
    .flatMap((f) => literals(f.path === CATALOG ? withoutRoleScript(f.text) : f.text)
      .filter((l) => !(f.path === CLIENT && isWrapper(l)))
      .flatMap((l) => STATEMENTS.filter(([, re]) => re.test(l.text)).map(([n]) => `${f.path}: ${n}`))),
  commit: (files: Source[]) => files.filter((f) => f.path.startsWith(DIR)).flatMap((f) =>
    // `.on('end', …)` is node's event name, not a statement
    literals(f.text.replace(/\.on\(\s*'end'/g, ".on('event'")).filter((l) => /\bCOMMIT\b/i.test(l.text) || /(^|;)\s*(END|ABORT)(\s+(TRANSACTION|WORK))?\s*(;|$)/i.test(l.text)).map(() => `${f.path}: COMMIT/END/ABORT`)),
  /** Rule 5: `${…}` in template literals, and the operands of `+` chains with a literal in them. */
  interpolations: (files: Source[]) => files.filter((f) => BUILDERS.has(f.path)).flatMap((f) => {
    const { lits } = scan(f.text);
    const masked = scan(withoutTextBuilders(f.path, f.text)).masked;
    const inTemplates = lits.flatMap((l) => l.exprs
      .map((e) => maskQuoter(scan(e).masked).trim())
      .filter((e) => !SAFE_INTERPOLATIONS.some(([, re]) => re.test(e)) || (e !== 'QI' && /^[A-Z]/.test(e) && !declares(f.text, e.replace(/\[.*$/, ''))))
      .map((e) => `${f.path}: \${${e}}`));
    const inChains = chains(maskQuoter(masked)).flatMap((pieces) => pieces.filter((x) => !safeOperand(x, f.text)).map((x) => `${f.path}: + ${x}`));
    return [...inTemplates, ...inChains];
  })
};

describe('the databases read-only path stays read-only', () => {
  test('the scan sees the database sources', () => {
    const paths = all().map((f) => f.path).filter((p) => p.startsWith(DIR));
    for (const p of [CLIENT, CATALOG, 'src/main/databases/postgres/sql.ts', 'src/main/databases/postgres/overview.ts']) expect(paths).toContain(p);
  });
  test('only client.ts imports pg', () => { expect(rules.pgImports(all())).toEqual([]); });
  test('.run( on a session only in the query modules', () => { expect(rules.runCallers(all())).toEqual([]); });
  test('every .run( takes a Stmt from a builder', () => { expect(rules.runArguments(all())).toEqual([]); });
  test('the role script never reaches run', () => { expect(rules.roleScriptRun(all())).toEqual([]); });
  test('no state-changing statement in a literal', () => { expect(rules.statements(all())).toEqual([]); });
  test('no COMMIT literal', () => { expect(rules.commit(all())).toEqual([]); });
  test('SQL builders interpolate only quoted identifiers, parameter indexes and own constants', () => { expect(rules.interpolations(all())).toEqual([]); });

  test('the client keeps its two wrapper literals, once each, every SET in them LOCAL', () => {
    const client = readFileSync(join(root, CLIENT), 'utf8');
    expect(wrapperProblems(client)).toEqual([]);
    expect(client).toContain('`BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}`');
    expect(client).toContain(
      '`BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}; SET LOCAL synchronize_seqscans = off; '
        + 'SET LOCAL max_parallel_workers_per_gather = 0`'
    );
  });

  test('the rules catch what they guard against', () => {
    const f = (path: string, text: string): Source[] => [{ path, text }];
    // 1
    expect(rules.pgImports(f('src/main/databases/postgres/sql.ts', "import { Client } from 'pg';"))).toEqual(['src/main/databases/postgres/sql.ts']);
    expect(rules.pgImports(f('src/main/other.ts', "const pg = require('pg/lib/client');"))).toEqual(['src/main/other.ts']);
    expect(rules.pgImports(f(CLIENT, "import PgClient from 'pg/lib/client';"))).toEqual([]);
    expect(rules.pgImports(f('src/main/databases/postgres/pg-js-client.d.ts', "import { Client } from 'pg';"))).toEqual([]);
    expect(rules.pgImports(f('src/main/other.ts', "import { x } from 'pgsql-thing';"))).toEqual([]);
    // A side-effect import, a template specifier, no space before the quote: still the driver.
    for (const t of ["import 'pg';", 'import "pg/lib/client"', "import'pg'", 'const m = await import(`pg`);', 'const pg = require(`pg/lib/client`);', "export * from 'pg';", "import x from'pg';"]) {
      expect(rules.pgImports(f('src/main/other.ts', t)), t).toEqual(['src/main/other.ts']);
    }
    for (const t of ["import 'pgsql-thing';", "import './pg-helpers';", 'const m = await import(`./pg`);', "import { PgClient } from './pg-client';"]) {
      expect(rules.pgImports(f('src/main/other.ts', t)), t).toEqual([]);
    }
    // 2
    expect(rules.runCallers(f('src/main/databases/postgres/errors.ts', 's.run(stmt)'))).toEqual(['src/main/databases/postgres/errors.ts']);
    expect(rules.runCallers(f(CATALOG, 's.run(stmt)'))).toEqual([]);
    expect(rules.runArguments(f(CATALOG, "await s.run('DROP TABLE x')"))).toEqual([`${CATALOG}: .run('DROP TABLE x'`]);
    expect(rules.runArguments(f(CATALOG, 'await this.session.run(someText)'))).toHaveLength(1);
    expect(rules.runArguments(f(CATALOG, "await s.run({ text: 'SELECT 1', values: [], shape: 'x' }); s.run(schemasStmt(v)); session.run(stmt)"))).toEqual([]);
    expect(rules.roleScriptRun(f(CATALOG, 'await s.run({ text: readOnlyRoleSql(r, v) })'))).toEqual([`${CATALOG}: readOnlyRoleSql`]);
    expect(rules.roleScriptRun(f(CATALOG, 'const script = readOnlyRoleSql(r, v);\nawait s.run({ text: script });'))).toHaveLength(1);
    expect(rules.roleScriptRun(f(CATALOG, 'export function readOnlyRoleSql(r: string): string {\n  return r;\n}\nexport const x = () => { return readOnlyRoleSql(a, b); };'))).toEqual([]);
    expect(rules.roleScriptRun(f(CATALOG, 'await s.run({ text: await readDdl(s, a, b) })'))).toEqual([`${CATALOG}: readDdl`]);
    expect(rules.roleScriptRun(f(CATALOG, 'await s.run({ text: foreignDdl(x) })'))).toEqual([`${CATALOG}: foreignDdl`]);
    // A query module that imports it may only hand its text back, by its name; an alias would hide the calls from the rule.
    const QM = 'src/main/databases/queries.ts';
    expect(rules.roleScriptRun(f(QM, "import {\n  readCatalog, readOnlyRoleSql, readServerInfo\n} from './postgres/catalog';\nfunction roleScript(v: number): string {\n  return readOnlyRoleSql('r', v);\n}"))).toEqual([]);
    expect(rules.roleScriptRun(f(QM, "import { readOnlyRoleSql as script } from './postgres/catalog';\nawait s.run({ text: script('r', 1) });"))).toEqual([`${QM}: readOnlyRoleSql`]);
    expect(rules.roleScriptRun(f(QM, "import { readOnlyRoleSql } from './postgres/catalog';\nconst t = readOnlyRoleSql('r', 1);"))).toEqual([`${QM}: readOnlyRoleSql`]);
    expect(rules.roleScriptRun(f(QM, "const x = { readOnlyRoleSql };"))).toEqual([`${QM}: readOnlyRoleSql`]);
    // An import without a semicolon ends at its `from '…'`, not at the next `;` of the code after it.
    expect(rules.roleScriptRun(f(QM, "import { readOnlyRoleSql } from './postgres/catalog'\nconst t = readOnlyRoleSql(r, v);"))).toEqual([`${QM}: readOnlyRoleSql`]);
    expect(rules.roleScriptRun(f(QM, "import {\n  readOnlyRoleSql\n} from './postgres/catalog'\nfunction s(v: number): string {\n  return readOnlyRoleSql('r', v)\n}"))).toEqual([]);
    // The hub hands the script back too, but runs nothing itself: any `.run` there is flagged.
    const HUB = 'src/main/databases/hub.ts';
    expect(rules.runCallers(f(HUB, 'await l.session.run(stmt)'))).toEqual([HUB]);
    expect(rules.runCallers(f(HUB, "import { readOnlyRoleSql } from './postgres/catalog';\nfunction roleScript(v: number): string {\n  return readOnlyRoleSql('r', v);\n}"))).toEqual([]);
    // `run` taken without a call, in any file
    for (const t of ['const { run } = session; run(stmt);', 'const f = s.run; f(x);', 's.run.call(s, x)', 's.run?.(x)', "s['run'](x)", 'function g({ run }: DbSession) {}']) {
      expect(rules.runCallers(f('src/main/databases/postgres/errors.ts', t)), t).toEqual(['src/main/databases/postgres/errors.ts']);
    }
    for (const t of ['const { run } = session; run(stmt);', 'const f = s.run; f(x);', 's.run.call(s, x)', 's.run?.(x)', "s['run'](x)"]) {
      expect(rules.runArguments(f(CATALOG, t)), t).not.toEqual([]);
    }
    expect(rules.runCallers(f('src/main/databases/driver.ts', 'interface DbSession {\n  run(stmt: Stmt): Promise<DbRows>;\n}'))).toEqual([]);
    // 3
    const bad = (text: string) => rules.statements(f('src/main/databases/postgres/sql.ts', text));
    for (const t of ["'SET search_path = x'", "'SELECT 1; SET ROLE x'", '`SET LOCAL x = ${n}`', "'RESET ALL'", "'RESET statement_timeout'", "'SELECT pg_catalog.set_config(\\'a\\', \\'b\\', false)'",
      "'COPY t TO STDOUT'", "'COPY (SELECT 1) TO STDOUT'", "'LISTEN ch'", "'EXPLAIN ANALYZE SELECT 1'", "'EXPLAIN (ANALYZE, BUFFERS) SELECT 1'", "'ANALYZE t'", "'set search_path to x'",
      "'reset statement_timeout'", "'Reset All'", "'analyze t'", "'analyse'", "'copy t to stdout'", "'listen x'", "'notify x'", "'SELECT 1; reset all'"]) {
      expect(bad(t), t).not.toEqual([]);
    }
    // SET and RESET forms without `=`/TO, and multi-word ones: every one changes the session or the transaction.
    for (const t of ["'SET TIME ZONE \\'UTC\\''", "'set time zone local'", "'SET TRANSACTION READ WRITE'", "'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'",
      "'SET NAMES \\'LATIN1\\''", "'SET SCHEMA \\'x\\''", "'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE'", "'SET SESSION AUTHORIZATION x'",
      "'SELECT 1; SET TRANSACTION READ WRITE'", "'RESET SESSION AUTHORIZATION'", "'reset session authorization'", "'RESET ROLE'", "'RESET TIME ZONE'",
      "'SELECT 1; RESET SESSION AUTHORIZATION'", '`SET TIME ZONE ${QI}`']) {
      expect(bad(t), t).not.toEqual([]);
    }
    // DISCARD (ALL, PLANS, SEQUENCES, TEMP / TEMPORARY): it throws the session's state away (ALL resets every setting,
    // ROLE and SESSION AUTHORIZATION included).
    for (const t of ["'DISCARD ALL'", "'discard all'", "'DISCARD PLANS'", "'DISCARD SEQUENCES'", "'DISCARD TEMP'", "'DISCARD TEMPORARY'", "'SELECT 1; DISCARD ALL'",
      "'Discard Plans'", '`DISCARD ${QI}`', "const a = `SELECT ${flag ? 'x; DISCARD ALL' : ''}`;"]) {
      expect(bad(t), t).not.toEqual([]);
    }
    // Nested literals inside `${…}` are SQL text too: a template or a string there is scanned like any other.
    for (const t of ["const a = `SELECT ${flag ? `1; SET search_path = x` : ''}`;", "const a = `SELECT ${flag ? 'x; RESET ALL' : ''}`;",
      'const a = `SELECT ${f(`a}b`)}; SET x = 1`;', "const a = `SELECT ${a ? `x ${b ? 'y; SET TIME ZONE 0' : ''}` : ''}`;"]) {
      expect(bad(t), t).not.toEqual([]);
    }
    expect(rules.commit(f(CLIENT, "q(`SELECT ${a ? `1; COMMIT` : ''}`)"))).toHaveLength(1);
    // catalog columns, UI words, comments and regexes are not statements
    for (const t of ["'SELECT s.last_analyze, s.last_autoanalyze FROM pg_catalog.pg_stat_all_tables s'", "'Set up the connection'", "'ANALYZE the plan'", "'Discard changes'", "'discarded'",
      "'pg_stat_statements_reset'", "'SELECT 1 /* SET x */'", '// SET x = 1\nconst a = 1;', 'const re = /"SET"/; const b = 1;', "'isset(x)'", "'OFFSET 5'"]) {
      expect(bad(t), t).toEqual([]);
    }
    // The two wrappers: exactly those texts and that interpolation, in client.ts only.
    const PLAIN = '`BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}`';
    const WRAPPER = '`BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ${ctx.timeoutSec * 1000}; SET LOCAL synchronize_seqscans = off; SET LOCAL max_parallel_workers_per_gather = 0`';
    for (const w of [PLAIN, WRAPPER]) {
      expect(rules.statements(f(CLIENT, `this.begin = ${w};`)), w).toEqual([]);
      expect(rules.statements(f('src/main/databases/postgres/overview.ts', `this.begin = ${w};`)), w).not.toEqual([]);
    }
    for (const drift of [
      WRAPPER.replace('synchronize_seqscans = off', 'synchronize_seqscans = on'),
      WRAPPER.replace('max_parallel_workers_per_gather = 0', 'max_parallel_workers_per_gather = 0; SET LOCAL search_path = x'),
      WRAPPER.replace('SET LOCAL synchronize_seqscans', 'SET synchronize_seqscans'),
      WRAPPER.replace('${ctx.timeoutSec * 1000}', '${userInput}'),
      PLAIN.replace('${ctx.timeoutSec * 1000}', '${ms}'),
      PLAIN.replace('SET LOCAL statement_timeout', 'SET statement_timeout'),
      // A third template: another setting next to the timeout.
      PLAIN.replace('`', '`').replace('1000}`', "1000}; SET LOCAL work_mem = '1GB'`"),
      PLAIN.replace('1000}`', '1000}; SET LOCAL synchronize_seqscans = off`'),
      WRAPPER.replace(/`/g, "'").replace('${ctx.timeoutSec * 1000}', '15000')
    ]) {
      expect(rules.statements(f(CLIENT, `this.begin = ${drift};`)), drift).not.toEqual([]);
    }
    // Exactly the two, once each: one missing, or a copy, is a problem.
    expect(wrapperProblems(`a = ${PLAIN}; b = ${WRAPPER};`)).toEqual([]);
    expect(wrapperProblems(`a = ${PLAIN};`)).toEqual(['stable wrapper ×0']);
    expect(wrapperProblems(`a = ${PLAIN}; b = ${WRAPPER}; c = ${WRAPPER};`)).toEqual(['stable wrapper ×2']);
    expect(rules.statements(f(CLIENT, "x = 'BEGIN TRANSACTION READ ONLY; SET search_path = x'"))).not.toEqual([]);
    const script = 'export function readOnlyRoleSql(role: string): string {\n  return "CREATE ROLE x; SET ROLE y; COPY t TO STDOUT";\n}\n';
    expect(rules.statements(f(CATALOG, script))).toEqual([]);
    expect(rules.statements(f(CATALOG, script + "const q = 'SET ROLE y';\n"))).not.toEqual([]);
    expect(rules.statements(f('src/main/databases/queries.ts', "'SET x = 1'"))).not.toEqual([]);
    expect(rules.statements(f('src/main/databases/hub.ts', "'SET x = 1'"))).toEqual([]); // out of scope: hub builds no SQL
    // 4
    expect(rules.commit(f('src/main/databases/hub.ts', "await c.query('COMMIT')"))).toEqual(['src/main/databases/hub.ts: COMMIT/END/ABORT']);
    expect(rules.commit(f(CLIENT, "q('commit')"))).toHaveLength(1);
    expect(rules.commit(f(CLIENT, "'READ COMMITTED' // COMMIT later"))).toEqual([]);
    for (const t of ["q('END')", "q('end;')", "q('ABORT')", "q('abort transaction')", "q('SELECT 1; END')", "q('COMMIT PREPARED \\'x\\'')"]) expect(rules.commit(f(CLIENT, t)), t).toHaveLength(1);
    expect(rules.commit(f(CLIENT, "this.client.on('end', () => 1); q('SELECT 1 /* END */'); q('CASE WHEN a THEN 1 END')"))).toEqual([]);
    // the role script's cut fails closed
    expect(rules.statements(f(CATALOG, 'export function readOnlyRoleSql(r: string): string {\n  return "SET ROLE y";\n'))).not.toEqual([]);
    // 5
    const tpl = (text: string) => rules.interpolations(f('src/main/databases/postgres/sql.ts', text));
    expect(tpl('const REFS_CAP = 5; const DIR = {}; const a = `SELECT ${quoteIdent(c.name)} LIMIT ${REFS_CAP} OFFSET $${n} ${DIR[s.dir]}`;')).toEqual([]);
    expect(tpl('const a = `SELECT ${userInput}`;')).toEqual(['src/main/databases/postgres/sql.ts: ${userInput}']);
    expect(tpl('const a = `SELECT ${c.name}`;')).toHaveLength(1);
    expect(tpl('const a = `SELECT ${quoteIdent(x)}${rest}`;')).toHaveLength(1);
    expect(tpl("const a = `${quoteIdent(a) + userInput.join(',')}`;")).toHaveLength(1); // quoteIdent's own paren must end the operand
    expect(tpl('const a = `${quoteIdent(a)}`;')).toEqual([]);
    // `+` chains (what the builders mostly use)
    expect(tpl("const a = 'SELECT ' + userInput + ' FROM t';")).toEqual(['src/main/databases/postgres/sql.ts: + userInput']);
    expect(tpl("function b(name: string) { return 'SELECT ' + name; }")).toEqual(['src/main/databases/postgres/sql.ts: + name']); // a parameter is not a local
    expect(tpl("function b(name: string) { refuse(name + ' is not a column'); }")).toEqual([]); // a message for the user
    expect(tpl("function b(name: string) { refuse('x'); return 'SELECT ' + name; }")).toHaveLength(1);
    expect(tpl("const a = 'SELECT ' + req.body.sql;")).toHaveLength(1);
    expect(tpl("const a = 'SELECT ' + quoteIdent(x) + userInput;")).toHaveLength(1);
    expect(tpl("const a = 'SELECT ' + (flag ? userInput : '');")).toHaveLength(1);
    expect(tpl("const a = 'x ' + quoteIdent(a) + userInput.join(',');")).toHaveLength(1);
    expect(tpl("const a = quoteIdent(a) + userInput.join(',');")).toHaveLength(1); // no string literal, still SQL text
    expect(tpl("const V10 = 10; const BLOCK = 'b'; function rel() { return ''; } const where = 'w';\n"
      + "const a = 'SELECT ' + quoteIdent(c.name + '→' + p) + ' FROM ' + rel(t) + (v >= V10 ? ' AND x' : '') + where + BLOCK + ' LIMIT ' + 5;")).toEqual([]);
    expect(tpl("const T = (v: number): string => 'a' + (v >= 10 ? 'b' : '');\nconst x = 'y' + T(v);")).toEqual([]);
    expect(tpl("const x = 1 + 2; const y = a + b;")).toEqual([]); // no literal: not a string concatenation
    expect(tpl("function z(name: string) { return 'No ' + name; }\nfunction columnOf(t: T, name: string) { throw 'No ' + name; }\n")).toHaveLength(1); // columnOf is text-only, z is not
    expect(tpl('const a = `LIMIT ${LIMIT}`;')).toHaveLength(1); // looks like a constant but the module doesn't declare it
    expect(tpl("const a = `${quoteIdent(a + '}' + b)}`;")).toEqual([]);
    // A template nested in an interpolation has its own interpolations checked.
    expect(tpl("const a = `SELECT ${flag ? `${userInput}` : ''}`;")).toContain('src/main/databases/postgres/sql.ts: ${userInput}');
    expect(rules.interpolations(f('src/main/databases/hub.ts', 'const a = `${x}`;'))).toEqual([]); // not a builder
  });
});
