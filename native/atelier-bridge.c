/*
 * atelier-bridge: Claude Code's hook and status-line bridge on Windows, the twin of the
 * atelier-hook and atelier-statusline sh scripts on macOS. Claude Code runs it from an Atelier terminal:
 *
 *   atelier-bridge hook     one hook event (stdin) to atelierd; prints only atelierd's reply (a session name or nothing)
 *   atelier-bridge status   the status line data (stdin) to atelierd, then the user's own status line, its output as is
 *
 * Wire, as the sh bridges: one JSON header line {"t":"hook"|"status","token":…,"term":…} and the payload, over the
 * named pipe in ATELIER_SOCK. Decides nothing for Claude and always exits 0: outside an Atelier terminal, with bad
 * variables or with atelierd away it forwards nothing, and never makes Claude wait more than ~2 s.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wctype.h>

#define CONNECT_TRIES 40      /* ~2 s: busy instances, and the gap while libuv creates the next one */
#define REPLY_WAIT_MS 1900
#define MAX_INPUT (16 * 1024 * 1024)

static char *read_all(HANDLE h, DWORD *out_len) {
  DWORD cap = 65536, len = 0, got;
  char *buf = malloc(cap);
  if (!buf) { *out_len = 0; return NULL; }
  for (;;) {
    if (len == cap) {
      if (cap >= MAX_INPUT) break;
      char *bigger = realloc(buf, cap * 2);
      if (!bigger) break;
      buf = bigger;
      cap *= 2;
    }
    if (!ReadFile(h, buf + len, cap - len, &got, NULL) || got == 0) break;
    len += got;
  }
  *out_len = len;
  return buf;
}

/* The same checks as the sh bridges: a uuid-like terminal id, a hex token. */
static int only(const char *s, const char *allowed) {
  if (!*s) return 0;
  for (; *s; s++) if (!strchr(allowed, *s)) return 0;
  return 1;
}

static int env(const char *name, char *out, DWORD size) {
  DWORD n = GetEnvironmentVariableA(name, out, size);
  return n > 0 && n < size;
}

static HANDLE connect_pipe(const char *pipe) {
  for (int i = 0; i < CONNECT_TRIES; i++) {
    HANDLE p = CreateFileA(pipe, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (p != INVALID_HANDLE_VALUE) return p;
    DWORD err = GetLastError();
    if (err == ERROR_PIPE_BUSY) WaitNamedPipeA(pipe, 50);
    else if (err == ERROR_FILE_NOT_FOUND) Sleep(50);
    else break;
  }
  return INVALID_HANDLE_VALUE;
}

static void write_all(HANDLE h, const char *data, DWORD len) {
  DWORD w;
  while (len > 0 && WriteFile(h, data, len, &w, NULL) && w > 0) { data += w; len -= w; }
}

/* atelierd's reply, until it closes the pipe; never waits past the deadline (Claude must not hang on us). */
static void relay_reply(HANDLE p, int print) {
  DWORD start = GetTickCount();
  char buf[4096];
  for (;;) {
    DWORD avail = 0;
    if (!PeekNamedPipe(p, NULL, 0, NULL, &avail, NULL)) break; /* closed: done */
    if (avail == 0) {
      if (GetTickCount() - start > REPLY_WAIT_MS) break;
      Sleep(5);
      continue;
    }
    DWORD got = 0;
    if (!ReadFile(p, buf, avail < sizeof buf ? avail : sizeof buf, &got, NULL) || got == 0) break;
    if (print) write_all(GetStdHandle(STD_OUTPUT_HANDLE), buf, got);
  }
}

static void forward(const char *kind, const char *in, DWORD in_len, int print_reply) {
  char pipe[256], token[160], term[80];
  if (!env("ATELIER_SOCK", pipe, sizeof pipe) || strncmp(pipe, "\\\\.\\pipe\\", 9) != 0) return;
  if (!env("ATELIER_HOOK_TOKEN", token, sizeof token) || !only(token, "0123456789abcdef")) return;
  if (!env("ATELIER_TERMINAL_ID", term, sizeof term) || !only(term, "0123456789abcdef-")) return;
  HANDLE p = connect_pipe(pipe);
  if (p == INVALID_HANDLE_VALUE) return;
  char header[400];
  int n = snprintf(header, sizeof header, "{\"t\":\"%s\",\"token\":\"%s\",\"term\":\"%s\"}\n", kind, token, term);
  if (n > 0 && n < (int)sizeof header) {
    write_all(p, header, (DWORD)n);
    write_all(p, in, in_len);
    relay_reply(p, print_reply);
  }
  CloseHandle(p);
}

static int is_file(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

/* bash.exe two folders up from a git.exe, as Claude Code looks for it (Git\cmd\git.exe → Git\bin\bash.exe). */
static int bash_near_git(const wchar_t *git, wchar_t *out, DWORD cap) {
  wchar_t rel[MAX_PATH + 32];
  if (_snwprintf_s(rel, MAX_PATH + 32, _TRUNCATE, L"%s\\..\\..\\bin\\bash.exe", git) < 0) return 0;
  DWORD n = GetFullPathNameW(rel, cap, out, NULL);
  return n > 0 && n < cap && is_file(out);
}

/* A drive path (C:\…) or a UNC one: a relative PATH entry (".", "tools\git\cmd") resolves in the project's folder. */
static int is_absolute(const wchar_t *p) {
  return (iswalpha(p[0]) && p[1] == L':' && (p[2] == L'\\' || p[2] == L'/')) || (p[0] == L'\\' && p[1] == L'\\');
}

/*
 * Git Bash as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH, where Git for Windows installs (Program Files, or the
 * user's AppData for a per-user install), else next to the git on PATH. The fixed places first: the status line runs on
 * every refresh, and a PATH entry on a disconnected drive can take seconds to answer. PATH is walked by hand, absolute
 * entries only: unlike SearchPath, never the current folder (the project's).
 */
static int find_bash(wchar_t *out, DWORD cap) {
  DWORD n = GetEnvironmentVariableW(L"CLAUDE_CODE_GIT_BASH_PATH", out, cap);
  if (n > 0 && n < cap && is_file(out)) return 1;
  static const wchar_t *const places[][2] = {
    { L"ProgramFiles", L"\\Git\\bin\\bash.exe" }, { L"LOCALAPPDATA", L"\\Programs\\Git\\bin\\bash.exe" }
  };
  for (size_t i = 0; i < sizeof places / sizeof places[0]; i++) {
    wchar_t base[MAX_PATH];
    DWORD bn = GetEnvironmentVariableW(places[i][0], base, MAX_PATH);
    if (bn > 0 && bn < MAX_PATH && _snwprintf_s(out, cap, _TRUNCATE, L"%s%s", base, places[i][1]) >= 0 && is_file(out)) return 1;
  }
  DWORD pn = GetEnvironmentVariableW(L"PATH", NULL, 0);
  wchar_t *path = pn > 0 ? calloc(pn, sizeof(wchar_t)) : NULL;
  int found = 0;
  if (path && GetEnvironmentVariableW(L"PATH", path, pn) < pn) {
    wchar_t *ctx = NULL;
    for (wchar_t *dir = wcstok_s(path, L";", &ctx); dir && !found; dir = wcstok_s(NULL, L";", &ctx)) {
      wchar_t git[MAX_PATH];
      if (!is_absolute(dir)) continue;
      size_t len = wcslen(dir);
      while (len > 3 && (dir[len - 1] == L'\\' || dir[len - 1] == L'/')) dir[--len] = 0;
      if (_snwprintf_s(git, MAX_PATH, _TRUNCATE, L"%s\\git.exe", dir) < 0 || !is_file(git)) continue;
      found = bash_near_git(git, out, cap);
    }
  }
  free(path);
  return found;
}

/*
 * The user's own status line (its command in ATELIER_HOME\user-statusline.cmd, written by atelierd from
 * ~/.claude/settings.json), run as Claude Code would: Git Bash when it finds one, else PowerShell. The command
 * reaches the shell through a variable, never through a command line: no quoting to get wrong.
 */
static void user_status_line(const char *in, DWORD in_len) {
  wchar_t home[MAX_PATH], file[MAX_PATH + 32];
  DWORD hn = GetEnvironmentVariableW(L"ATELIER_HOME", home, MAX_PATH);
  if (hn == 0 || hn >= MAX_PATH) return;
  if (_snwprintf_s(file, MAX_PATH + 32, _TRUNCATE, L"%s\\user-statusline.cmd", home) < 0) return;
  HANDLE f = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD clen;
  char *cmd = read_all(f, &clen);
  CloseHandle(f);
  while (cmd && clen > 0 && (cmd[clen - 1] == '\n' || cmd[clen - 1] == '\r')) clen--;
  if (!cmd || clen == 0) { free(cmd); return; }
  int wlen = MultiByteToWideChar(CP_UTF8, 0, cmd, (int)clen, NULL, 0);
  wchar_t *wcmd = calloc((size_t)wlen + 1, sizeof(wchar_t));
  if (!wcmd) { free(cmd); return; }
  MultiByteToWideChar(CP_UTF8, 0, cmd, (int)clen, wcmd, wlen);
  free(cmd);
  SetEnvironmentVariableW(L"ATELIER_STATUSLINE_CMD", wcmd);
  free(wcmd);

  wchar_t sys[MAX_PATH], line[2 * MAX_PATH + 128];
  DWORD sn = GetEnvironmentVariableW(L"SystemRoot", sys, MAX_PATH);
  wchar_t bash[MAX_PATH + 32];
  if (find_bash(bash, MAX_PATH + 32)) {
    _snwprintf_s(line, 2 * MAX_PATH + 128, _TRUNCATE, L"\"%s\" -c \"eval \\\"$ATELIER_STATUSLINE_CMD\\\"\"", bash);
  } else {
    if (sn == 0 || sn >= MAX_PATH) return;
    _snwprintf_s(line, 2 * MAX_PATH + 128, _TRUNCATE,
                 L"\"%s\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -Command \"Invoke-Expression $env:ATELIER_STATUSLINE_CMD\"", sys);
  }

  SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE };
  HANDLE rd, wr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) return;
  SetHandleInformation(wr, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
  STARTUPINFOW si = { sizeof si };
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = rd;
  si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  si.hStdError = nul;
  PROCESS_INFORMATION pi;
  if (CreateProcessW(NULL, line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    CloseHandle(rd);
    write_all(wr, in, in_len);
    CloseHandle(wr);
    WaitForSingleObject(pi.hProcess, 10000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  } else {
    CloseHandle(rd);
    CloseHandle(wr);
  }
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "";
  int status = strcmp(mode, "status") == 0;
  if (!status && strcmp(mode, "hook") != 0) return 0;
  DWORD in_len = 0;
  char *in = read_all(GetStdHandle(STD_INPUT_HANDLE), &in_len);
  if (!in) return 0;
  forward(status ? "status" : "hook", in, in_len, !status);
  if (status) user_status_line(in, in_len);
  free(in);
  return 0;
}
