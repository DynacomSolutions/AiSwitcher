import { statSync } from "node:fs";
import { runScan, type ScanKind, type ScanRequest, type ScanResult } from "./scan-worker.ts";

/** Child-process runner for expensive scans. Every scan executes in a fresh
 * `ais __scan_worker` child (same entrypoint trick as the web daemon:
 * compiled binaries re-exec themselves; dev prepends the bun runtime). The
 * request JSON goes in on stdin, the result JSON comes back on stdout, and
 * the parent hard-kills the child at its deadline so a wedged scan can
 * never accumulate. This replaces a Bun Worker attempt: bun --compile 1.3.x
 * cannot resolve worker entrypoints from the virtual /$bunfs filesystem. */

export interface ScanSpawn {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  requestedPort?: undefined;
}

function isScriptEntrypoint(main: string): boolean {
  try {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(main) && statSync(main).isFile();
  } catch {
    return false;
  }
}

function baseArgs(): string[] {
  const main = Bun.main;
  // Same discriminator as cli/web.ts's spawnDaemon: dev Bun.main is a real
  // .ts file (prepend the bun runtime); compiled Bun.main is a virtual
  // /$bunfs path and process.execPath IS the executable.
  const inner = isScriptEntrypoint(main) ? [process.execPath, main] : [process.execPath];
  const setsid = Bun.which("setsid");
  return setsid ? [setsid, ...inner] : inner;
}

export async function runScanIsolated<T>(
  kind: ScanKind,
  params: Omit<ScanRequest, "kind">,
  timeoutMs: number,
): Promise<ScanResult<T>> {
  const req: ScanRequest = { kind, ...params };
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let settled = false;
  const finish = (result: ScanResult<T>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      proc?.kill();
    } catch {
      // already exited
    }
  };
  let timer!: ReturnType<typeof setTimeout>;
  const result = await new Promise<ScanResult<T>>((resolve) => {
    timer = setTimeout(() => {
      finish({ ok: false, error: `${kind} scan timed out after ${Math.round(timeoutMs / 1000)}s`, status: 504 });
      resolve({ ok: false, error: `${kind} scan timed out after ${Math.round(timeoutMs / 1000)}s`, status: 504 });
    }, timeoutMs);
    try {
      proc = Bun.spawn([...baseArgs(), "__scan_worker"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : "failed to start scan worker", status: 500 });
      return;
    }
    const child = proc;
    void new Response(child.stdout).text().then((stdout) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(stdout) as ScanResult<T>;
        finish(parsed);
        resolve(parsed);
      } catch {
        void new Response(child.stderr).text().then((stderr) => {
          const failure = { ok: false, error: stderr.trim() || "scan worker produced no output", status: 500 } as ScanResult<T>;
          finish(failure);
          resolve(failure);
        });
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
  finish(result);
  return result;
}

/** Entry point for `ais __scan_worker`: one scan request on stdin, one JSON
 * response on stdout, then exit. */
export async function runScanWorkerStdio(): Promise<void> {
  const input = await new Response(Bun.stdin.stream()).text();
  let req: ScanRequest;
  try {
    req = JSON.parse(input) as ScanRequest;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid scan request", status: 400 })}\n`);
    return;
  }
  const result = await runScan(req);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
