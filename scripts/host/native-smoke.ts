import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function selectPackagedExecutable(appPath: string, platform = process.platform): string {
  const selected = resolve(appPath);
  const stat = statSync(selected);
  if (stat.isDirectory() && platform === "darwin" && selected.endsWith(".app")) {
    const executableDir = join(selected, "Contents", "MacOS");
    const candidates = readdirSync(executableDir).map((name) => join(executableDir, name)).filter((candidate) => {
      try { return statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0; }
      catch { return false; }
    });
    if (candidates.length !== 1) throw new Error("The app bundle must contain exactly one executable in Contents/MacOS.");
    accessSync(candidates[0], constants.X_OK);
    return candidates[0];
  }
  if (!stat.isFile()) throw new Error("HOST_APP_PATH must name a packaged executable or a macOS app bundle.");
  if (platform !== "win32") accessSync(selected, constants.X_OK);
  if (platform === "win32" && !/\.(exe|com)$/i.test(basename(selected))) {
    throw new Error("On Windows, HOST_APP_PATH must name a packaged executable.");
  }
  return selected;
}

export function validateNativeSmoke(exitCode: number, output: string): void {
  if (exitCode !== 0) throw new Error(`Packaged native smoke exited with status ${exitCode}.`);
  if (!output.split(/\r?\n/).includes("AIS_HOST_READY")) {
    throw new Error("Packaged app exited without the native ready marker.");
  }
}

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = Bun.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return value || undefined;
}

if (import.meta.main) {
  if (readOption("case") !== "packaged") throw new Error("Use --case=packaged to test a built host app.");
  const appPath = readOption("app") ?? process.env.HOST_APP_PATH;
  if (!appPath) throw new Error("Set HOST_APP_PATH or pass --app=<packaged executable or macOS app bundle>.");
  const executable = selectPackagedExecutable(appPath);
  const child = Bun.spawn([executable, "--native-smoke"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const maxOutputBytes = 64 * 1024;
  let capturedBytes = 0;
  let output = "";
  const readers: Array<{ cancel: () => Promise<void> }> = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    readers.push(reader);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (capturedBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - capturedBytes;
        const slice = chunk.value.subarray(0, remaining);
        output += new TextDecoder().decode(slice);
        capturedBytes += slice.byteLength;
      }
    }
  };
  const run = Promise.all([child.exited, Promise.all([collect(child.stdout), collect(child.stderr)])]);
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      for (const reader of readers) void reader.cancel();
      reject(new Error("Packaged native smoke exceeded its 45 second limit."));
    }, 45_000);
  });
  try {
    const [exitCode] = await Promise.race([run, timeout]);
    validateNativeSmoke(exitCode, output);
    console.log("Packaged native smoke passed.");
  } finally {
    clearTimeout(timeoutHandle!);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
