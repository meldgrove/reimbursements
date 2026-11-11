"""Linux Landlock ABI 3+ file confinement and a libseccomp syscall filter.

https://docs.kernel.org/userspace-api/landlock.html
Only this bootstrap runs before confinement; native parsers import afterwards.
No privileges, namespace capabilities or Docker seccomp exceptions are needed.
"""

import ctypes
import errno
import json
import os
import platform
import runpy
import sys
from pathlib import Path


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


READ_FILE, READ_DIR = 1 << 2, 1 << 3
WRITE_FILE, REMOVE_DIR, REMOVE_FILE = 1 << 1, 1 << 4, 1 << 5
MAKE_DIR, MAKE_REG, REFER, TRUNCATE = 1 << 7, 1 << 8, 1 << 13, 1 << 14
HANDLED = (1 << 15) - 1
READ = READ_FILE | READ_DIR
WRITE = READ | WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_DIR | MAKE_REG | REFER | TRUNCATE
DENIED_SYSCALLS = (
    "socket",
    "socketpair",
    "connect",
    "bind",
    "listen",
    "accept",
    "accept4",
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "pidfd_getfd",
    "pidfd_open",
    "pidfd_send_signal",
    "prlimit64",
    "setpriority",
    "sched_setparam",
    "sched_setscheduler",
    "sched_setattr",
    "sched_setaffinity",
    "ioprio_set",
    "flock",
    "open_by_handle_at",
    "mount",
    "umount2",
    "pivot_root",
    "chroot",
    "unshare",
    "setns",
    "execve",
    "execveat",
    "setsid",
    "setpgid",
    "kill",
    "tkill",
    "tgkill",
    "rt_sigqueueinfo",
    "rt_tgsigqueueinfo",
    "chmod",
    "fchmod",
    "fchmodat",
    "fchmodat2",
    "chown",
    "fchown",
    "lchown",
    "fchownat",
    "setxattr",
    "lsetxattr",
    "fsetxattr",
    "removexattr",
    "lremovexattr",
    "fremovexattr",
    "utime",
    "utimes",
    "futimesat",
    "utimensat",
    "bpf",
    "keyctl",
    "io_uring_setup",
)


def libraries():
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "aarch64"}:
        raise OSError("unsupported_sandbox_platform")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    if libc.syscall(444, 0, 0, 1) < 3:
        raise OSError("landlock_abi_3_required")
    seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    return libc, seccomp


def supported():
    try:
        libraries()
        return True
    except OSError:
        return False


def install(readonly, workspace):
    libc, seccomp = libraries()
    if libc.prctl(38, 1, 0, 0, 0):  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "no_new_privs")
    attr = Ruleset(HANDLED)
    ruleset = libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if ruleset < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset")
    runtime_paths = [
        Path(sys.base_prefix) / "lib",
        Path(sys.prefix) / "lib",
        Path(__file__).with_name("file_worker.py"),
        Path(__file__).with_name("constants.py"),
        *map(
            Path,
            [
                "/lib",
                "/lib64",
                "/usr/lib",
                "/etc/ld.so.cache",
                "/etc/fonts",
                "/usr/share/fonts",
                "/usr/share/fontconfig",
                "/var/cache/fontconfig",
            ],
        ),
    ]
    try:
        permissions = [(path, READ) for path in runtime_paths if path.exists()]
        permissions += [(Path(path), READ_FILE) for path in readonly]
        permissions += [(Path(workspace), WRITE), (Path("/dev/null"), READ_FILE | WRITE_FILE)]
        for path, access in permissions:
            path = path.resolve(strict=True)
            if not path.is_dir():
                access &= ~READ_DIR
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule(access, fd)
                if libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0):
                    raise OSError(ctypes.get_errno(), "landlock_add_rule")
            finally:
                os.close(fd)
        if libc.syscall(446, ruleset, 0):
            raise OSError(ctypes.get_errno(), "landlock_restrict_self")
    finally:
        os.close(ruleset)
    context = seccomp.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise OSError("seccomp_init")
    try:
        for name in DENIED_SYSCALLS:
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(
                context, 0x00050000 | errno.EPERM, number, 0
            ):
                raise OSError("seccomp_rule_add")
        if seccomp.seccomp_load(context):
            raise OSError("seccomp_load")
    finally:
        seccomp.seccomp_release(context)


def main():
    if sys.argv[1] == "--self-test":
        import socket

        workspace = Path(sys.argv[2])
        install([], workspace)
        for operation in [lambda: Path("/etc/passwd").read_text(), lambda: socket.socket()]:
            try:
                operation()
            except PermissionError:
                pass
            else:
                raise SystemExit(1)
        (workspace / "probe").write_text("sandbox probe")
        (workspace / "probe").unlink()
        print("sandbox_ok")
        return
    policy_path, *arguments = sys.argv[1:]
    policy = json.loads(Path(policy_path).read_text())
    try:
        install(policy["readonly"], policy["workspace"])
    except OSError:
        print(json.dumps({"error": "document_sandbox_unavailable"}))
        raise SystemExit(1) from None
    sys.dont_write_bytecode = True
    sys.argv = ["portal.file_worker", *arguments]
    runpy.run_module("portal.file_worker", run_name="__main__")


if __name__ == "__main__":
    main()
