/*
 * The document sandbox's launcher: confines a process before it starts, then
 * executes it.
 *
 * Linux Landlock (ABI 3+) restricts the files a process may use. A ruleset
 * applies to the thread that installs it and to threads and processes it
 * creates later. Node starts its platform threads before any add-on can run,
 * so the rules are installed here, while this process has a single thread, and
 * survive the execve of node. The seccomp filter follows inside node
 * (sandbox.c, lockdown()), which filters every thread at once (TSYNC).
 *
 *   launcher [--limit NAME=VALUE]... [--read PATH]... [--read-file PATH]...
 *            [--exec PATH]... --write DIR -- PROGRAM [ARGUMENT]...
 *
 * --limit    a resource limit: as, data, cpu, fsize or nofile (soft and hard)
 * --read     read a directory tree or a file (runtime: libraries, node_modules)
 * --read-file  read one file (an input of this execution)
 * --exec     read and execute (the node binary and the ELF interpreter)
 * --write    the execution's workspace: create, write, remove inside it
 *
 * The process is also the first the kernel's OOM killer picks (oom_score_adj
 * 1000), so memory pressure in the worker container ends the parser, not the
 * worker. /dev/null is always readable and writable. Every failure exits with 125
 * before PROGRAM runs: the sandbox fails closed. No privileges, namespaces or
 * Docker seccomp exceptions are needed.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

#define EXECUTE (1ULL << 0)
#define WRITE_FILE (1ULL << 1)
#define READ_FILE (1ULL << 2)
#define READ_DIR (1ULL << 3)
#define REMOVE_DIR (1ULL << 4)
#define REMOVE_FILE (1ULL << 5)
#define MAKE_DIR (1ULL << 7)
#define MAKE_REG (1ULL << 8)
#define REFER (1ULL << 13)
#define TRUNCATE (1ULL << 14)
/* Every file system right of Landlock ABI 1 to 3. */
#define HANDLED ((1ULL << 15) - 1)
#define READ (READ_FILE | READ_DIR)
#define WRITE (READ | WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_DIR | MAKE_REG | REFER | TRUNCATE)

#define MAX_RULES 256

struct rule {
  const char *path;
  uint64_t access;
};

static void fail(const char *step) {
  fprintf(stderr, "sandbox launcher: %s: %s\n", step, strerror(errno));
  _exit(125);
}

static void usage(const char *message) {
  fprintf(stderr, "sandbox launcher: %s\n", message);
  _exit(125);
}

static void set_limit(const char *spec) {
  const char *equals = strchr(spec, '=');
  if (!equals) usage("--limit needs NAME=VALUE");
  size_t length = (size_t)(equals - spec);
  int resource;
  if (length == 2 && !strncmp(spec, "as", 2)) resource = RLIMIT_AS;
  else if (length == 4 && !strncmp(spec, "data", 4)) resource = RLIMIT_DATA;
  else if (length == 3 && !strncmp(spec, "cpu", 3)) resource = RLIMIT_CPU;
  else if (length == 5 && !strncmp(spec, "fsize", 5)) resource = RLIMIT_FSIZE;
  else if (length == 6 && !strncmp(spec, "nofile", 6)) resource = RLIMIT_NOFILE;
  else usage("unknown --limit");
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(equals + 1, &end, 10);
  if (errno || !end || *end || end == equals + 1) usage("invalid --limit value");
  struct rlimit limit = {.rlim_cur = (rlim_t)value, .rlim_max = (rlim_t)value};
  if (setrlimit(resource, &limit)) fail("setrlimit");
}

static void add_rule(int ruleset, const struct rule *rule) {
  int fd = open(rule->path, O_PATH | O_CLOEXEC);
  if (fd < 0) fail(rule->path);
  struct stat info;
  if (fstat(fd, &info)) fail("fstat");
  uint64_t access = rule->access;
  if (!S_ISDIR(info.st_mode)) {
    /* Rights on a file must be file rights only. */
    access &= EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE;
  }
  struct landlock_path_beneath_attr attr = {.allowed_access = access, .parent_fd = fd};
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &attr, 0)) fail("landlock_add_rule");
  close(fd);
}

int main(int argc, char **argv) {
  static struct rule rules[MAX_RULES];
  int count = 0, index = 1, workspace = 0;
  for (; index < argc; index++) {
    const char *option = argv[index];
    if (!strcmp(option, "--")) {
      index++;
      break;
    }
    if (index + 1 >= argc) usage("option without value");
    const char *value = argv[++index];
    if (!strcmp(option, "--limit")) {
      set_limit(value);
      continue;
    }
    if (count >= MAX_RULES - 1) usage("too many paths");
    if (!strcmp(option, "--read")) rules[count++] = (struct rule){value, READ};
    else if (!strcmp(option, "--read-file")) rules[count++] = (struct rule){value, READ_FILE};
    else if (!strcmp(option, "--exec")) rules[count++] = (struct rule){value, READ_FILE | EXECUTE};
    else if (!strcmp(option, "--write")) {
      rules[count++] = (struct rule){value, WRITE};
      workspace = 1;
    } else usage("unknown option");
  }
  if (index >= argc) usage("no program");
  if (!workspace) usage("--write is required");
  rules[count++] = (struct rule){"/dev/null", READ_FILE | WRITE_FILE};

  int oom = open("/proc/self/oom_score_adj", O_WRONLY | O_CLOEXEC);
  if (oom >= 0) {
    /* Best effort: raising one's own score needs no privilege, a missing /proc is no reason to stop. */
    if (write(oom, "1000", 4) != 4) errno = 0;
    close(oom);
  }

  int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) {
    errno = abi < 0 ? errno : ENOSYS;
    fail("landlock_abi_3_required");
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
  struct landlock_ruleset_attr ruleset_attr = {.handled_access_fs = HANDLED};
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &ruleset_attr, sizeof(ruleset_attr.handled_access_fs), 0);
  if (ruleset < 0) fail("landlock_create_ruleset");
  for (int rule = 0; rule < count; rule++) add_rule(ruleset, &rules[rule]);
  if (syscall(__NR_landlock_restrict_self, ruleset, 0)) fail("landlock_restrict_self");
  close(ruleset);
  execv(argv[index], &argv[index]);
  fail("execv");
  return 125;
}
