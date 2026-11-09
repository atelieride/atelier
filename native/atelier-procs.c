/*
 * atelier-procs: the process and TCP readings the main process needs on Windows, the twin of
 * `ps` and `lsof` on macOS. Read-only, no network, no shell; main runs it with a fixed argv (src/main/procs/exec.ts):
 *
 *   atelier-procs tree                 every process: "<pid> <ppid>" per line (ps -A -o pid=,ppid=); 0 for a parent
 *                                      pid that a later process reused
 *   atelier-procs args <pid,pid,...>   their command lines: "<pid> <command line>" (ps -o pid=,args=); others skipped
 *   atelier-procs tcp                  TCP sockets with their owner: "L <pid> <port> <image>" for one listening,
 *                                      "E <pid> <local port> <remote port>" for one established to a loopback address
 *
 * The state names are numbers from the API, never localized text (netstat prints "ABHÖREN" on a German Windows).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "iphlpapi.lib")

#define MAX_PIDS 512
#define CMDLINE_INFO 60 /* ProcessCommandLineInformation, Windows 8.1+ */

typedef LONG (NTAPI *NtQip)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef struct { USHORT Length, MaximumLength; PWSTR Buffer; } UStr;

static void put_utf8(const WCHAR *w, int wlen) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, wlen, NULL, 0, NULL, NULL);
  if (n <= 0) return;
  char *s = malloc((size_t)n);
  if (!s) return;
  WideCharToMultiByte(CP_UTF8, 0, w, wlen, s, n, NULL, NULL);
  /* One process per line: a command line holding a newline is flattened. */
  for (int i = 0; i < n; i++) if (s[i] == '\n' || s[i] == '\r') s[i] = ' ';
  fwrite(s, 1, (size_t)n, stdout);
  free(s);
}

/* When a process started (100 ns since 1601), or 0 when it can't be opened (protected, gone). */
static ULONGLONG started(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return 0;
  FILETIME created, exited, kernel, user;
  ULONGLONG t = 0;
  if (GetProcessTimes(h, &created, &exited, &kernel, &user)) t = ((ULONGLONG)created.dwHighDateTime << 32) | created.dwLowDateTime;
  CloseHandle(h);
  return t;
}

typedef struct { DWORD pid, ppid; ULONGLONG t; } Proc;

static int by_pid(const void *a, const void *b) {
  DWORD x = ((const Proc *)a)->pid, y = ((const Proc *)b)->pid;
  return x < y ? -1 : x > y;
}

/*
 * Windows keeps an orphan's parent pid after the parent exits, and pids come back fast: a new shell given that pid
 * would adopt the orphan (and show its ports). A parent that started after its child is not its parent: printed as 0.
 */
static int tree(void) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 1;
  size_t n = 0, cap = 512;
  Proc *list = malloc(cap * sizeof *list);
  if (!list) { CloseHandle(snap); return 1; }
  PROCESSENTRY32W e;
  e.dwSize = sizeof e;
  for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
    if (n == cap) {
      Proc *more = realloc(list, (cap *= 2) * sizeof *list);
      if (!more) { free(list); CloseHandle(snap); return 1; }
      list = more;
    }
    list[n].pid = e.th32ProcessID;
    list[n].ppid = e.th32ParentProcessID;
    list[n].t = started(e.th32ProcessID);
    n++;
  }
  CloseHandle(snap);
  qsort(list, n, sizeof *list, by_pid);
  for (size_t i = 0; i < n; i++) {
    DWORD ppid = list[i].ppid;
    Proc key = { 0 };
    key.pid = ppid;
    Proc *parent = ppid ? bsearch(&key, list, n, sizeof *list, by_pid) : NULL;
    if (parent && parent->t && list[i].t && parent->t > list[i].t) ppid = 0;
    printf("%lu %lu\n", list[i].pid, ppid);
  }
  free(list);
  return 0;
}

static int args(const char *list) {
  NtQip query = (NtQip)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  if (!query) return 1;
  int count = 0;
  for (const char *p = list; *p && count < MAX_PIDS; count++) {
    char *end;
    unsigned long pid = strtoul(p, &end, 10);
    if (end == p || pid == 0) return 2;
    p = *end == ',' ? end + 1 : end;
    if (*end != ',' && *end != '\0') return 2;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
    if (!h) continue;
    ULONG len = 0;
    query(h, CMDLINE_INFO, NULL, 0, &len);
    if (len > 0 && len < 1024 * 1024) {
      UStr *u = malloc(len);
      if (u && query(h, CMDLINE_INFO, u, len, &len) >= 0 && u->Buffer && u->Length > 0) {
        printf("%lu ", pid);
        put_utf8(u->Buffer, u->Length / 2);
        printf("\n");
      }
      free(u);
    }
    CloseHandle(h);
  }
  return 0;
}

static void *table(ULONG family) {
  DWORD size = 0;
  void *t = NULL;
  for (int tries = 0; tries < 4; tries++) {
    DWORD r = GetExtendedTcpTable(t, &size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0);
    if (r == NO_ERROR) return t;
    if (r != ERROR_INSUFFICIENT_BUFFER) break;
    free(t);
    t = malloc(size);
    if (!t) return NULL;
  }
  free(t);
  return NULL;
}

static unsigned port_of(DWORD p) { return ((p & 0xFF) << 8) | ((p >> 8) & 0xFF); }

/* The executable's name of a pid ("node.exe"), from one snapshot. */
static void image_of(DWORD pid, HANDLE snap, char *out, size_t size) {
  out[0] = '\0';
  PROCESSENTRY32W e;
  e.dwSize = sizeof e;
  for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
    if (e.th32ProcessID != pid) continue;
    int n = WideCharToMultiByte(CP_UTF8, 0, e.szExeFile, -1, out, (int)size, NULL, NULL);
    if (n <= 0) out[0] = '\0';
    for (char *c = out; *c; c++) if (*c == ' ' || *c == '\n') *c = '_';
    return;
  }
}

static int tcp(void) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  char image[260];
  MIB_TCPTABLE_OWNER_PID *v4 = table(AF_INET);
  if (v4) {
    for (DWORD i = 0; i < v4->dwNumEntries; i++) {
      MIB_TCPROW_OWNER_PID *r = &v4->table[i];
      if (r->dwState == MIB_TCP_STATE_LISTEN) {
        if (snap != INVALID_HANDLE_VALUE) image_of(r->dwOwningPid, snap, image, sizeof image); else image[0] = '\0';
        printf("L %lu %u %s\n", r->dwOwningPid, port_of(r->dwLocalPort), image);
      } else if (r->dwState == MIB_TCP_STATE_ESTAB && (r->dwRemoteAddr & 0xFF) == 127) {
        printf("E %lu %u %u\n", r->dwOwningPid, port_of(r->dwLocalPort), port_of(r->dwRemotePort));
      }
    }
    free(v4);
  }
  MIB_TCP6TABLE_OWNER_PID *v6 = table(AF_INET6);
  if (v6) {
    static const UCHAR loop6[16] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 };
    for (DWORD i = 0; i < v6->dwNumEntries; i++) {
      MIB_TCP6ROW_OWNER_PID *r = &v6->table[i];
      if (r->dwState == MIB_TCP_STATE_LISTEN) {
        if (snap != INVALID_HANDLE_VALUE) image_of(r->dwOwningPid, snap, image, sizeof image); else image[0] = '\0';
        printf("L %lu %u %s\n", r->dwOwningPid, port_of(r->dwLocalPort), image);
      } else if (r->dwState == MIB_TCP_STATE_ESTAB && memcmp(r->ucRemoteAddr, loop6, 16) == 0) {
        printf("E %lu %u %u\n", r->dwOwningPid, port_of(r->dwLocalPort), port_of(r->dwRemotePort));
      }
    }
    free(v6);
  }
  if (snap != INVALID_HANDLE_VALUE) CloseHandle(snap);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "tree") == 0) return tree();
  if (argc == 3 && strcmp(argv[1], "args") == 0) return args(argv[2]);
  if (argc == 2 && strcmp(argv[1], "tcp") == 0) return tcp();
  return 2;
}
