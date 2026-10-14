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
 * Linux only. macOS has a different variadic calling convention for
 * `fcntl`, and its Bun.spawn already closes stray descriptors, so it keeps
 * the spawn path (see `execReal`). Every failure returns `false` so the
 * caller falls back to `spawnReal`.
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

function openLibc() {
  try {
    return dlopen(LIBC_SONAMES[0]!, LIBC_SYMBOLS);
  } catch {
    return dlopen(LIBC_SONAMES[1]!, LIBC_SYMBOLS);
  }
}

/**
 * Replaces this process with `path`. Returns `false` (process untouched, or
 * restored) when exec is unavailable or fails; never returns on success.
 * `argv` includes argv[0].
 */
export function tryExecve(path: string, argv: readonly string[], env: Record<string, string | undefined>): boolean {
  if (process.platform !== "linux") return false;
  try {
    accessSync(path, constants.X_OK);
    const lib = openLibc();
    const block = buildExecBlock(path, argv, buildEnvp(env), (buffer) => BigInt(ptr(buffer)));

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
    return false;
  } catch {
    return false;
  }
}
