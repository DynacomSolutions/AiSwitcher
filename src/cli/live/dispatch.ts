import { openSync, closeSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { CliUsageError } from "../errors.ts";
import { applyInbox, readInboxStdin, type InboxClock } from "../../live/inbox.ts";
import { writeOutbox } from "../../live/outbox.ts";
import { newestPersistedMtime, openHomeDirectory } from "../../live/safe-fs.ts";
import { boolFlag } from "../args.ts";
import type { ParsedArgs } from "../args.ts";
import { isOnline } from "../../shared/connectivity.ts";
import { discoverLocalModels, resolveLlamaRunner } from "../../shared/local-models.ts";

const BUILD_TIME_FILE = "/etc/ais/image-build-time";

function parseBuildTime(value: string): number {
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error("image build-time marker is invalid");
  return parsed;
}

export interface ClockSnapshotDeps {
  buildTimeFile?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  nowMs?: () => number;
  synchronizedProbe?: () => Promise<boolean>;
}

function confirmedOffline(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const values = [error as { code?: unknown }, (error as { cause?: { code?: unknown } }).cause];
  return values.some((value) => value && typeof value.code === "string" && ["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"].includes(value.code));
}

export async function clockSnapshot(home: string, deps: ClockSnapshotDeps = {}): Promise<InboxClock> {
  const buildTimeMs = parseBuildTime(await Bun.file(deps.buildTimeFile ?? BUILD_TIME_FILE).text());
  const root = await openHomeDirectory(home);
  let newestPersistedMtimeMs = 0;
  try { newestPersistedMtimeMs = await newestPersistedMtime(root); }
  finally { await root.close(); }

  let synchronized = false;
  if (deps.synchronizedProbe) synchronized = await deps.synchronizedProbe().catch(() => false);
  else try {
    const probe = Bun.spawn(["timedatectl", "show", "--property=NTPSynchronized", "--value"], { stdout: "pipe", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      probe.exited.then(async (code) => ({ code, output: await new Response(probe.stdout).text() })),
      new Promise<{ code: number; output: string }>((resolve) => { timer = setTimeout(() => { probe.kill(); resolve({ code: 1, output: "" }); }, 2500); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    synchronized = result.code === 0 && result.output.trim() === "yes";
  } catch { /* absent timedatectl means unsynchronised */ }

  let online = true;
  let httpDateMs: number | undefined;
  try {
    const response = await (deps.fetchImpl ?? fetch)("https://example.com/", { method: "HEAD", signal: AbortSignal.timeout(2500) });
    online = true;
    const header = response.headers.get("date");
    if (header) {
      const parsed = Date.parse(header);
      if (Number.isFinite(parsed)) httpDateMs = parsed;
    }
  } catch (error) {
    if (confirmedOffline(error)) online = false;
  }
  return { synchronized, imageBuildTimeMs: buildTimeMs, newestPersistedMtimeMs, ...(httpDateMs === undefined ? {} : { httpDateMs }), online, nowMs: (deps.nowMs ?? Date.now)() };
}

export function optionalNumberFlag(flags: Record<string, string | true>, name: string, minimum: number): number | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true || !/^\d+$/.test(value)) throw new CliUsageError(`--${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new CliUsageError(`--${name} is out of range`);
  return parsed;
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

export interface LiveNetCheckDeps {
  online: (refresh: boolean) => Promise<boolean>;
  discover: () => ReturnType<typeof discoverLocalModels>;
  runner: () => string | undefined;
  write: (line: string) => void;
}

const realDeps: LiveNetCheckDeps = {
  online: (refresh) => isOnline({ refresh }),
  discover: () => discoverLocalModels(),
  runner: () => resolveLlamaRunner(),
  write: (line) => console.log(line),
};

export async function runLiveCommand(
  args: string[],
  flags: ParsedArgs["flags"],
  deps: LiveNetCheckDeps = realDeps,
): Promise<void> {
  const [subcommand, ...extra] = args;
  if (subcommand === "net-check") {
    if (extra.length) throw new CliUsageError('Usage: ais live net-check [--json] [--fresh]');
    const online = await deps.online(boolFlag(flags, "fresh"));
    const localModel = deps.runner() !== undefined && (await deps.discover()).length > 0;
    if (boolFlag(flags, "json")) deps.write(JSON.stringify({ online, localModel }));
    else deps.write(`Internet: ${online ? "available" : "unavailable"}; local model: ${localModel ? "available" : "unavailable"}`);
    if (!online) process.exitCode = 1;
    return;
  }
  const operation = subcommand;
  if (extra.length) throw new CliUsageError("Unexpected live command argument");
  const home = homedir();
  if (operation === "apply-inbox") {
    ensureOnly(flags, ["stdin", "last-inbox-seq"]);
    if (flags.stdin !== true) throw new CliUsageError("Usage: ais live apply-inbox --stdin");
    const lastInboxSeq = optionalNumberFlag(flags, "last-inbox-seq", 0);
    const tar = await readInboxStdin();
    const result = await applyInbox({ tar, home, clock: await clockSnapshot(home), isTTY: hasControllingTerminal(), chooseConflict: conflictPrompt, log: (message) => console.error(message), ...(lastInboxSeq === undefined ? {} : { lastInboxSeq }) });
    if (result.deferred) { process.exitCode = 2; console.error("AIS-LIVE: stage=inbox status=deferred"); }
    else console.error(`AIS-LIVE: stage=inbox status=ok applied=${result.applied} skipped=${result.skipped}`);
    return;
  }
  if (operation === "write-outbox") {
    ensureOnly(flags, ["seq", "last-inbox-seq"]);
    const seq = optionalNumberFlag(flags, "seq", 1);
    const lastInboxSeq = optionalNumberFlag(flags, "last-inbox-seq", 0);
    const result = await writeOutbox({ home, ...(seq === undefined ? {} : { seq }), ...(lastInboxSeq === undefined ? {} : { lastInboxSeq }) });
    process.stdout.write(result.tarBytes);
    return;
  }
  throw new CliUsageError("Usage: ais live <net-check|apply-inbox --stdin|write-outbox>");
}
