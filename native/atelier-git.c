/*
 * atelier-git: an automated session's `git` on Windows, the twin of the guard's sh script on
 * macOS (src/main/automations/guard.ts, GIT_SHIM). Main copies it to <ATELIER_HOME>\automations\guard\bin\git.exe,
 * first on the session's PATH, so every shell finds it: PowerShell, cmd and Git Bash (Claude Code's Bash tool).
 *
 * Before git reads or writes anything it refuses:
 *   - an option before the command that git.c doesn't list (so no value is taken for the command, no -C hidden);
 *   - push and send-pack, whatever the remote (a pushurl or an ssh host alias escapes pushInsteadOf);
 *   - stash, but list and show (the stash is shared with the user's checkout);
 *   - a command whose work tree (every -C, --work-tree, GIT_WORK_TREE, the current folder) is inside the project
 *     (ATELIER_RUN_PROJECT) but outside the run's worktree (ATELIER_RUN_WORKTREE), compared case-insensitively after
 *     resolving links: a fast-forward merge writes the work tree before its ref, which the hooks alone can't stop;
 *   - an explicit git folder or index (--git-dir, GIT_DIR, GIT_INDEX_FILE) inside the project but not the run's own
 *     (git sets them for hooks to the run's admin folder), whose index and HEAD would be the checkout's.
 * Then it runs the next git.exe on PATH with the arguments it read, quoted again (git parses exactly what was checked),
 * and returns its exit code. Only an absolute path to git gets around it; the hooks still hold every ref then. No
 * network, no shell, nothing written.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define BIG 32768

static void say(const WCHAR *a, const WCHAR *b, const WCHAR *c, const WCHAR *d, const WCHAR *e) {
  const WCHAR *parts[] = { a, b, c, d, e, L"\n" };
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  for (int i = 0; i < 6; i++) {
    if (!parts[i] || !*parts[i]) continue;
    int n = WideCharToMultiByte(CP_UTF8, 0, parts[i], -1, NULL, 0, NULL, NULL);
    if (n <= 1) continue;
    char *s = malloc((size_t)n);
    if (!s) return;
    WideCharToMultiByte(CP_UTF8, 0, parts[i], -1, s, n, NULL, NULL);
    DWORD wrote = 0;
    WriteFile(err, s, (DWORD)(n - 1), &wrote, NULL);
    free(s);
  }
}

static WCHAR *dup(const WCHAR *s) {
  size_t n = wcslen(s) + 1;
  WCHAR *d = malloc(n * sizeof(WCHAR));
  if (d) memcpy(d, s, n * sizeof(WCHAR));
  return d;
}

static int absolute(const WCHAR *p) {
  return (p[0] && p[1] == L':') || p[0] == L'\\' || p[0] == L'/';
}

/** `base` joined with `rel` (absolute `rel` wins). */
static WCHAR *joined(const WCHAR *base, const WCHAR *rel) {
  if (absolute(rel)) return dup(rel);
  size_t n = wcslen(base) + wcslen(rel) + 2;
  WCHAR *s = malloc(n * sizeof(WCHAR));
  if (!s) return NULL;
  wcscpy_s(s, n, base);
  wcscat_s(s, n, L"\\");
  wcscat_s(s, n, rel);
  return s;
}

/** An existing path as Windows resolves it (links followed, long names, the drive's spelling); NULL when it isn't there. */
static WCHAR *final(const WCHAR *p) {
  HANDLE h = CreateFileW(p, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (h == INVALID_HANDLE_VALUE) return NULL;
  WCHAR *out = malloc(BIG * sizeof(WCHAR));
  DWORD n = out ? GetFinalPathNameByHandleW(h, out, BIG, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) : 0;
  CloseHandle(h);
  if (n == 0 || n >= BIG) { free(out); return NULL; }
  return out;
}

/** `\\?\C:\x` → `C:\x`, `\\?\UNC\host\share` → `\\host\share`; backslashes; no trailing one. */
static void tidy(WCHAR *out) {
  if (wcsncmp(out, L"\\\\?\\UNC\\", 8) == 0) memmove(out + 2, out + 8, (wcslen(out + 8) + 1) * sizeof(WCHAR));
  else if (wcsncmp(out, L"\\\\?\\", 4) == 0) memmove(out, out + 4, (wcslen(out + 4) + 1) * sizeof(WCHAR));
  for (WCHAR *c = out; *c; c++) if (*c == L'/') *c = L'\\';
  size_t len = wcslen(out);
  while (len > 3 && out[len - 1] == L'\\') out[--len] = 0;
}

/**
 * The path as Windows resolves it. One that doesn't exist yet: its longest existing folder resolved (a short 8.3
 * name or a junction there would otherwise hide where it is), the rest as written.
 */
static WCHAR *resolved(const WCHAR *p) {
  WCHAR *full = malloc(BIG * sizeof(WCHAR));
  if (!full) return NULL;
  DWORD n = GetFullPathNameW(p, BIG, full, NULL);
  if (n == 0 || n >= BIG) wcscpy_s(full, BIG, p);
  WCHAR *out = final(full);
  if (!out) {
    WCHAR *head = dup(full);
    for (WCHAR *cut = head ? wcsrchr(head, L'\\') : NULL; cut && cut > head + 2; cut = wcsrchr(head, L'\\')) {
      *cut = 0;
      WCHAR *base = final(head);
      if (!base) continue;
      out = malloc(BIG * sizeof(WCHAR));
      if (out) { wcscpy_s(out, BIG, base); wcscat_s(out, BIG, full + (cut - head)); }
      free(base);
      break;
    }
    free(head);
  }
  if (!out) { out = full; full = NULL; }
  free(full);
  tidy(out);
  return out;
}

/** `p` is `root` or inside it (case-insensitive, as NTFS names are). */
static int inside(const WCHAR *p, const WCHAR *root) {
  size_t n = wcslen(root);
  if (_wcsnicmp(p, root, n) != 0) return 0;
  return p[n] == 0 || p[n] == L'\\' || (n > 0 && root[n - 1] == L'\\');
}

static WCHAR *env(const WCHAR *name) {
  DWORD n = GetEnvironmentVariableW(name, NULL, 0);
  if (n == 0) return NULL;
  WCHAR *v = malloc((size_t)n * sizeof(WCHAR));
  if (!v) return NULL;
  if (GetEnvironmentVariableW(name, v, n) == 0 || !*v) { free(v); return NULL; }
  return v;
}

/** The next git.exe on PATH after this program's own folder (and never this program). */
static WCHAR *realGit(void) {
  WCHAR self[BIG];
  DWORD n = GetModuleFileNameW(NULL, self, BIG);
  if (n == 0 || n >= BIG) return NULL;
  WCHAR *me = resolved(self);
  WCHAR *dir = dup(self);
  if (!me || !dir) return NULL;
  WCHAR *slash = wcsrchr(dir, L'\\');
  if (slash) *slash = 0;
  WCHAR *ownDir = resolved(dir);
  WCHAR *path = env(L"PATH");
  if (!path || !ownDir) return NULL;
  WCHAR *ctx = NULL;
  for (WCHAR *d = wcstok_s(path, L";", &ctx); d; d = wcstok_s(NULL, L";", &ctx)) {
    size_t len = wcslen(d);
    if (len >= 2 && d[0] == L'"' && d[len - 1] == L'"') { d[len - 1] = 0; d++; }
    if (!*d) continue;
    WCHAR *rd = resolved(d);
    if (!rd) continue;
    int own = _wcsicmp(rd, ownDir) == 0;
    free(rd);
    if (own) continue;
    WCHAR *candidate = joined(d, L"git.exe");
    if (!candidate) continue;
    DWORD a = GetFileAttributesW(candidate);
    if (a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY)) {
      WCHAR *rc = resolved(candidate);
      int same = rc && _wcsicmp(rc, me) == 0;
      free(rc);
      if (!same) return candidate;
    }
    free(candidate);
  }
  return NULL;
}

/**
 * One argument as a Windows command line carries it (the rules CommandLineToArgvW and the C runtimes share): quoted
 * when it holds a space, tab or quote or is empty; a quote escaped, the backslashes before it doubled. `out` NULL:
 * only counts. Git then reads exactly the argument this program checked.
 */
static size_t quoteArg(WCHAR *out, const WCHAR *a) {
  size_t n = 0;
#define PUT(c) do { if (out) out[n] = (c); n++; } while (0)
  if (*a && !wcspbrk(a, L" \t\n\v\"")) { for (; *a; a++) PUT(*a); return n; }
  PUT(L'"');
  for (;;) {
    size_t slashes = 0;
    while (*a == L'\\') { slashes++; a++; }
    if (!*a) { for (size_t i = 0; i < slashes * 2; i++) PUT(L'\\'); break; }
    if (*a == L'"') { for (size_t i = 0; i < slashes * 2 + 1; i++) PUT(L'\\'); PUT(L'"'); }
    else { for (size_t i = 0; i < slashes; i++) PUT(L'\\'); PUT(*a); }
    a++;
  }
  PUT(L'"');
#undef PUT
  return n;
}

/** The run's own git folder: <worktree>\.git, or the folder its .git file names ("gitdir: …"); NULL when unknown. */
static WCHAR *adminDir(const WCHAR *wt) {
  WCHAR *dotgit = joined(wt, L".git");
  if (!dotgit) return NULL;
  DWORD a = GetFileAttributesW(dotgit);
  if (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) { WCHAR *r = resolved(dotgit); free(dotgit); return r; }
  HANDLE h = CreateFileW(dotgit, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
  free(dotgit);
  if (h == INVALID_HANDLE_VALUE) return NULL;
  char buf[4096];
  DWORD got = 0;
  BOOL ok = ReadFile(h, buf, sizeof buf - 1, &got, NULL);
  CloseHandle(h);
  if (!ok || got < 8 || strncmp(buf, "gitdir: ", 8) != 0) return NULL;
  buf[got] = 0;
  char *end = buf + 8;
  while (*end && *end != '\r' && *end != '\n') end++;
  *end = 0;
  WCHAR path[4096];
  if (!MultiByteToWideChar(CP_UTF8, 0, buf + 8, -1, path, 4096)) return NULL;
  WCHAR *full = joined(wt, path);
  WCHAR *r = full ? resolved(full) : NULL;
  free(full);
  return r;
}

static int is(const WCHAR *a, const WCHAR *const *list) {
  for (; *list; list++) if (wcscmp(a, *list) == 0) return 1;
  return 0;
}
static int startsWithAny(const WCHAR *a, const WCHAR *const *list) {
  for (; *list; list++) if (wcsncmp(a, *list, wcslen(*list)) == 0) return 1;
  return 0;
}

/* git's own options before the command (git.c): those taking the next argument, those written with =, those alone. */
static const WCHAR *const WITH_VALUE[] = { L"-c", L"--namespace", L"--config-env", L"--super-prefix", L"--attr-source", L"--shallow-file", NULL };
static const WCHAR *const WITH_EQUALS[] = { L"--namespace=", L"--config-env=", L"--super-prefix=", L"--attr-source=", L"--exec-path=", L"--list-cmds=", NULL };
static const WCHAR *const ALONE[] = { L"-p", L"--paginate", L"-P", L"--no-pager", L"--no-replace-objects", L"--no-lazy-fetch", L"--no-optional-locks",
  L"--no-advice", L"--bare", L"--literal-pathspecs", L"--glob-pathspecs", L"--noglob-pathspecs", L"--icase-pathspecs", L"--html-path",
  L"--man-path", L"--info-path", L"-v", L"--version", L"-h", L"--help", L"--exec-path", NULL };

static BOOL WINAPI keepRunning(DWORD type) {
  /* Ctrl+C reaches git too (same console): this process waits for it to end rather than dying first. */
  return type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT;
}

int wmain(int argc, WCHAR **argv) {
  WCHAR cwd[BIG];
  DWORD n = GetCurrentDirectoryW(BIG, cwd);
  WCHAR *dir = dup(n > 0 && n < BIG ? cwd : L".");
  WCHAR *tree = env(L"GIT_WORK_TREE");
  WCHAR *gitdir = env(L"GIT_DIR");
  WCHAR *index = env(L"GIT_INDEX_FILE");
  const WCHAR *sub = NULL, *sub2 = NULL;
  enum { NONE, C, TREE, GITDIR, SKIP } next = NONE;
  for (int i = 1; i < argc; i++) {
    const WCHAR *a = argv[i];
    if (sub) { sub2 = a; break; }
    if (next != NONE) {
      if (next == C) { WCHAR *d = joined(dir, a); if (d) { free(dir); dir = d; } }
      else if (next == TREE) { free(tree); tree = dup(a); }
      else if (next == GITDIR) { free(gitdir); gitdir = dup(a); }
      next = NONE;
      continue;
    }
    if (wcscmp(a, L"-C") == 0) next = C;
    else if (wcsncmp(a, L"--work-tree=", 12) == 0) { free(tree); tree = dup(a + 12); }
    else if (wcscmp(a, L"--work-tree") == 0) next = TREE;
    else if (wcsncmp(a, L"--git-dir=", 10) == 0) { free(gitdir); gitdir = dup(a + 10); }
    else if (wcscmp(a, L"--git-dir") == 0) next = GITDIR;
    else if (is(a, WITH_VALUE)) next = SKIP;
    else if (startsWithAny(a, WITH_EQUALS) || is(a, ALONE)) { /* an option git takes */ }
    else if (a[0] == L'-') {
      say(L"Atelier: an automated session's git doesn't take ", a, L" before its command.", NULL, NULL);
      return 1;
    }
    else sub = a;
  }
  /* Case-insensitive: Windows finds git-PUSH.exe for "PUSH". */
  if (sub && (_wcsicmp(sub, L"push") == 0 || _wcsicmp(sub, L"send-pack") == 0)) {
    say(L"Atelier: automated sessions never push. Push from Atelier's Source Control.", NULL, NULL, NULL, NULL);
    return 1;
  }
  if (sub && _wcsicmp(sub, L"stash") == 0 && !(sub2 && (_wcsicmp(sub2, L"list") == 0 || _wcsicmp(sub2, L"show") == 0))) {
    say(L"Atelier: an automated session doesn't use git stash: the stash is shared with your checkout. Commit work in progress on the run's branch instead.", NULL, NULL, NULL, NULL);
    return 1;
  }
  WCHAR *wtEnv = env(L"ATELIER_RUN_WORKTREE"), *projEnv = env(L"ATELIER_RUN_PROJECT");
  if (wtEnv && projEnv) {
    WCHAR *target = tree ? joined(dir, tree) : dup(dir);
    WCHAR *t = target ? resolved(target) : NULL, *wt = resolved(wtEnv), *proj = resolved(projEnv);
    if (t && wt && proj && !inside(t, wt) && inside(t, proj)) {
      say(L"Atelier: an automated session works only in its own worktree (", wt, L"), not in ", t, L". Merging is up to you, from Atelier's Source Control.");
      return 1;
    }
    WCHAR *admin = wt ? adminDir(wt) : NULL;
    const WCHAR *explicit[] = { gitdir, index };
    for (int i = 0; i < 2; i++) {
      if (!explicit[i] || !proj) continue;
      WCHAR *full = joined(dir, explicit[i]);
      WCHAR *g = full ? resolved(full) : NULL;
      if (g && inside(g, proj) && !(admin && inside(g, admin))) {
        say(L"Atelier: an automated session uses only its own worktree's git folder, not ", g, L".", NULL, NULL);
        return 1;
      }
    }
  }
  WCHAR *real = realGit();
  if (!real) {
    say(L"Atelier: git isn't available in this automated session.", NULL, NULL, NULL, NULL);
    return 127;
  }
  /* The command line again, from the arguments read above: git parses exactly what was checked. */
  size_t len = quoteArg(NULL, real) + 1;
  for (int i = 1; i < argc; i++) len += quoteArg(NULL, argv[i]) + 1;
  WCHAR *line = malloc((len + 1) * sizeof(WCHAR));
  if (!line) return 1;
  size_t at = quoteArg(line, real);
  for (int i = 1; i < argc; i++) { line[at++] = L' '; at += quoteArg(line + at, argv[i]); }
  line[at] = 0;
  SetConsoleCtrlHandler(keepRunning, TRUE);
  STARTUPINFOW si;
  GetStartupInfoW(&si);
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(real, line, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    say(L"Atelier: couldn't run ", real, NULL, NULL, NULL);
    return 127;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return (int)code;
}
