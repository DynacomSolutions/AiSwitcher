import { randomUUID } from "node:crypto";
import { credentialPathsForTool } from "./auth.ts";
import { requireTool } from "./registries.ts";
import { LOGIN_FLOW_SPECS } from "./login-specs.ts";
import { resolveRealBinary } from "../shared/resolve-binary.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { ToolConfig } from "../identities/types.ts";
import { HttpError, type LoginFlowDto, type LoginFlowStatus } from "./types.ts";

/**
 * Daemon-managed per-identity login flows.
 *
 * The daemon spawns the SAME standard login flow the CLI runs, but with
 * piped stdio so it works on a headless/SSH-hosted machine where the
 * user's browser is on a different device. Per-tool rationale lives with
 * LOGIN_FLOW_SPECS (login-specs.ts).
 *
 * Completion is detected from the process exit code, and credential-file
 * fingerprints (path + mtime + size, never contents) let the UI show the
 * transient "credentials received" step before the process exits.
 */

export interface SpawnedChild {
  stdin: {
    write(data: string | Uint8Array): Promise<number> | number;
    end(): unknown;
  };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number | null | undefined>;
  kill(signal?: number | string): boolean | void;
  pid?: number;
}

type SpawnFn = (cmd: string[], opts: { env: Record<string, string> }) => SpawnedChild;

/** URL extraction tolerates the OSC-8 hyperlink wrappers PTY output wraps
 * links in (ESC ]8;;URL ESC \): the match stops at any escape byte. */
const URL_PATTERN = /https?:\/\/[^\s"'`<>|\\^\x1b\x07)\]]+/g;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;
/** Anything token-shaped (long unbroken run) is redacted before an output
 * fragment is ever surfaced as an error message. */
const TOKENISH_PATTERN = /[A-Za-z0-9_-]{28,}/g;

export function firstAuthUrl(text: string): string | undefined {
  const matches = text.match(URL_PATTERN) ?? [];
  const relevant = matches.find((url) => /oauth|authoriz|device|\/login|\/code|auth\./i.test(url));
  return relevant ?? matches[0];
}

export function firstDeviceCode(text: string): string | undefined {
  return DEVICE_CODE_PATTERN.exec(text)?.[0];
}

const ANSI_CSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const ANSI_OSC8_PATTERN = /\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g;
const ANSI_OSC_OTHER_PATTERN = /\x1b\](?!8;)[^\x07\x1b]*(\x07|\x1b\\)/g;

/** Parse the flow's rolling output tail after reducing ANSI control
 * sequences. OSC-8 hyperlink wrappers are UNWRAPPED (their URI field is the
 * auth URL itself); every other escape becomes a separator byte so e.g.
 * codex's colour-coded one-time code no longer merges with the escape text.
 * A match ending exactly at the tail boundary may still be mid-stream, so
 * it is held back until a terminator byte arrives after it. */
export function extractFlowSignals(tail: string): { url?: string; deviceCode?: string } {
  if (tail.length === 0) return {};
  const plain = tail
    .replace(ANSI_OSC8_PATTERN, (match) => ` ${match.replace(/^\x1b\]8;[^;]*;/, "").replace(/(\x07|\x1b\\)$/, "")} `)
    .replace(ANSI_OSC_OTHER_PATTERN, " ")
    .replace(ANSI_CSI_PATTERN, " ")
    .slice(0, -1);
  return { url: firstAuthUrl(plain), deviceCode: firstDeviceCode(plain) };
}

/** A user may paste either the bare code or the whole redirect URL; if it
 * is a URL carrying a code parameter, send just the code. */
export function extractPasteValue(raw: string): string {
  const trimmed = raw.trim();
  if (!/https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    return code ?? trimmed;
  } catch {
    return trimmed;
  }
}

function redact(text: string): string {
  return text.replace(TOKENISH_PATTERN, "<redacted>").slice(-400).trim();
}

async function readStream(stream: AsyncIterable<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }));
}

export interface FingerprintFn {
  (paths: string[]): Promise<string | undefined>;
}

export interface LoginFlowManagerDeps {
  spawn?: SpawnFn;
  /** util-linux script binary for PTY mode; discovery is injectable so
   * tests never depend on the host. */
  scriptBin?: string;
  now?: () => number;
  /** Credential-file fingerprint probe (injectable). */
  fingerprint?: FingerprintFn;
  /** Which files count as "credentials appeared" per tool (injectable). */
  credentialPaths?: (toolName: ToolConfig["toolName"], configDir: string) => string[];
  /** Registry resolution (injectable so tests never touch a real home). */
  resolveIdentity?: typeof defaultResolveIdentity;
  /** REAL binary resolution. Deliberately not Bun.which(cfg.realBinaryName):
   * that finds this project's own shim first, and spawning the shim from the
   * daemon adds an unneeded layer with its own resolution — the exec.ts
   * convention is "resolve via resolveRealBinary, spawn the real binary". */
  resolveBin?: (name: string) => string | undefined;
  flowTimeoutMs?: number;
  pollIntervalMs?: number;
  keepEndedMs?: number;
  maxEndedFlows?: number;
}

/** Default registry resolution: the real one. */
async function defaultResolveIdentity(
  toolName: ToolConfig["toolName"],
  identityName: string,
): Promise<{ cfg: ToolConfig; configDir: string; identityName: string }> {
  const cfg = requireTool(toolName);
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const identity = findIdentityByNameOrAlias(file.identities, identityName);
  if (!identity) throw new HttpError(404, `identity "${identityName}" not found in ${toolName}'s registry`);
  return { cfg, configDir: identity.configDir, identityName: identity.name };
}

interface FlowRecord {
  dto: LoginFlowDto;
  child?: SpawnedChild;
  credentialPaths: string[];
  initialFingerprint?: string;
  fingerprint?: string;
  /** Rolling tail of the child's output, for failure messages only; it is
   * redacted before it ever leaves the process. */
  outputTail: string;
  timer?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

export const DEFAULT_FLOW_TIMEOUT_MS = 15 * 60_000;

/** Real spawnFn used in production. */
export function defaultSpawn(cmd: string[], opts: { env: Record<string, string> }): SpawnedChild {
  const proc = Bun.spawn(cmd, {
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal as number | undefined),
    pid: proc.pid,
  };
}

export class LoginFlowManager {
  private readonly flows = new Map<string, FlowRecord>();
  private readonly spawn: SpawnFn;
  private readonly scriptBin?: string;
  private readonly now: () => number;
  private readonly fingerprint: FingerprintFn;
  private readonly credentialPaths: (toolName: ToolConfig["toolName"], configDir: string) => string[];
  private readonly resolveIdentity: typeof defaultResolveIdentity;
  private readonly resolveBin: (name: string) => string | undefined;
  private readonly flowTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly keepEndedMs: number;
  private readonly maxEndedFlows: number;

  constructor(deps: LoginFlowManagerDeps = {}) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.scriptBin = deps.scriptBin ?? Bun.which("script") ?? undefined;
    this.now = deps.now ?? Date.now;
    this.resolveIdentity = deps.resolveIdentity ?? defaultResolveIdentity;
    this.fingerprint =
      deps.fingerprint ??
      (async (paths) => {
        const parts: string[] = [];
        for (const path of paths) {
          try {
            const info = await Bun.file(path).stat();
            if (!info) continue;
            parts.push(`${path}:${info.mtime ?? 0}:${info.size ?? 0}`);
          } catch {
            // Absent or unreadable: contributes nothing to the fingerprint.
          }
        }
        return parts.length > 0 ? parts.join("|") : undefined;
      });
    this.credentialPaths = deps.credentialPaths ?? credentialPathsForTool;
    this.resolveIdentity = deps.resolveIdentity ?? defaultResolveIdentity;
    this.resolveBin =
      deps.resolveBin ??
      ((name) => {
        try {
          return resolveRealBinary(name as Parameters<typeof resolveRealBinary>[0]);
        } catch {
          return undefined;
        }
      });
    this.flowTimeoutMs = deps.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1_500;
    this.keepEndedMs = deps.keepEndedMs ?? 30 * 60_000;
    this.maxEndedFlows = deps.maxEndedFlows ?? 20;
  }

  list(): LoginFlowDto[] {
    this.prune();
    const records = [...this.flows.values()];
    const rank = (record: FlowRecord): number => (record.done ? 1 : 0);
    return records
      .sort((a, b) => rank(a) - rank(b) || a.dto.startedAt.localeCompare(b.dto.startedAt))
      .map((record) => ({ ...record.dto }));
  }

  get(flowId: string): LoginFlowDto {
    const record = this.flows.get(flowId);
    if (!record) throw new HttpError(404, `unknown login flow "${flowId}"`);
    return { ...record.dto };
  }

  /** Starts the managed login for (tool, identity). Throws 409 if a flow
   * for the same pair is already active. */
  async start(toolName: ToolConfig["toolName"], identityName: string): Promise<LoginFlowDto> {
    const spec = LOGIN_FLOW_SPECS[toolName];
    if (!spec) throw new HttpError(400, `tool "${toolName}" has no managed login flow`);
    const { cfg, configDir, identityName: canonicalName } = await this.resolveIdentity(toolName, identityName);

    for (const record of this.flows.values()) {
      if (!record.done && record.dto.toolName === toolName && record.dto.identity === canonicalName) {
        throw new HttpError(409, `a login flow for ${toolName}/${canonicalName} is already running`);
      }
    }

    const realBin = this.resolveBin(cfg.realBinaryName);
    if (!realBin) {
      // startLogin downgrades 503 to the terminal handoff, which has its own
      // (user-attended) resolution path.
      throw new HttpError(503, `could not locate the real ${cfg.realBinaryName} binary for a managed login`);
    }
    const childEnv = this.childEnv(cfg, configDir);
    const commandLine =
      spec.mode === "pty"
        ? this.ptyCommandLine(realBin, spec.args)
        : [realBin, ...spec.args];
    if (spec.mode === "pty" && !this.scriptBin) {
      throw new HttpError(503, "no `script` binary available for a PTY login; run the login in a terminal instead");
    }

    const nowIso = new Date(this.now()).toISOString();
    const dto: LoginFlowDto = {
      flowId: randomUUID(),
      toolName,
      identity: canonicalName,
      status: "starting",
      mode: spec.mode,
      acceptsPaste: spec.acceptsPaste,
      ...(spec.instruction ? { instruction: spec.instruction } : {}),
      startedAt: nowIso,
      updatedAt: nowIso,
    };
    const record: FlowRecord = {
      dto,
      credentialPaths: this.credentialPaths(toolName, configDir),
      outputTail: "",
      done: false,
    };
    this.flows.set(dto.flowId, record);

    try {
      record.child = this.spawn(commandLine, { env: childEnv });
    } catch (err) {
      this.finish(record, "failed", err instanceof Error ? err.message : "failed to spawn login process");
      return { ...record.dto };
    }

    record.initialFingerprint = await this.fingerprint(record.credentialPaths);
    record.fingerprint = record.initialFingerprint;

    const child = record.child as SpawnedChild;
    const appendOutput = (text: string) => this.onOutput(record, text);
    void readStream(child.stdout, appendOutput).catch(() => {});
    void readStream(child.stderr, appendOutput).catch(() => {});

    void child.exited.then(
      (code: number | null | undefined) => this.onExit(record, code),
      () => this.onExit(record, undefined),
    );

    record.timer = setInterval(() => void this.poll(record), this.pollIntervalMs);
    record.timer.unref?.();
    record.timeout = setTimeout(() => {
      if (record.done) return;
      this.killChild(record);
      this.finish(record, "failed", `login flow timed out after ${Math.round(this.flowTimeoutMs / 60_000)} minutes`);
    }, this.flowTimeoutMs);
    record.timeout.unref?.();

    this.prune();
    return { ...record.dto };
  }

  /** Injects a pasted code (or full redirect URL; the code parameter is
   * extracted) into the flow's stdin. */
  submit(flowId: string, code: string): LoginFlowDto {
    const record = this.requireActive(flowId);
    if (!record.dto.acceptsPaste) {
      throw new HttpError(400, `${record.dto.toolName}'s login flow does not accept a pasted code`);
    }
    const child = record.child;
    if (!child) throw new HttpError(409, "login process is gone");
    const value = extractPasteValue(code);
    if (!value) throw new HttpError(400, "pasted value must not be empty");
    try {
      void child.stdin.write(`${value}\n`);
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? `login process is gone: ${err.message}` : "login process is gone");
    }
    this.touch(record);
    return { ...record.dto };
  }

  cancel(flowId: string): LoginFlowDto {
    const record = this.flows.get(flowId);
    if (!record) throw new HttpError(404, `unknown login flow "${flowId}"`);
    if (record.done) return { ...record.dto };
    this.killChild(record);
    this.finish(record, "cancelled");
    return { ...record.dto };
  }

  stop(): void {
    for (const record of this.flows.values()) {
      this.clearTimers(record);
      if (!record.done) {
        this.killChild(record);
        this.finish(record, "cancelled");
      }
    }
  }

  private requireActive(flowId: string): FlowRecord {
    const record = this.flows.get(flowId);
    if (!record) throw new HttpError(404, `unknown login flow "${flowId}"`);
    if (record.done) throw new HttpError(409, `login flow already ${record.dto.status}`);
    return record;
  }

  /** Session-marker vars are stripped for the same reason exec.ts strips
   * them for wrappers: a daemon running inside a coding-agent session must
   * never look like a nested launch to the real binary (the documented
   * nested-session hang). The identity's own config vars are applied last
   * and always win. TERM is forced for PTY mode so Ink renders. */
  private childEnv(cfg: ToolConfig, configDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(CLAUDE|CODEX|GROK|AI_AGENT|CRUSH|ALI|OPENCODE_(?:SERVER_PASSWORD|SERVER_USERNAME|CLIENT))/i.test(key)) continue;
      if (key === "AI_PROFILE_SWITCHER_SESSION" || key === "GROK_MEMORY") continue;
      env[key] = value;
    }
    for (const extra of cfg.extraEnvVarNames ?? []) {
      env[extra.name] = extra.subdir ? `${configDir}/${extra.subdir}` : configDir;
    }
    env[cfg.envVarName] = configDir;
    if (env.TERM === undefined || env.TERM === "" || env.TERM === "dumb") env.TERM = "xterm-256color";
    return env;
  }

  private ptyCommandLine(realBin: string, args: string[]): string[] {
    const quoted = [realBin, ...args].map(shellQuote).join(" ");
    return [this.scriptBin as string, "-qfec", quoted, "/dev/null"];
  }

  private onOutput(record: FlowRecord, text: string): void {
    if (record.done) return;
    record.outputTail = `${record.outputTail}${text}`.slice(-2_000);
    const { url, deviceCode } = extractFlowSignals(record.outputTail);
    let changed = false;
    if (url && url !== record.dto.authUrl) {
      record.dto.authUrl = url;
      changed = true;
    }
    if (deviceCode && deviceCode !== record.dto.deviceCode) {
      record.dto.deviceCode = deviceCode;
      changed = true;
    }
    if (changed) this.bumpStatus(record, "waiting");
    this.touch(record);
  }

  private async poll(record: FlowRecord): Promise<void> {
    if (record.done) return;
    try {
      const fingerprint = await this.fingerprint(record.credentialPaths);
      if (
        fingerprint !== undefined &&
        fingerprint !== record.fingerprint &&
        (record.dto.status === "starting" || record.dto.status === "waiting")
      ) {
        record.fingerprint = fingerprint;
        this.bumpStatus(record, "callback");
      } else if (fingerprint !== undefined) {
        record.fingerprint = fingerprint;
      }
    } catch {
      // Probe failures never break the flow.
    }
  }

  private onExit(record: FlowRecord, code: number | null | undefined): void {
    if (record.done) return;
    if (code === 0) {
      this.finish(record, "completed");
      return;
    }
    // A credential write already observed means the login itself worked;
    // a non-zero exit after that is cleanup noise, not a failed login.
    if (record.dto.status === "callback" && record.fingerprint !== record.initialFingerprint) {
      this.finish(record, "completed");
      return;
    }
    const tail = record.outputTail
      .split(/\r?\n/)
      .map((line) => line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
      .filter((line) => line.trim().length > 0)
      .slice(-2)
      .join(" | ");
    this.finish(
      record,
      "failed",
      tail ? tail : `login process exited with code ${code ?? "unknown"}`,
    );
  }

  private bumpStatus(record: FlowRecord, status: LoginFlowStatus): void {
    if (record.done || record.dto.status === status) return;
    record.dto.status = status;
    this.touch(record);
  }

  private finish(record: FlowRecord, status: LoginFlowStatus, error?: string): void {
    if (record.done) return;
    record.done = true;
    this.clearTimers(record);
    record.dto.status = status;
    if (error) record.dto.error = redact(error);
    record.dto.updatedAt = new Date(this.now()).toISOString();
    record.dto.endedAt = record.dto.updatedAt;
    if (!error && status === "failed") {
      record.dto.error = "login process exited with an error";
    }
  }

  private touch(record: FlowRecord): void {
    record.dto.updatedAt = new Date(this.now()).toISOString();
  }

  private killChild(record: FlowRecord): void {
    const child = record.child;
    if (!child || record.killTimer) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    record.killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 3_000);
    record.killTimer.unref?.();
  }

  private clearTimers(record: FlowRecord): void {
    if (record.timer) clearInterval(record.timer);
    if (record.timeout) clearTimeout(record.timeout);
    if (record.killTimer) clearTimeout(record.killTimer);
    record.timer = undefined;
    record.timeout = undefined;
    record.killTimer = undefined;
  }

  private prune(): void {
    const nowMs = this.now();
    const cutoff = new Date(nowMs - this.keepEndedMs).toISOString();
    for (const [flowId, record] of this.flows) {
      if (record.done && (record.dto.endedAt ?? "") < cutoff) this.flows.delete(flowId);
    }
    const ended = [...this.flows.values()].filter((record) => record.done).sort((a, b) =>
      (a.dto.endedAt ?? "").localeCompare(b.dto.endedAt ?? ""),
    );
    for (const record of ended.slice(0, Math.max(0, ended.length - this.maxEndedFlows))) {
      this.flows.delete(record.dto.flowId);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
