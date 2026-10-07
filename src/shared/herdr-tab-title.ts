import { resolveHerdrBinary } from "./herdr-bin.ts";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HerdrChatTool } from "./herdr-chat-source.ts";

export interface HerdrAgentSession {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
}

export interface HerdrTitlePane {
  pane_id: string;
  tab_id: string;
  agent?: string;
  agent_session?: HerdrAgentSession | null;
  terminal_title_stripped?: string | null;
}

export interface HerdrTitleTab {
  tab_id: string;
  label: string;
  number: number;
}

export function formatHerdrChatTitle(text: string): string | undefined {
  const cleaned = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/<environment_context[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .trim();
  if (cleaned.length < 4) return undefined;
  if (/^(help|version|resume|new|continue|quit|exit|clear|status|model)$/i.test(cleaned)) return undefined;
  return cleaned.length > 64 ? `${cleaned.slice(0, 61).trimEnd()}…` : cleaned;
}

export function isAutomaticHerdrTab(tab: HerdrTitleTab, lastAutomaticLabel?: string, persistedLabel?: string): boolean {
  return tab.label === String(tab.number)
    || (lastAutomaticLabel !== undefined && tab.label === lastAutomaticLabel)
    || (persistedLabel !== undefined && tab.label === persistedLabel);
}

const MAX_PERSISTED_LABELS = 256;

async function readTabLabels(path: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

async function writeTabLabels(path: string, labels: Record<string, string>): Promise<void> {
  const entries = Object.entries(labels).slice(-MAX_PERSISTED_LABELS);
  const temp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(Object.fromEntries(entries))}\n`);
  await rename(temp, path);
}

function parseResult<T>(stdout: string, key: string): T | undefined {
  try {
    const root = JSON.parse(stdout) as { result?: Record<string, unknown> };
    return root.result?.[key] as T | undefined;
  } catch {
    return undefined;
  }
}

export async function runTitleHerdr(args: string[], timeoutMs = 900): Promise<{ ok: boolean; stdout: string }> {
  const bin = resolveHerdrBinary();
  if (!bin) return { ok: false, stdout: "" };
  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, stdout });
    };
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 256_000) child?.kill();
      });
      child.on("error", () => finish(false));
      child.on("close", (code: number | null) => finish(code === 0 && stdout.length <= 256_000));
    } catch {
      finish(false);
    }
    timer = setTimeout(() => {
      child?.kill();
      finish(false);
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Owns one wrapped session's title updates. It only follows the pane Herdr
 * resolves for this wrapper process, requires the expected agent and exact
 * session metadata, and only renames an untouched numeric/default tab label. */
export class HerdrTabTitleWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastAutomaticLabel: string | undefined;
  private stopped = false;
  private pinnedPane: HerdrTitlePane | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      agent: string;
      tool: HerdrChatTool;
      configDir: string;
      cwd: string;
      initialPrompt?: string;
      readTitle: (tool: HerdrChatTool, configDir: string, cwd: string, session: HerdrAgentSession) => Promise<string | null>;
      pid?: number;
      runHerdr?: typeof runTitleHerdr;
      /** JSON map of tab_id -> last automatic label; persistence is off when omitted. */
      statePath?: string;
    },
  ) {}

  async start(): Promise<void> {
    if (this.timer || this.stopped) return this.startPromise;
    this.startPromise = this.captureOwnPane();
    await this.startPromise;
    if (this.stopped || !this.pinnedPane) return;
    this.timer = setInterval(() => void this.poll(), 5_000);
    this.timer.unref?.();
    await this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollOnce(): Promise<void> { await this.poll(); }

  private command(args: string[], key: string) {
    return (this.options.runHerdr ?? runTitleHerdr)(args).then((result) => result.ok ? parseResult<unknown>(result.stdout, key) : undefined);
  }

  private async captureOwnPane(): Promise<void> {
    try {
      const pane = await this.command(["pane", "current", "--current"], "pane") as HerdrTitlePane | undefined;
      if (!pane?.pane_id || !pane.tab_id) return;
      const info = await this.command(["pane", "process-info", "--pane", pane.pane_id], "process_info") as { foreground_processes?: Array<{pid?:number}> } | undefined;
      const pid = this.options.pid ?? process.pid;
      if (!info?.foreground_processes?.some((candidate) => candidate.pid === pid)) return;
      const tabs = await this.command(["tab", "list"], "tabs") as HerdrTitleTab[] | undefined;
      const tab = tabs?.find((candidate) => candidate.tab_id === pane.tab_id);
      if (!tab) return;
      const persisted = this.options.statePath ? (await readTabLabels(this.options.statePath))[tab.tab_id] : undefined;
      if (!isAutomaticHerdrTab(tab, undefined, persisted)) return;
      this.pinnedPane = pane;
    } catch {
      // Herdr is optional; failure to prove pane ownership disables updates.
    }
  }

  private async persist(labels: Record<string, string>, tabs: HerdrTitleTab[], tabId: string, title: string): Promise<void> {
    try {
      const live = new Set(tabs.map((candidate) => candidate.tab_id));
      const next = Object.fromEntries(Object.entries(labels).filter(([id]) => live.has(id) && id !== tabId));
      next[tabId] = title;
      await writeTabLabels(this.options.statePath!, next);
    } catch {
      // Persistence is best-effort; the in-memory label still protects this session.
    }
  }

  private async poll(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const panes = await this.command(["pane", "list"], "panes") as HerdrTitlePane[] | undefined;
      const pane = panes?.find((candidate) => candidate.pane_id === this.pinnedPane?.pane_id);
      if (!pane?.pane_id || pane.tab_id !== this.pinnedPane?.tab_id || pane.agent !== this.options.agent) return;
      const session = pane.agent_session;
      if (!session || session.agent !== this.options.agent || !session.value) return;
      const tabs = await this.command(["tab", "list"], "tabs") as HerdrTitleTab[] | undefined;
      const tab = tabs?.find((candidate) => candidate.tab_id === pane.tab_id);
      if (!tab) return;
      const labels = this.options.statePath ? await readTabLabels(this.options.statePath) : undefined;
      if (!isAutomaticHerdrTab(tab, this.lastAutomaticLabel, labels?.[tab.tab_id])) {
        this.stop();
        return;
      }

      const transcriptTitle = await this.options.readTitle(
        this.options.tool,
        this.options.configDir,
        this.options.cwd,
        session,
      );
      if (this.stopped) return;
      const terminalTitle = pane.terminal_title_stripped ?? "";
      const terminalCandidate = formatHerdrChatTitle(terminalTitle);
      const usefulTerminalTitle = terminalCandidate && !new Set([
        this.options.agent.toLowerCase(),
        this.options.tool.toLowerCase(),
        `${this.options.tool} code`,
        "shell",
        "zsh",
        "bash",
      ]).has(terminalCandidate.toLowerCase())
        ? terminalCandidate
        : undefined;
      const title = formatHerdrChatTitle(transcriptTitle ?? "")
        ?? (!this.lastAutomaticLabel ? formatHerdrChatTitle(this.options.initialPrompt ?? "") : undefined)
        ?? usefulTerminalTitle;
      if (!title || title === tab.label) {
        return;
      }
      if (this.stopped) return;
      const renamed = await (this.options.runHerdr ?? runTitleHerdr)(["tab", "rename", pane.tab_id, title]);
      if (renamed.ok) {
        this.lastAutomaticLabel = title;
        if (this.options.statePath) await this.persist(labels ?? {}, tabs ?? [], pane.tab_id, title);
      }
    } catch {
      // Herdr is optional. A transient socket or session-reader failure must
      // never affect the wrapped agent.
    } finally {
      this.running = false;
    }
  }
}

/** Extracts explicit prompt text from common interactive and print-mode
 * arguments. It deliberately ignores switches and bare subcommands. */
export function promptFromCliArgs(tool: string, args: string[]): string | undefined {
  const valueFlags = new Set(["-p", "--prompt", "--message", "--input"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--prompt=") || arg.startsWith("--message=") || arg.startsWith("--input=")) {
      return formatHerdrChatTitle(arg.slice(arg.indexOf("=") + 1));
    }
    if (valueFlags.has(arg) && args[index + 1]) return formatHerdrChatTitle(args[index + 1] as string);
  }
  const positional = args.filter((arg) => !arg.startsWith("-") && !/^(exec|run|agent|--?version|--?help)$/i.test(arg));
  if (tool === "codex" && args[0] === "exec") return formatHerdrChatTitle(positional.slice(1).join(" "));
  if (["grok", "kimi", "opencode"].includes(tool) && ["run", "agent"].includes(args[0] ?? "")) {
    return formatHerdrChatTitle(positional.slice(1).join(" "));
  }
  return undefined;
}
