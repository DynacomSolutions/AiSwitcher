import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { cyan, dim } from "./colors.ts";
import { CliUsageError } from "./errors.ts";
import { readServerState } from "../server/state.ts";

/** `ais tui`: GUARANTEES the console server is running (starting a detached
 * daemon when necessary, same as `ais web start`), then execs the ratatui
 * binary against it with the URL and bearer token in env. The TUI itself is
 * a Rust crate under apps/tui; this launcher never blocks on SSH or sync
 * work. */
export async function runTuiCommand(_positionals: string[], _flags: Record<string, string | true>): Promise<void> {
  const { ensureConsoleRunning } = await import("./web.ts");
  const port = await ensureConsoleRunning();
  const state = await readServerState();
  const token = state?.token ?? "";

  const bin = resolveTuiBinary();
  if (!bin) {
    throw new CliUsageError(
      'could not find the aistui binary. Build it with: (cd apps/tui && cargo build --release), or install it to ~/.local/bin/aistui.',
    );
  }

  const proc = Bun.spawn([bin], {
    env: {
      ...process.env,
      AIS_CONSOLE_URL: `http://127.0.0.1:${port}`,
      ...(token ? { AIS_CONSOLE_TOKEN: token } : {}),
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

function resolveTuiBinary(): string | undefined {
  const candidates = [
    process.env.AIS_TUI_BIN,
    join(homedir(), ".local", "bin", "aistui"),
    // Dev checkout: <repo>/apps/tui/target/release/aistui derived from this
    // file's location (src/cli -> ../../apps/tui).
    join(import.meta.dir, "..", "..", "apps", "tui", "target", "release", "aistui"),
    join(import.meta.dir, "..", "..", "..", "apps", "tui", "target", "release", "aistui"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep probing
    }
  }
  return undefined;
}

export function describeTuiLaunch(bin: string, port: number): string {
  return `${cyan("ais tui")} runs ${bin} against http://127.0.0.1:${port} ${dim("(token via AIS_CONSOLE_TOKEN)")}`;
}
