# CLAUDE.md

Atelier is a desktop app (Electron; macOS, and Windows through the Microsoft Store) for working with many Claude Code
sessions in parallel. This file is for anyone working on its code, and for their agents: [README.md](README.md) is for
users, [CONTRIBUTING.md](CONTRIBUTING.md) says how to propose a change. Personal instructions go in `CLAUDE.local.md`,
which git ignores.

## Working rules

- **English everywhere:** code, identifiers, comments, test names, commit messages, UI strings. Other languages appear
  only as data (dictation samples, whisper hallucination filters, the filler words the dictation clean-up drops).
- **A failing test first**, for every change, small fixes included. Prove UI behaviour with an e2e test and a
  screenshot you actually look at, and check that a new test catches the bug it is about (break the code, watch it
  fail).
- **Never touch the developer's own Atelier.** Dev, e2e and packaged-test instances always run with a temporary
  `ATELIER_HOME` (`tests/e2e/env.ts` → `e2eEnv`), never `~/Library/Application Support/Atelier`. An installed Atelier
  and its `atelierd` keep running: never restart or kill them. Tests never touch the shell config, Claude settings and
  status line (`ATELIER_USER_CLAUDE_SETTINGS`), the Trash, the microphone or the clipboard.
- **Inside Atelier, stay in the repository.** macOS attributes every file access of the processes in Atelier's
  terminals to Atelier: a broad search (`find ~`, `mdfind`, `vitest --root /`) floods the user with privacy prompts
  (iCloud Drive, Photos, Music…). Scope every command to the repository, and tell every subagent so.
- **Comments stand on their own.** A comment says what the code does and why, by itself: no references to documents,
  tickets or notes a reader cannot open, no notes on who decided what. Tests and fixtures hold no personal paths,
  accounts or addresses (`/Users/me`, `example.com`). No comparisons with other products; their functional names
  (environment variables, shims) are fine. `tests/integration/public-tree.test.ts` checks every file;
  `node scripts/public-tree.mjs --lines` shows what it finds.
- **`atelierd` changes are rare and backward compatible.** The daemon owns the terminals and outlives app updates: a
  change in what it bundles reaches users only after an `atelierd` restart, which closes their sessions.
  `node scripts/daemon-reach.mjs` lists the modules it bundles; `node scripts/daemon-fingerprint.mjs`, run on two
  commits, tells whether a change would ask for that restart.
- **Quality bar:** usefulness, UX, polish, modernity and cleanliness weigh together. Never flat, never sluggish.
- **The website and its live demo follow the app.** When a change visibly alters the UI or adds a feature, check
  `site/` (screenshots with `npm run site:shots`, the copy in `site/src/content/features.ts`, claims no longer true),
  `README.md`'s feature list and `src/demo/`: a new `api.ts` method is a type error in `src/demo/bridge/` until it gets
  an answer (usually inert). The demo bundle is public, so state detection and parsers stay build-time only
  (`src/demo/compile/`, `BUILD_TIME_ONLY`; the build fails otherwise), and the site must not get heavier
  (`npm --prefix site run perf -- --out base.json` before the change, `-- --against base.json` after).
- **Commits:** a short summary line with a prefix (`feat:`, `fix:`, `chore:`, `test:`, `site:` for the website), then
  the why.

## Architecture

| Part | Where | Notes |
|---|---|---|
| Main process | `src/main/` | Windows, IPC (zod schemas in `ipc-schemas.ts`), git (reads through `git/exec.ts`; writes only through Source Control's fetch, `git/fetch.ts` + `fetch-scheduler.ts`, and `git/write.ts` behind `git-ops.ts`: commit, push, pull, stash, branches, discard; ✦ messages in `scm/message.ts`), tmux services (read-only), settings, updates, dictation. |
| `atelierd` | `src/daemon/` | The daemon that owns the PTYs, started as a launchd job of its own. Each terminal's shell runs in its own one-shot launchd job (`session-pty.ts`, `native/atelier-pty-host.c`), node-pty spawn as fallback. Survives app quits and updates. Unix socket 0600 + tokens. Protocol version in `src/shared/version.ts`. |
| Renderer | `src/renderer/` | React + zustand store (`store.ts`), xterm.js terminals (`terminal/`), CodeMirror editor (`editor/`), components. |
| Preload | `src/preload/index.ts` | The only bridge (`window.atelier`), typed in `src/shared/api.ts`. |
| Shared | `src/shared/` | Pure, tested logic (settings, sessions, dictation helpers…). |
| Native | `native/` | `atelier-whisper.cpp`: our whisper.cpp v1.9.5 binary (Metal) for dictation, built by `npm run build:whisper` into `vendor/`. `atelier-pty-host.c`: starts each terminal's shell in its launchd job, built by `npm run build`. Windows helpers (`atelier-bridge.c` and others), built by `npm run build` on Windows. |
| Website | `site/` | Astro product site: Aurora tokens imported from `theme.css`, real-app screenshots, live at useatelier.dev (Cloudflare Pages). Own `package.json`. `site/functions` serves the app's update endpoints and `/download/mac` (optional Pages secret `GITHUB_TOKEN`). |
| Live demo | `src/demo/` | The real renderer in the browser for the site's "Try it live": a typed fake `window.atelier` (`bridge/`), scripted behaviour on one pausable clock (`engine/`), the fictional world shared with the site's screenshots (`world/`), a build-time compiler that runs the app's own reducers and parsers (`compile/`), menu bar, checklist and page messages (`shell/`), the page⇄demo protocol (`protocol.ts`). `npm run build:demo` → `site/public/demo-app/` (git-ignored; the site build runs it). |

Claude Code sessions are detected through hook and status line wrappers that `atelierd` installs in `ATELIER_HOME/bin`
and passes with `--settings`.

## Commands

```sh
npm run dev              # dev app (with a separate ATELIER_HOME)
npm test                 # vitest (unit + tests/integration static guards)
npm run typecheck
npm run e2e              # build + the whole Playwright/Electron e2e (windows stay hidden: never shown, focused or raised)
npm run e2e:affected     # build + only the e2e this change can affect (-- --list to preview; map in tests/e2e/areas.ts)
npm run build:whisper    # whisper.cpp + atelier-whisper into vendor/ (cmake from a local venv, never system-wide)
npm run dist             # release/mac-arm64/Atelier.app, signed by scripts/sign-app.mjs (Developer ID if in the keychain)
npm run stage-update     # build + packaged checks, staged as an update of your installed Atelier ("Update ready · Restart")
npx playwright test --config playwright.manual.config.ts tests/e2e/packaged.manual.ts   # packaged-app checks
npm --prefix site run dev        # website on localhost
npm --prefix site test           # site unit tests + build + dist guard (sensitive strings, noindex)
npm --prefix site run e2e        # site Playwright e2e (Chromium inside site/node_modules: npm --prefix site run e2e:install)
npm run site:shots               # regenerate the site's screenshots from the real app (fictional project, privacy guard)
npm run build:demo               # the website's live demo bundle (site/public/demo-app; guards in tests/integration/demo-*)
npm --prefix site run e2e:browsers   # the live demo's e2e in WebKit
npm --prefix site run perf -- --out x.json --against <baseline.json>   # Lighthouse + load contract (manual)
```

## Security rules the code relies on

- Project writes only from `src/main/fs/write.ts` (user actions only; never inside `.git`; atomic; Trash, never
  delete). Other main-process writers are listed with a reason in `tests/integration/write-apis.test.ts`; atelierd's too.
- Processes only from the modules allowed in `tests/integration/no-child-process.test.ts`; `execFile` (or `spawn` with
  an argv, as `git/fetch.ts` and `git/write.ts` need for `detached`), never a shell.
- `runGit` (`git/exec.ts`) only reads: a closed list of subcommands and exact shapes, never a write subcommand.
- Git writes only from two modules:
  - `git fetch` from `git/fetch.ts` (fixed argv, no hooks, no `ext::`, no prompt, no tty): remote-tracking refs,
    objects and `FETCH_HEAD` only;
  - every other write from `git/write.ts`, behind `git-ops.ts`:
    - a closed list of ops, one argv builder each, and `runWrite` runs only invocations those builders made;
    - paths through stdin pathspecs (literal), messages through stdin, refs from the last refs read, new names through
      `check-ref-format`;
    - the user's hooks run on purpose (husky); no tty, prompts off, editors `:`, timeouts stop the process group
      (SIGTERM, then SIGKILL);
    - one write per object store at a time (fetch queues behind it); the Read-only setting refuses every op in main;
    - never `reset --hard`, `clean`, `--discard-changes` or a plain force: a force push is only
      `--force-with-lease=<ref>:<the oid Atelier showed> --force-if-includes` with an explicit refspec;
    - never a bare `git push`: a plain push is `<push remote> refs/heads/<b>:refs/heads/<b>` (push.default can't widen
      or redirect it), refused for a branch tracking another name; new branches get `--no-track` unless they copy the
      same-named remote branch; a stash is applied by its oid and dropped only once found again by it;
    - discard moves the file to the Trash through `fs/write.ts` before git restores it.
- Every IPC handler checks the sender is an app page and validates input with a strict schema.
- Test-only env vars (`ATELIER_TEST_*`, `ELECTRON_RENDERER_URL`) go through `devEnv()` and are inert in the packaged app.
- Permissions: everything denied except the microphone (audio only, app pages only, dictation enabled) and
  `local-fonts` (the installed fonts' names for the terminal font pickers, app pages only).
- No network from the renderer; links open in the user's browser; OSC 8 links show their real target.
- Videos reach the page only through `atelier-media:` tokens main issues (`media-protocol.ts`) for a file the window
  may read (its project, or granted), checked again at every request: GET/HEAD only, one byte range at a time,
  read-only; tokens die with their window.

## Testing notes

- CI (`.github/workflows/ci.yml`): every push to `main`, pull requests and manual runs.
- e2e use `e2eEnv()`: temporary `ATELIER_HOME`, empty `ZDOTDIR`, fake Claude (`tests/e2e/fake-claude.pl`), fake whisper
  (`tests/fixtures/fake-whisper.mjs`), test audio instead of the microphone (`ATELIER_TEST_FAKE_MIC`).
- Chromium's fake audio device returns silence on macOS and still triggers the microphone prompt: don't use it.
- Screenshots to look at go through `look()` (`tests/e2e/shots.ts`): taken only with `ATELIER_E2E_SHOTS=1`, so a
  normal run pays neither the shot nor its settle wait. Production timings a test would wait for get a test-only
  `devEnv()` override (`testMs()`), never a longer `waitForTimeout`.
- e2e by area: while iterating, run the feature's own specs (`npm run e2e -- tests/e2e/x.spec.ts`); before a merge or
  a pull request, `npm run e2e:affected`. It widens to the whole suite by itself when the change touches foundations,
  only wiring, or a path the map doesn't know.
- One e2e run at a time per machine: Playwright's global setup waits on a lock in the git common dir, shared by every
  worktree. A run uses 2 workers (~0.7 GB each): tests must not share ports, files or timing with each other.
  `ATELIER_E2E_NO_LOCK=1` is for a run that truly must not wait.
- A new spec or source file gets its line in `tests/e2e/areas.ts` (`tests/integration/e2e-areas.test.ts` names it).
- A red in a run of many: rerun that spec alone before investigating; a red that passes alone is a race to fix, not a
  reason to add a wait.
- Run long suites (`npm run e2e`, packaged checks) as background tasks **without redirecting their output**: Atelier's
  Background inspector shows the task's own output live, and Claude Code keeps it for reading later.
- Test runs use a private temp root (`atl-run-*`, `tests/support/temp-root.ts`, vitest/Playwright global setup) removed
  at the end; never leave files in the system temp folder. Unix sockets under it (tmux) must stay ≤ 103 bytes.

## Brand & design system — Aurora

Source of truth: `src/renderer/theme.css` (tokens, the only place for raw values) and `layout.css`. Logo:
`assets/brand/mark.svg` (stacked panes, Λ with **no crossbar**); Dock icon `assets/brand/app-icon.svg` (single gradient
tile + white Λ).

- **Palette:** indigo night backgrounds `--bg-0..3` (#08080F → #1B1B2E); text `--text..--text-4`; brand gradient
  `--brand` violet `#8B5CF6` → pink `#EC4899`; states: waiting amber `#FBBF24`, working sky `#60A5FA`, done green
  `#34D399`, error rose `#FB7185`. Use tokens, never new hex values in components.
- **Type:** Instrument Sans (UI), JetBrains Mono (code, paths, numbers, shortcuts). Base 13px; section labels 10.5px
  uppercase with letter-spacing.
- **Shape & depth:** radius `--r-sm` 6 / `--radius` 10 / `--r-lg` 14; pills 999px. Floating surfaces use `--bg-float`
  + backdrop blur + `--shadow-float`; emphasis with `--glow` or soft colored glows. Never flat: hover, focus and
  active states on everything interactive.
- **Motion:** `--ease` with `--t-fast/med/slow` (120/180/240 ms); entrance `atl-pop`/`atl-fade`; respect "Reduce
  motion" (`data-motion="reduced"`).
- **Patterns to reuse:** centered top sheets for quick input (palette ⌘K/F1, new-session name); modal sheet for
  Settings (sections, `Row`, `Segmented` radio groups with arrow keys, `Toggle`, `Stepper`); pills (footer "Update
  ready", dictation pill); state chips; context menus everywhere (Shift+F10 too); toasts for non-blocking notices.
- **Icons:** `components/Icon.tsx`, 20×20 viewBox, stroked, round caps/joins; file icons in `FileIcon.tsx`.
- **Copy:** UI in English, short, sentence case for labels, Title Case for menu items.
- **Every new feature:** discoverable in the menu and/or palette, listed in Settings › Keyboard if it has a shortcut
  (a test keeps menu and list aligned), configurable/toggleable when it's optional, with clear empty/error states.

## Pitfalls we already hit

- A Dock/⌥⌘Esc force quit ends the app's whole **coalition**, and a process inherits its parent's: everything started
  from a terminal shared one with atelierd, so force-quitting a Chrome started there killed every session. Only
  launchd makes coalitions: atelierd and each terminal are launchd jobs. Their plists need `ProcessType Interactive`
  (left out, launchd throttles CPU/IO: priority 20 instead of 31), and a session job must **start as Atelier's
  executable** (pty-host.js, then execve to the native host): a job's first image is its TCC responsible process, and
  a bare binary loses Atelier's grants (Documents denied silently).
- Claude Code (full-screen) scrolls one line per wheel event; xterm.js sent one event per gesture → we emit one per
  line (`terminal/wheel.ts`).
- Shift+Enter → `ESC CR` only when Claude is in front (not in vim/editors); F1 and Enter-to-transcribe are captured at
  window level before xterm.
- Signing: unsigned builds break Spotlight/Finder registration and TCC grants; a Developer ID keeps the identity
  stable. The hardened runtime needs `audio-input` for dictation; Playwright attaches with `--inspect`, so that fuse
  stays on.
- Spotlight/Finder icon caches can lie after reinstalling; `lsregister -f` helps, a reboot fixes the rest.
- whisper.cpp: encoder window proportional to audio (1.5× + 256) is ~4× faster; flash attention + reduced window
  produces garbage; warm up Metal at engine start.
- Dictation vocabulary: whisper keeps the *last* prompt tokens, so the most relevant terms go last: "Claude",
  "CLAUDE.md" and "Atelier" always end the list (dictated "Claude" came out as "cloud").
- Claude accounts (`CLAUDE_CONFIG_DIR`): the default account is **never** launched with an explicit
  `CLAUDE_CONFIG_DIR` (Claude Code keys its sign-in on the dir it is given), and another account starts as
  `CLAUDE_CONFIG_DIR='<dir>' claude`, an assignment, never `env …` (that skips Atelier's zsh function and the hooks).
  Anything that reads a session's Claude files (transcripts, history, config) must use its config dir, not `~/.claude`.
