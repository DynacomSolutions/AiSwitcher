import { openSync, closeSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { CliUsageError } from "../errors.ts";
import { applyInbox, readInboxStdin, type InboxClock } from "../../live/inbox.ts";
import { writeOutbox } from "../../live/outbox.ts";
import { newestPersistedMtime, openHomeDirectory } from "../../live/safe-fs.ts";

const BUILD_TIME_FILE = "/etc/ais/image-build-time";

function parseBuildTime(value: string): number {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error("image build-time marker is invalid");
  return parsed;
}

async function clockSnapshot(home: string): Promise<InboxClock> {
  const buildTimeMs = parseBuildTime(await Bun.file(BUILD_TIME_FILE).text());
  const root = await openHomeDirectory(home);
  let newestPersistedMtimeMs = 0;
  try { newestPersistedMtimeMs = await newestPersistedMtime(root); }
  finally { await root.close(); }

  let synchronized = false;
  try {
    const probe = Bun.spawn(["timedatectl", "show", "--property=NTPSynchronized", "--value"], { stdout: "pipe", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      probe.exited.then(async (code) => ({ code, output: await new Response(probe.stdout).text() })),
      new Promise<{ code: number; output: string }>((resolve) => { timer = setTimeout(() => { probe.kill(); resolve({ code: 1, output: "" }); }, 2500); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    synchronized = result.code === 0 && result.output.trim() === "yes";
  } catch { /* absent timedatectl means unsynchronised */ }

  let online = false;
  let httpDateMs: number | undefined;
  try {
    const response = await fetch("https://example.com/", { method: "HEAD", signal: AbortSignal.timeout(2500) });
    online = true;
    const header = response.headers.get("date");
    if (header) {
      const parsed = Date.parse(header);
      if (Number.isFinite(parsed)) httpDateMs = parsed;
    }
  } catch { /* offline or probe unavailable */ }
  return { synchronized, imageBuildTimeMs: buildTimeMs, newestPersistedMtimeMs, ...(httpDateMs === undefined ? {} : { httpDateMs }), online, nowMs: Date.now() };
}

async function conflictPrompt(path: string): Promise<"drive" | "bundle"> {
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  try { inputFd = openSync("/dev/tty", "r"); outputFd = openSync("/dev/tty", "w"); }
  catch {
    if (inputFd !== undefined) closeSync(inputFd);
    throw new Error("configuration conflict needs a controlling terminal");
  }
  const input = createReadStream("", { fd: inputFd, autoClose: false, encoding: "utf8" });
  const output = createWriteStream("", { fd: outputFd, autoClose: false });
  const readline = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await readline.question(`Conflict ${path}: [d] keep drive, [b] keep bundle? `)).trim().toLowerCase();
      if (answer === "d" || answer === "drive") return "drive";
      if (answer === "b" || answer === "bundle") return "bundle";
    }
  } finally { readline.close(); input.destroy(); output.destroy(); closeSync(inputFd); closeSync(outputFd); }
}

function hasControllingTerminal(): boolean {
  try { const fd = openSync("/dev/tty", "r"); closeSync(fd); return true; }
  catch { return false; }
}

function ensureOnly(flags: Record<string, string | true>, allowed: string[]): void {
  const unknown = Object.keys(flags).find((name) => !allowed.includes(name));
  if (unknown) throw new CliUsageError(`Unknown live flag --${unknown}`);
}

export async function runLiveCommand(rest: string[], flags: Record<string, string | true>): Promise<void> {
  const [operation, ...extra] = rest;
  if (extra.length) throw new CliUsageError("Unexpected live command argument");
  const home = homedir();
  if (operation === "apply-inbox") {
    ensureOnly(flags, ["stdin"]);
    if (flags.stdin !== true) throw new CliUsageError("Usage: ais live apply-inbox --stdin");
    const tar = await readInboxStdin();
    const result = await applyInbox({ tar, home, clock: await clockSnapshot(home), isTTY: hasControllingTerminal(), chooseConflict: conflictPrompt });
    if (result.deferred) { process.exitCode = 2; console.error("AIS-LIVE: stage=inbox status=deferred"); }
    else console.error(`AIS-LIVE: stage=inbox status=ok applied=${result.applied} skipped=${result.skipped}`);
    return;
  }
  if (operation === "write-outbox") {
    ensureOnly(flags, []);
    const result = await writeOutbox({ home });
    process.stdout.write(result.tarBytes);
    return;
  }
  throw new CliUsageError("Usage: ais live <apply-inbox --stdin|write-outbox>");
}
