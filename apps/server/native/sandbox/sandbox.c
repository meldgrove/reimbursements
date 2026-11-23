/*
 * The document sandbox's Node add-on.
 *
 * lockdown()  installs the seccomp deny-list of the Django version
 *             (portal/document_sandbox.py) for every thread of the process
 *             (TSYNC), after checking that the launcher's Landlock rules are
 *             in force. A denied system call fails with EPERM. Called by the
 *             document child before it loads any parser.
 * flock(fd, mode)  "shared", "exclusive" or "unlock": the workspace locks
 *             of services/capacity.ts, which Node has no API for. Never
 *             blocks (the event loop must not wait): returns false when
 *             another holder prevents the lock; the caller tries again.
 * probe(name, pid)  performs one raw system call and returns its errno (0 on
 *             success); only the sandbox tests use it.
 *
 * libseccomp is loaded when lockdown() runs (dlopen), so the add-on builds
 * without its headers and loads where it is missing; lockdown() then fails
 * closed.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif

static const char *DENIED_SYSCALLS[] = {
    "socket", "socketpair", "connect", "bind", "listen", "accept", "accept4", "ptrace",
    "process_vm_readv", "process_vm_writev", "pidfd_getfd", "pidfd_open", "pidfd_send_signal",
    "prlimit64", "setpriority", "sched_setparam", "sched_setscheduler", "sched_setattr",
    "sched_setaffinity", "ioprio_set", "flock", "open_by_handle_at", "mount", "umount2",
    "pivot_root", "chroot", "unshare", "setns", "execve", "execveat", "setsid", "setpgid",
    "kill", "tkill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo", "chmod", "fchmod",
    "fchmodat", "fchmodat2", "chown", "fchown", "lchown", "fchownat", "setxattr", "lsetxattr",
    "fsetxattr", "removexattr", "lremovexattr", "fremovexattr", "utime", "utimes", "futimesat",
    "utimensat", "bpf", "keyctl", "io_uring_setup",
};

/* libseccomp's ABI (seccomp.h): actions and filter attributes. */
#define SCMP_ACT_ALLOW 0x7fff0000U
#define SCMP_ACT_ERRNO(x) (0x00050000U | ((x) & 0x0000ffffU))
#define SCMP_FLTATR_CTL_TSYNC 4

typedef void *(*seccomp_init_t)(uint32_t);
typedef int (*seccomp_syscall_resolve_name_t)(const char *);
typedef int (*seccomp_rule_add_t)(void *, uint32_t, int, unsigned int, ...);
typedef int (*seccomp_attr_set_t)(void *, int, uint32_t);
typedef int (*seccomp_load_t)(void *);
typedef void (*seccomp_release_t)(void *);

static napi_value throw_code(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return NULL;
}

static napi_value undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static const char *install_filter(void) {
  void *library = dlopen("libseccomp.so.2", RTLD_NOW | RTLD_LOCAL);
  if (!library) return "seccomp_unavailable";
  seccomp_init_t init = (seccomp_init_t)dlsym(library, "seccomp_init");
  seccomp_syscall_resolve_name_t resolve =
      (seccomp_syscall_resolve_name_t)dlsym(library, "seccomp_syscall_resolve_name");
  seccomp_rule_add_t rule_add = (seccomp_rule_add_t)dlsym(library, "seccomp_rule_add");
  seccomp_attr_set_t attr_set = (seccomp_attr_set_t)dlsym(library, "seccomp_attr_set");
  seccomp_load_t load = (seccomp_load_t)dlsym(library, "seccomp_load");
  seccomp_release_t release = (seccomp_release_t)dlsym(library, "seccomp_release");
  if (!init || !resolve || !rule_add || !attr_set || !load || !release) return "seccomp_unavailable";
  void *context = init(SCMP_ACT_ALLOW);
  if (!context) return "seccomp_init";
  const char *error = NULL;
  if (attr_set(context, SCMP_FLTATR_CTL_TSYNC, 1)) error = "seccomp_tsync";
  for (size_t index = 0; !error && index < sizeof(DENIED_SYSCALLS) / sizeof(*DENIED_SYSCALLS); index++) {
    int number = resolve(DENIED_SYSCALLS[index]);
    if (number >= 0 && rule_add(context, SCMP_ACT_ERRNO(EPERM), number, 0)) error = "seccomp_rule_add";
  }
  if (!error && load(context)) error = "seccomp_load";
  release(context);
  /* The library stays loaded: the filter does not need it, unloading gains nothing. */
  return error;
}

static napi_value lockdown(napi_env env, napi_callback_info info) {
  (void)info;
  /* The launcher's Landlock rules must already deny files outside the
     execution: fail closed when they do not. */
  int probe = open("/etc/passwd", O_RDONLY | O_CLOEXEC);
  if (probe >= 0) {
    close(probe);
    return throw_code(env, "landlock_not_applied");
  }
  if (errno != EACCES) return throw_code(env, "landlock_not_applied");
  /* The launcher set it; without it an unprivileged filter cannot load. */
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return throw_code(env, "no_new_privs");
  const char *error = install_filter();
  if (error) return throw_code(env, error);
  return undefined(env);
}

static int get_string(napi_env env, napi_value value, char *buffer, size_t size) {
  size_t length = 0;
  return napi_get_value_string_utf8(env, value, buffer, size, &length) == napi_ok && length < size - 1;
}

static napi_value file_lock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  char mode[16];
  if (argc < 2 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || !get_string(env, argv[1], mode, sizeof(mode)))
    return throw_code(env, "invalid_arguments");
  int operation;
  if (!strcmp(mode, "shared")) operation = LOCK_SH | LOCK_NB;
  else if (!strcmp(mode, "exclusive")) operation = LOCK_EX | LOCK_NB;
  else if (!strcmp(mode, "unlock")) operation = LOCK_UN;
  else return throw_code(env, "invalid_arguments");
  int result;
  do {
    result = flock(fd, operation);
  } while (result && errno == EINTR);
  napi_value value;
  if (result && errno == EWOULDBLOCK && (operation & LOCK_NB)) {
    napi_get_boolean(env, false, &value);
    return value;
  }
  if (result) {
    napi_throw_error(env, "flock_failed", strerror(errno));
    return NULL;
  }
  napi_get_boolean(env, true, &value);
  return value;
}

static int run_probe(const char *name, pid_t pid) {
  long result = -1;
  if (!strcmp(name, "ipv4")) result = socket(AF_INET, SOCK_STREAM, 0);
  else if (!strcmp(name, "ipv6")) result = socket(AF_INET6, SOCK_STREAM, 0);
  else if (!strcmp(name, "unix_socket")) result = socket(AF_UNIX, SOCK_STREAM, 0);
  else if (!strcmp(name, "parent_signal")) result = kill(pid, 0);
  else if (!strcmp(name, "parent_pidfd")) result = syscall(__NR_pidfd_open, pid, 0);
  else if (!strcmp(name, "parent_pidfd_signal")) result = syscall(__NR_pidfd_send_signal, -1, 0, NULL, 0);
  else if (!strcmp(name, "parent_sigqueue")) {
    union sigval value = {0};
    result = sigqueue(pid, 0, value);
  } else if (!strcmp(name, "parent_thread_sigqueue")) {
    siginfo_t signal_info;
    memset(&signal_info, 0, sizeof(signal_info));
    signal_info.si_code = SI_QUEUE;
    signal_info.si_pid = getpid();
    signal_info.si_uid = getuid();
    result = syscall(SYS_rt_tgsigqueueinfo, pid, pid, 0, &signal_info);
  } else if (!strcmp(name, "parent_limits")) {
    struct rlimit limit;
    if (getrlimit(RLIMIT_NOFILE, &limit)) return errno;
    result = prlimit(pid, RLIMIT_NOFILE, &limit, NULL);
  } else if (!strcmp(name, "parent_priority")) result = setpriority(PRIO_PROCESS, (id_t)pid, 0);
  else if (!strcmp(name, "parent_affinity")) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(0, &set);
    result = sched_setaffinity(pid, sizeof(set), &set);
  } else if (!strcmp(name, "parent_scheduler")) {
    struct sched_param parameter = {0};
    result = sched_setscheduler(pid, SCHED_OTHER, &parameter);
  } else if (!strcmp(name, "parent_schedparam")) {
    struct sched_param parameter = {0};
    result = sched_setparam(pid, &parameter);
  } else if (!strcmp(name, "exec")) {
    char *const arguments[] = {"/bin/true", NULL};
    char *const environment[] = {NULL};
    result = execve("/bin/true", arguments, environment);
  } else {
    errno = EINVAL;
    return -1;
  }
  if (result >= 0) {
    if (!strncmp(name, "ipv", 3) || !strcmp(name, "unix_socket") || !strcmp(name, "parent_pidfd")) close((int)result);
    return 0;
  }
  return errno;
}

static napi_value probe(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[64];
  int32_t pid = 0;
  if (argc < 2 || !get_string(env, argv[0], name, sizeof(name)) || napi_get_value_int32(env, argv[1], &pid) != napi_ok)
    return throw_code(env, "invalid_arguments");
  int code = run_probe(name, (pid_t)pid);
  if (code < 0) return throw_code(env, "unknown_probe");
  napi_value value;
  napi_create_int32(env, code, &value);
  return value;
}

static napi_value create_function(napi_env env, napi_value exports, const char *name, napi_callback callback) {
  napi_value function;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function);
  napi_set_named_property(env, exports, name, function);
  return exports;
}

NAPI_MODULE_INIT() {
  create_function(env, exports, "lockdown", lockdown);
  create_function(env, exports, "flock", file_lock);
  create_function(env, exports, "probe", probe);
  return exports;
}
