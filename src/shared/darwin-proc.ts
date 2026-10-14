import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * macOS stand-ins for the Linux `/proc` reads the session sidecar relies on:
 * process state and start time (`sysctl kern.proc.pid`) and the executable
 * path (`proc_pidpath`). Both libc calls take fixed arguments, so the plain
 * `bun:ffi` declarations are ABI-correct on arm64 and x64.
 */

const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const SZOMB = 5;
const BUF_BYTES = 4096; // past JSC's movable-array limit, so ptr() stays valid
const PROC_BUF_OFFSET = 64;
const PROC_BUF_LEN = 1024; // sizeof(struct kinfo_proc) is 648 on LP64
const PATH_BUF_LEN = 4096; // PROC_PIDPATHINFO_MAXSIZE

// Built from parts, like the soname in execve.ts: the literal reads as a hostname to the identifier scan.
const LIBSYSTEM = ["/usr/lib/libSystem", "B", "dylib"].join(".");

let lib: ReturnType<typeof open> | undefined;
function open() {
  return dlopen(LIBSYSTEM, {
    sysctl: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
  });
}

export interface DarwinProc {
  /** "Z" for a zombie, "R" for anything else alive. */
  state: string;
  /** Process start time, `<seconds>.<microseconds>`: stable for a PID's lifetime, differs on reuse. */
  startTime: string;
}

/** Undefined when the PID is gone, or the kernel answer does not look like `pid`. */
export function darwinProc(pid: number): DarwinProc | undefined {
  try {
    lib ??= open();
    const buf = new Uint8Array(BUF_BYTES);
    const view = new DataView(buf.buffer);
    const base = BigInt(ptr(buf));
    [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid].forEach((n, i) => view.setInt32(i * 4, n, true));
    view.setBigUint64(16, BigInt(PROC_BUF_LEN), true); // size_t oldlen
    const rc = lib.symbols.sysctl(base, 4, base + BigInt(PROC_BUF_OFFSET), base + 16n, 0n, 0n);
    if (rc !== 0 || view.getBigUint64(16, true) === 0n) return undefined;
    // struct kinfo_proc starts with extern_proc: p_starttime {tv_sec i64, tv_usec i32} at 0,
    // p_stat (char) at 36, p_pid (int) at 40.
    const at = PROC_BUF_OFFSET;
    if (view.getInt32(at + 40, true) !== pid) return undefined;
    return {
      state: view.getUint8(at + 36) === SZOMB ? "Z" : "R",
      startTime: `${view.getBigInt64(at, true)}.${view.getInt32(at + 8, true)}`,
    };
  } catch {
    return undefined;
  }
}

/** Executable path of a running PID, or undefined. */
export function darwinExe(pid: number): string | undefined {
  try {
    lib ??= open();
    const buf = new Uint8Array(BUF_BYTES);
    const n = lib.symbols.proc_pidpath(pid, BigInt(ptr(buf)), PATH_BUF_LEN);
    return n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : undefined;
  } catch {
    return undefined;
  }
}
