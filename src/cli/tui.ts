import { cyan, dim } from "./colors.ts";
import { CliUsageError } from "./errors.ts";
import { ensureAistuiBinary, resolveTuiBinary } from "../shared/aistui-bin.ts";
import { readServerState } from "../server/state.ts";

// resolveTuiBinary moved to shared/aistui-bin.ts (next to the self-heal
// that consumes it); re-exported here for the historical import sites.
export { resolveTuiBinary } from "../shared/aistui-bin.ts";

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

  let bin = resolveTuiBinary();
  let autoInstallError: string | undefined;
  if (!bin) {
    // One self-heal attempt: aistui ships in releases now, so a machine
    // without a local cargo build downloads it once and launches.
    try {
      bin = await ensureAistuiBinary();
    } catch (err) {
      autoInstallError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!bin) {
    throw new CliUsageError(
      `could not find the aistui binary, and the automatic install from the GitHub release failed${autoInstallError ? `: ${autoInstallError}` : ""}. Build it with: (cd apps/tui && cargo build --release), or install it to ~/.local/bin/aistui.`,
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

export function describeTuiLaunch(bin: string, port: number): string {
  return `${cyan("ais tui")} runs ${bin} against http://127.0.0.1:${port} ${dim("(token via AIS_CONSOLE_TOKEN)")}`;
}
