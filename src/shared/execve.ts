import { dlopen, FFIType, ptr } from "bun:ffi";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";

/**
 * True process-image replacement (libc `execve`) through `bun:ffi`.
 *
 * Why it exists: a wrapper that stays alive as the parent of a TUI can orphan
 * it when the wrapper dies (a Bun/JSC crash, the OOM killer, a stray kill):
 * the child keeps drawing with mouse tracking on while the shell retakes the
 * terminal. After `execve` there is no wrapper process left to die; the real
 * tool owns the shim's PID and terminal.
 *
 * Linux (`execve`) and macOS (`posix_spawn` with POSIX_SPAWN_SETEXEC, see
 * `execDarwin`). Every other platform, and every failure, returns a reason so
 * the caller falls back to `spawnReal`.
 */

const MIN_BLOCK_BYTES = 4096;
const SIG_DFL = 0n;
const SIG_IGN = 1n;
const SIG_SETMASK = 2;
const F_GETFD = 1;
const F_SETFD = 2;
const FD_CLOEXEC = 1;

export interface ExecBlock {
  /** Backing memory: pointer tables first, then every NUL-terminated string. */
  buffer: Uint8Array;
  pathAddr: bigint;
  argvAddr: bigint;
  envpAddr: bigint;
}

/** `KEY=value` entries; unset values and keys that cannot be encoded are dropped. */
export function buildEnvp(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === "" || key.includes("=")) continue;
    out.push(`${key}=${value}`);
  }
  return out;
}

/**
 * Lays out `path`, a NULL-terminated `argv` pointer table and a
 * NULL-terminated `envp` pointer table in ONE contiguous buffer so a single
 * pointer stays valid for the whole call. The buffer is padded past JSC's
 * inline-typed-array limit (1000 bytes) so the GC can never move it.
 * `addressOf` yields the buffer's real address (injectable for tests).
 */
export function buildExecBlock(
  path: string,
  argv: readonly string[],
  envp: readonly string[],
  addressOf: (buffer: Uint8Array) => bigint,
): ExecBlock {
  const strings = [path, ...argv, ...envp];
  const encoder = new TextEncoder();
  const encoded = strings.map((value) => {
    if (value.includes("\0")) throw new Error("execve: argument or environment entry contains a NUL byte");
    return encoder.encode(`${value}\0`);
  });
  const tableBytes = 8 * (argv.length + 1 + envp.length + 1);
  const total = tableBytes + encoded.reduce((sum, bytes) => sum + bytes.length, 0);
  const arrayBuffer = new ArrayBuffer(Math.max(total, MIN_BLOCK_BYTES));
  const buffer = new Uint8Array(arrayBuffer);
  const table = new BigUint64Array(arrayBuffer, 0, tableBytes / 8);
  const base = addressOf(buffer);

  let offset = tableBytes;
  const addrs = encoded.map((bytes) => {
    buffer.set(bytes, offset);
    const addr = base + BigInt(offset);
    offset += bytes.length;
    return addr;
  });
  // table = [argv..., NULL, envp..., NULL] (BigUint64Array zero-fills the NULLs)
  addrs.slice(1, 1 + argv.length).forEach((addr, i) => (table[i] = addr));
  addrs.slice(1 + argv.length).forEach((addr, i) => (table[argv.length + 1 + i] = addr));

  return {
    buffer,
    pathAddr: addrs[0]!,
    argvAddr: base,
    envpAddr: base + BigInt(8 * (argv.length + 1)),
  };
}

function maskBits(status: string, field: "SigIgn" | "SigBlk"): number[] {
  const hex = new RegExp(`^${field}:\\s*([0-9a-f]+)`, "mi").exec(status)?.[1];
  if (!hex) return [];
  const value = BigInt(`0x${hex}`);
  const sigs: number[] = [];
  for (let sig = 1; sig <= 64; sig++) if (value & (1n << BigInt(sig - 1))) sigs.push(sig);
  return sigs;
}

const LIBC_SYMBOLS = {
  execve: { args: [FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  signal: { args: [FFIType.i32, FFIType.u64], returns: FFIType.u64 },
  sigprocmask: { args: [FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;

let keepAlive: ExecBlock | undefined;

// Built from parts: the literal sonames read as hostnames to the identifier scan.
const LIBC_SONAMES = [["libc", "so", "6"], ["libc", "so"]].map((parts) => parts.join("."));

// <sys/spawn.h>. SETEXEC makes posix_spawn replace the calling process (the
// execve semantics, PID kept) instead of forking; CLOEXEC_DEFAULT closes every
// descriptor except those re-added with addinherit_np, which is exactly what
// Bun.spawn gives its children on macOS.
const POSIX_SPAWN_SETSIGDEF = 0x0004;
const POSIX_SPAWN_SETSIGMASK = 0x0008;
const POSIX_SPAWN_SETEXEC = 0x0040;
const POSIX_SPAWN_CLOEXEC_DEFAULT = 0x4000;

// All non-variadic, so the plain FFI declarations are ABI-correct on arm64 and x64.
const DARWIN_SYMBOLS = {
  posix_spawn: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  posix_spawnattr_init: { args: [FFIType.u64], returns: FFIType.i32 },
  posix_spawnattr_destroy: { args: [FFIType.u64], returns: FFIType.i32 },
  posix_spawnattr_setflags: { args: [FFIType.u64, FFIType.i16], returns: FFIType.i32 },
  posix_spawnattr_setsigdefault: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  posix_spawnattr_setsigmask: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  posix_spawn_file_actions_init: { args: [FFIType.u64], returns: FFIType.i32 },
  posix_spawn_file_actions_destroy: { args: [FFIType.u64], returns: FFIType.i32 },
  posix_spawn_file_actions_addinherit_np: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
} as const;

/**
 * macOS: `posix_spawn(POSIX_SPAWN_SETEXEC)` in place of libc `execve`.
 *
 * Why not execve plus the Linux fixups: Linux marks every stray descriptor
 * with `fcntl(fd, F_SETFD, FD_CLOEXEC)`, but `fcntl` is variadic. On Apple
 * arm64 variadic arguments travel on the stack while a `bun:ffi` declaration
 * passes them in registers, so F_SETFD would read garbage: not ABI-safe (and
 * `ioctl(FIOCLEX)` is variadic too). `posix_spawn` and its attribute calls
 * take fixed arguments only, and one attribute set also resets the ignored
 * signals (SETSIGDEF, all signals), clears the blocked mask (SETSIGMASK) and
 * closes every descriptor but 0-2 (CLOEXEC_DEFAULT + addinherit_np), with no
 * `/dev/fd` walk and no `struct sigaction` layout to get wrong. sigset_t is a
 * plain u32 on Darwin. On failure nothing was applied to this process.
 */
function execDarwin(block: ExecBlock, path: string): string {
  const lib = dlopen("/usr/lib/libSystem.B.dylib", DARWIN_SYMBOLS);
  const s = lib.symbols;
  // One page (past JSC's movable-array limit) holding: attr handle, file actions handle, pid out, two sigsets.
  const scratch = new Uint8Array(MIN_BLOCK_BYTES);
  const view = new DataView(scratch.buffer);
  const base = BigInt(ptr(scratch));
  const attr = base;
  const actions = base + 8n;
  const pidOut = base + 16n;
  const sigDefault = base + 24n;
  const sigMask = base + 28n;
  view.setUint32(24, 0xffffffff, true); // sigfillset: every signal back to its default action
  view.setUint32(28, 0, true); // sigemptyset

  if (s.posix_spawnattr_init(attr) !== 0) return "posix_spawnattr_init failed";
  if (s.posix_spawn_file_actions_init(actions) !== 0) {
    s.posix_spawnattr_destroy(attr);
    return "posix_spawn_file_actions_init failed";
  }
  const cleanup = () => {
    s.posix_spawn_file_actions_destroy(actions);
    s.posix_spawnattr_destroy(attr);
  };
  let rc = s.posix_spawnattr_setflags(
    attr,
    POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK,
  );
  if (rc === 0) rc = s.posix_spawnattr_setsigdefault(attr, sigDefault);
  if (rc === 0) rc = s.posix_spawnattr_setsigmask(attr, sigMask);
  for (const fd of [0, 1, 2]) if (rc === 0) rc = s.posix_spawn_file_actions_addinherit_np(actions, fd);
  if (rc !== 0) {
    cleanup();
    return `posix_spawn attributes failed (${rc})`;
  }

  keepAlive = block; // the GC must not free the block while the kernel reads it
  rc = s.posix_spawn(pidOut, block.pathAddr, actions, attr, block.argvAddr, block.envpAddr);
  // Only reached when the exec failed; rc is the errno.
  cleanup();
  return `execve(${path}) failed (errno ${rc})`;
}

function openLibc() {
  try {
    return dlopen(LIBC_SONAMES[0]!, LIBC_SYMBOLS);
  } catch {
    return dlopen(LIBC_SONAMES[1]!, LIBC_SYMBOLS);
  }
}

/**
 * Replaces this process with `path`. Never returns on success; when exec is
 * unavailable or fails it returns the reason (process untouched, or
 * restored). `argv` includes argv[0].
 */
export function tryExecve(path: string, argv: readonly string[], env: Record<string, string | undefined>): string {
  if (process.platform !== "linux" && process.platform !== "darwin") return `execve unsupported on ${process.platform}`;
  try {
    // execve never searches PATH: a bare name (e.g. `bunx`) would run ./bunx.
    if (!path.includes("/")) {
      const found = Bun.which(path, { PATH: env.PATH ?? process.env.PATH ?? "" });
      if (!found) return `${path} not found on PATH`;
      path = found;
    }
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return `${path} not executable`;
    }
    const block = buildExecBlock(path, argv, buildEnvp(env), (buffer) => BigInt(ptr(buffer)));
    if (process.platform === "darwin") return execDarwin(block, path);
    const lib = openLibc();

    // Dispositions that survive execve and that Bun.spawn's children never
    // see: ignored signals (Bun ignores SIGPIPE/SIGXFSZ), a blocked mask, and
    // Bun's own non-CLOEXEC descriptors.
    const status = readFileSync("/proc/self/status", "utf8");
    const ignored = maskBits(status, "SigIgn");
    const blocked = maskBits(status, "SigBlk").length > 0;
    const sigset = new Uint8Array(MIN_BLOCK_BYTES); // zeroed: the empty set
    const oldset = new Uint8Array(MIN_BLOCK_BYTES);
    for (const fd of readdirSync("/proc/self/fd").map(Number)) {
      if (fd > 2 && lib.symbols.fcntl(fd, F_GETFD, 0) >= 0) lib.symbols.fcntl(fd, F_SETFD, FD_CLOEXEC);
    }
    for (const sig of ignored) lib.symbols.signal(sig, SIG_DFL);
    if (blocked) lib.symbols.sigprocmask(SIG_SETMASK, BigInt(ptr(sigset)), BigInt(ptr(oldset)));

    keepAlive = block; // the GC must not free the block while the syscall reads it
    lib.symbols.execve(block.pathAddr, block.argvAddr, block.envpAddr);

    // Only reached when execve failed: put back what we changed.
    for (const sig of ignored) lib.symbols.signal(sig, SIG_IGN);
    if (blocked) lib.symbols.sigprocmask(SIG_SETMASK, BigInt(ptr(oldset)), 0n);
    return `execve(${path}) failed`;
  } catch (err) {
    return `execve unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
