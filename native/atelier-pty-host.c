// atelier-pty-host: starts one terminal's shell on a PTY that atelierd opened.
//
// atelierd keeps the PTY master; this host runs as the session's own launchd job (its own coalition, so a force quit
// of an app started in this session ends this session only). It is reached through execve() from Atelier's own
// executable (pty-host.js), so the job's responsible process, and the privacy grants that go with it, stay Atelier's.
//
//   atelier-pty-host 1 <socket> <token> <slave> <cwd> <file> [args...]   (environment = the shell's environment)
//   atelier-pty-host --coalition <pid>                                   prints "<resource> <jetsam>" (diagnostics)
//
// The child does what node-pty's spawn did for a terminal until now: same termios, default signal dispositions and an
// empty mask, only fds 0-2 open, chdir, execvp. Unlike node-pty's spawn-helper it creates its own session and takes
// the slave as its controlling terminal explicitly (a launchd job's open() doesn't). The parent reports
// {"t":"hello"} as soon as it connects, then {"t":"started"} and {"t":"exit"} to atelierd on <socket>, and exits with
// the shell's status.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#define HOST_PROTO "1"

// xnu's coalition info flavor (bsd/sys/proc_info_private.h): not in the public SDK. Used for diagnostics and tests
// only; when it fails the host reports 0 and nothing else changes.
#define ATL_PROC_PIDCOALITIONINFO 20
struct atl_pidcoalitioninfo { uint64_t coalition_id[2]; uint64_t reserved[3]; };

static int coalition_of(pid_t pid, unsigned long long out[2]) {
  struct atl_pidcoalitioninfo info;
  memset(&info, 0, sizeof info);
  if (proc_pidinfo(pid, ATL_PROC_PIDCOALITIONINFO, 0, &info, sizeof info) != (int)sizeof info) return -1;
  out[0] = info.coalition_id[0];
  out[1] = info.coalition_id[1];
  return 0;
}

static int valid_token(const char *t) {
  size_t n = strlen(t);
  if (n == 0 || n > 64) return 0;
  for (size_t i = 0; i < n; i++) if (!((t[i] >= '0' && t[i] <= '9') || (t[i] >= 'a' && t[i] <= 'f'))) return 0;
  return 1;
}

static int connect_report(const char *path) {
  struct sockaddr_un addr;
  if (strlen(path) >= sizeof addr.sun_path) return -1;
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (s < 0) return -1;
  fcntl(s, F_SETFD, FD_CLOEXEC);
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof addr.sun_path - 1);
  if (connect(s, (struct sockaddr *)&addr, sizeof addr) != 0) { close(s); return -1; }
  return s;
}

static void send_line(int s, const char *line) {
  if (s < 0) return;
  size_t left = strlen(line);
  while (left > 0) {
    ssize_t w = write(s, line, left);
    if (w < 0) { if (errno == EINTR) continue; return; }
    line += w;
    left -= (size_t)w;
  }
}

// node-pty 1.1.0's PtyFork termios (src/unix/pty.cc), utf8 on: a terminal behaves exactly as before.
static void node_pty_termios(struct termios *t) {
  memset(t, 0, sizeof *t);
  t->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT | IUTF8;
  t->c_oflag = OPOST | ONLCR;
  t->c_cflag = CREAD | CS8 | HUPCL;
  t->c_lflag = ICANON | ISIG | IEXTEN | ECHO | ECHOE | ECHOK | ECHOKE | ECHOCTL;
  t->c_cc[VEOF] = 4;
  t->c_cc[VEOL] = -1;
  t->c_cc[VEOL2] = -1;
  t->c_cc[VERASE] = 0x7f;
  t->c_cc[VWERASE] = 23;
  t->c_cc[VKILL] = 21;
  t->c_cc[VREPRINT] = 18;
  t->c_cc[VINTR] = 3;
  t->c_cc[VQUIT] = 0x1c;
  t->c_cc[VSUSP] = 26;
  t->c_cc[VSTART] = 17;
  t->c_cc[VSTOP] = 19;
  t->c_cc[VLNEXT] = 22;
  t->c_cc[VDISCARD] = 15;
  t->c_cc[VMIN] = 1;
  t->c_cc[VTIME] = 0;
  t->c_cc[VDSUSP] = 25;
  t->c_cc[VSTATUS] = 20;
  cfsetispeed(t, B38400);
  cfsetospeed(t, B38400);
}

// Every inherited descriptor above stderr (whatever launchd or Atelier's runtime left open) is closed when the shell
// starts: it gets fds 0-2 only, as with node-pty. Done in the parent, from the kernel's list of open fds.
static void cloexec_inherited(void) {
  int size = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
  if (size <= 0) return;
  struct proc_fdinfo *fds = malloc((size_t)size);
  if (!fds) return;
  int n = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, size) / (int)sizeof(struct proc_fdinfo);
  for (int i = 0; i < n; i++) if (fds[i].proc_fd > 2) fcntl(fds[i].proc_fd, F_SETFD, fcntl(fds[i].proc_fd, F_GETFD) | FD_CLOEXEC);
  free(fds);
}

// In the child, between fork and exec: only async-signal-safe calls. Never returns.
static void run_child(const char *slave, const char *cwd, char *const argv[], int err_fd) {
  sigset_t all;
  sigemptyset(&all);
  sigprocmask(SIG_SETMASK, &all, NULL);
  struct sigaction dfl;
  memset(&dfl, 0, sizeof dfl);
  dfl.sa_handler = SIG_DFL;
  for (int sig = 1; sig < NSIG; sig++) if (sig != SIGKILL && sig != SIGSTOP) sigaction(sig, &dfl, NULL);

  int code = 0;
  if (setsid() < 0) { code = 10; goto fail; }
  int fd = open(slave, O_RDWR);
  if (fd < 0) { code = 11; goto fail; }
  if (ioctl(fd, TIOCSCTTY, 0) < 0) { code = 12; goto fail; }
  struct termios t;
  node_pty_termios(&t);
  if (tcsetattr(fd, TCSANOW, &t) < 0) { code = 13; goto fail; }
  if (dup2(fd, 0) < 0 || dup2(fd, 1) < 0 || dup2(fd, 2) < 0) { code = 14; goto fail; }
  if (fd > 2) close(fd);
  if (cwd[0] && chdir(cwd) != 0) { code = 15; goto fail; }
  execvp(argv[0], argv);
  code = 16;
fail:;
  int e[2] = { code, errno };
  (void)!write(err_fd, e, sizeof e);
  _exit(1);
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--coalition") == 0) {
    unsigned long long c[2];
    if (coalition_of((pid_t)atoi(argv[2]), c) != 0) return 1;
    printf("%llu %llu\n", c[0], c[1]);
    return 0;
  }
  if (argc < 7 || strcmp(argv[1], HOST_PROTO) != 0 || !valid_token(argv[3])) {
    fprintf(stderr, "atelier-pty-host: usage: atelier-pty-host " HOST_PROTO " <socket> <token> <slave> <cwd> <file> [args...]\n");
    return 64;
  }
  const char *sock = argv[2], *token = argv[3], *slave = argv[4], *cwd = argv[5];
  signal(SIGPIPE, SIG_IGN);
  cloexec_inherited();
  // An inherited ignored SIGCHLD could make waitpid lose the shell's status: the default, explicitly.
  signal(SIGCHLD, SIG_DFL);
  int s = connect_report(sock);
  if (s < 0) { fprintf(stderr, "atelier-pty-host: cannot reach atelierd (%s)\n", strerror(errno)); return 69; }
  char line[512];
  // Said at once: the connection is this terminal's from now on, however long fork and exec take under load.
  snprintf(line, sizeof line, "{\"t\":\"hello\",\"token\":\"%s\"}\n", token);
  send_line(s, line);

  // Exec failures come back on a close-on-exec pipe: nothing arrives when the shell starts.
  int errp[2];
  if (pipe(errp) != 0) return 71;
  fcntl(errp[0], F_SETFD, FD_CLOEXEC);
  fcntl(errp[1], F_SETFD, FD_CLOEXEC);
  pid_t pid = fork();
  if (pid < 0) return 71;
  if (pid == 0) run_child(slave, cwd, &argv[6], errp[1]);
  close(errp[1]);

  int e[2];
  ssize_t got;
  do got = read(errp[0], e, sizeof e); while (got < 0 && errno == EINTR);
  close(errp[0]);
  if (got == (ssize_t)sizeof e) {
    snprintf(line, sizeof line, "{\"t\":\"failed\",\"step\":%d,\"errno\":%d}\n", e[0], e[1]);
    send_line(s, line);
    int st;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
    close(s);
    return 1;
  }

  unsigned long long c[2] = { 0, 0 };
  coalition_of(pid, c);
  snprintf(line, sizeof line, "{\"t\":\"started\",\"pid\":%d,\"coalition\":%llu}\n", (int)pid, c[0]);
  send_line(s, line);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) { status = 0; break; }
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : 0;
  int sig = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  snprintf(line, sizeof line, "{\"t\":\"exit\",\"code\":%d,\"signal\":%d}\n", code, sig);
  send_line(s, line);
  close(s);
  return sig ? 128 + sig : code;
}
