import { bold, cyan, dim } from "./colors.ts";
import { CliUsageError } from "./errors.ts";

/** One help node: a command group, or a subcommand of one. Single source for
 * `ais help`, `ais <group> help|--help|-h`, `ais help <group>` and
 * `ais <group> <sub> --help`. Keep it terse; long prose belongs in docs/. */
interface HelpNode {
  usage: string;
  desc: string;
  flags?: Array<[string, string]>;
  examples?: string[];
  subs?: Record<string, HelpNode>;
}

const TOOL = "--tool=<tool>";
const sub = (usage: string, desc: string): HelpNode => ({ usage, desc });

export const HELP: Record<string, HelpNode> = {
  version: { usage: "ais version", desc: "Print the installed version" },
  update: { usage: "ais update [--no-backup]", desc: "Re-download the latest ais and wrapper binaries (backs up tool configs first unless --no-backup)" },
  upgrade: { usage: "ais upgrade", desc: "Install or upgrade every real CLI the shims need" },
  identities: {
    usage: "ais identities [subcommand] [flags]",
    desc: "Manage identities",
    flags: [[TOOL, "claude|codex|grok|kimi|zai|ali|pi|opencode; optional when the name is unique"]],
    examples: ["ais identities list --tool=claude", "ais identities create --tool=codex --name=work"],
    subs: {
      list: sub(`ais identities [list] [${TOOL}]`, "List identities (default)"),
      show: sub(`ais identities show <name> [${TOOL}]`, "Show one identity in full"),
      create: sub(`ais identities create ${TOOL} [--name=] [--api-key=]`, "Create one (prompts for anything omitted)"),
      update: sub(`ais identities update <name> ${TOOL} [--label=] [--api-key=]`, "Change label, description, configDir or key"),
      delete: sub(`ais identities delete <name> ${TOOL} --yes`, "Remove from the registry; configDir stays on disk"),
      retire: sub(`ais identities retire <name> [${TOOL}] [--yes]`, "Retire: never selected again, credentials deleted"),
      unretire: sub(`ais identities unretire <name> [${TOOL}]`, "Restore a retired identity (sign in again)"),
      "add-directory": sub(`ais identities add-directory <name> <pattern> ${TOOL}`, "Select this identity in a directory"),
      "remove-directory": sub(`ais identities remove-directory <name> <pattern> ${TOOL}`, "Drop a directory pattern"),
      "add-alias": sub(`ais identities add-alias <name> <alias> ${TOOL}`, "Add an alias"),
      "remove-alias": sub(`ais identities remove-alias <name> <alias> ${TOOL}`, "Remove an alias"),
      "chrome-overrides": sub(
        `ais identities chrome-overrides list|add|remove [${TOOL}] [--directories=a,b] [--target-identity=<name>] [<index>]`,
        "Per-directory Chrome identity overrides",
      ),
    },
  },
  usage: {
    usage: "ais usage [breakdown|service install] [--identity=] [--tool=] [--json]",
    desc: "Token usage and cost, grouped by provider",
    flags: [
      ["--days=30", "breakdown window"],
      ["<tokscale args>", "anything else runs tokscale, e.g. `ais usage tui`"],
    ],
    examples: ["ais usage --json", "ais usage breakdown --days=7", "ais usage service install"],
    subs: {
      breakdown: sub("ais usage breakdown [identity] [--tool=] [--days=30] [--json]", "Per-tool-call breakdown"),
      service: sub("ais usage service install", "Install the bounded Linux user collector unit"),
    },
  },
  limits: {
    usage: "ais limits [identity] [--tool=] [--json|--watch|--cached|--compact]",
    desc: "Live 5h, weekly and monthly rate-limit use",
    flags: [
      ["--watch", "redraw every --interval=30 seconds"],
      ["--cached", "no live calls"],
      ["--compact", "one line each"],
    ],
    examples: ["ais limits --compact", "ais limits work --tool=claude --watch"],
  },
  auth: {
    usage: "ais auth <login|enable|refresh|import> [identity] [flags]",
    desc: "Credentials: login, renewal, import",
    examples: ["ais auth refresh work --tool=claude"],
    subs: {
      login: sub("ais auth login <identity> --tool=ali", "Interactive SSH auth browser"),
      enable: sub("ais auth enable <identity> --tool=ali", "Renew the ali cookie every 10 minutes"),
      refresh: sub("ais auth refresh <identity> --tool=ali|codex|claude|grok|kimi", "Renew credentials without re-login"),
      import: sub("ais auth import <pi-id> --tool=pi --claude=<id> [--codex= --grok= --kimi= --zai= --ali= --opencode-go]", "Merge provider credentials into a Pi identity"),
    },
  },
  swap: {
    usage: "ais swap <claude|codex|kimi|pi> [subcommand]",
    desc: "Swap pools: switch a login between member accounts",
    examples: ["ais swap claude status", "ais swap claude next --if-limited"],
    subs: {
      status: sub("ais swap <tool> [status] [pool] [--json]", "Members, active marker, usage, allowed flag"),
      to: sub("ais swap <tool> to <account> [--pool=]", "Swap to a member"),
      next: sub("ais swap <tool> next [--if-limited] [--pool=]", "Swap to the member with most headroom"),
      "allow|disallow": sub("ais swap <tool> allow|disallow <account>", "Edit the allowed accounts"),
      auto: sub("ais swap <tool> auto on|off [--threshold=95]", "Automatic swap near the limit"),
      pool: sub("ais swap <tool> pool create <name> --accounts=a,b [--config-dir=]", "Create a pool identity"),
      hook: sub("ais swap claude hook on|off [--pool=]", "Optional StopFailure rate-limit hook (claude only)"),
      usage: sub("ais swap <tool> usage [--json] [--scan]", "Per-member usage split (claude, codex); claude --json reads the collector snapshot, --scan forces a live scan"),
    },
  },
  "claude-swap": { usage: "ais claude-swap [subcommand]", desc: 'Alias of "ais swap claude"; see "ais swap help"' },
  sync: {
    usage: "ais sync <subcommand>",
    desc: "Merge and recover profiles over SSH or locally",
    examples: ["ais sync add my-host", "ais sync now --pull-only"],
    subs: {
      list: sub("ais sync list", "List sync hosts"),
      add: sub("ais sync add <ssh-host>", "Add an SSH-config alias"),
      remove: sub("ais sync remove <ssh-host>", "Remove a host"),
      now: sub("ais sync now [--pull-only|--push-only]", "Exchange now"),
      dedupe: sub("ais sync dedupe [--dry-run]", "Enforce or preview session deduplication"),
      recover: sub("ais sync recover [--dry-run]", "Restore histories kept by older conflict archives"),
    },
  },
  live: {
    usage: "ais live <net-check|apply-inbox --stdin|write-outbox>",
    desc: "Live image diagnostics, inbox and outbox",
    subs: {
      "net-check": sub("ais live net-check [--json] [--fresh]", "Check internet and local model readiness"),
      "apply-inbox": sub("ais live apply-inbox --stdin", "Apply a verified inbox tar from standard input"),
      "write-outbox": sub("ais live write-outbox", "Write a portable outbox tar to standard output"),
    },
  },
  statusline: { usage: "ais statusline [--wrap <command>]", desc: "Claude Code statusLine: run <command>, then print cached usage bars" },
  memory: {
    usage: "ais memory [show|path|init|edit|add] [--stdin]",
    desc: "Machine-local memory shared by every agent",
    subs: {
      show: sub("ais memory [show]", "Print the memory"),
      path: sub("ais memory path", "Print the file path"),
      init: sub("ais memory init", "Create the file"),
      edit: sub("ais memory edit", "Open in $VISUAL or $EDITOR"),
      add: sub("ais memory add <text...> | --stdin", "Append an entry"),
    },
  },
  doctor: { usage: "ais doctor [--identity=] [--tool=] [--json]", desc: "Probe each identity for a hung or stuck session" },
  resume: { usage: "ais resume [session-id] [--identity=] [--tool=] [--json]", desc: "Pick or resume a session started in this directory" },
  web: {
    usage: "ais web [start|stop|status|open] [--port=] [--foreground]",
    desc: "Local web console",
    subs: {
      start: sub("ais web start [--port=] [--foreground]", "Start the console"),
      stop: sub("ais web stop", "Stop it"),
      status: sub("ais web status", "Show state"),
      open: sub("ais web open", "Open it in a browser"),
    },
  },
  tui: { usage: "ais tui", desc: "Terminal dashboard on the local console API" },
  host: {
    usage: "ais host --stdio",
    desc: "Private framed transport endpoint for host-app sync",
  },
  launch: { usage: "ais launch", desc: "Pick a tool, then an identity or pool, and start it" },
  local: {
    usage: "ais local [list|start [name]] [--json]",
    desc: "Local models: list them, or start one",
    subs: {
      list: sub("ais local [list] [--json]", "List local models and the runner (default)"),
      start: sub("ais local start [name]", "Start a model (the only one when name is omitted)"),
    },
  },
  herdr: { usage: "ais herdr [--remote=<ssh-target>] [--remote-ais] [--raw] [--panel-width=42]", desc: "herdr beside an ais overview panel" },
  help: { usage: "ais help [command [subcommand]]", desc: "Show help; also `ais <command> help` or `--help`" },
};

function table(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, d]) => `  ${cyan(k.padEnd(width))}  ${dim(d)}`).join("\n");
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The 3 closest names: prefix or substring matches rank first, then edit distance. */
function nearest(word: string, candidates: string[]): string {
  const score = (c: string): number => (c.startsWith(word) || c.includes(word) ? 0 : distance(word, c));
  return [...candidates].sort((a, b) => score(a) - score(b)).slice(0, 3).join(", ");
}

/** Resolve a help path (group, then optional subcommand) or throw a one-line error. */
function resolve(path: string[]): { node: HelpNode; title: string } {
  const [group, subName] = path;
  const node = group === undefined ? undefined : HELP[group];
  if (group === undefined || !node) {
    throw new CliUsageError(`Unknown command "${group}". Did you mean: ${nearest(group ?? "", Object.keys(HELP))}`);
  }
  if (subName === undefined) return { node, title: group };
  const leaf = node.subs && Object.hasOwn(node.subs, subName) ? node.subs[subName] : undefined;
  if (!leaf) {
    throw new CliUsageError(`Unknown ${group} subcommand "${subName}". Did you mean: ${nearest(subName, Object.keys(node.subs ?? {}))}`);
  }
  return { node: leaf, title: `${group} ${subName}` };
}

export function helpText(path: string[] = []): string {
  if (path.length === 0) {
    return [
      `${bold("ais")}: manage identities and AI CLI binaries`,
      "",
      bold("Usage:") + "  ais <command> [subcommand] [flags]",
      "        ais help <command>   (or: ais <command> help)",
      "",
      bold("Commands:"),
      table(Object.entries(HELP).map(([k, n]): [string, string] => [k, n.desc])),
    ].join("\n");
  }
  const { node } = resolve(path);
  const out = [`${bold("Usage:")} ${node.usage}`, node.desc];
  if (node.subs) out.push("", bold("Subcommands:"), table(Object.entries(node.subs).map(([k, n]): [string, string] => [k, n.desc])));
  if (node.flags) out.push("", bold("Flags:"), table(node.flags));
  if (node.examples) out.push("", bold("Examples:"), ...node.examples.map((e) => `  ${e}`));
  return out.join("\n");
}

/** Help path requested by argv, or undefined when argv is a normal command.
 * Handles: no args, `help [path]`, `-h`/`--help` anywhere before `--`, and
 * `<group> help`. */
export function helpRequest(argv: string[]): string[] | undefined {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const words = head.filter((a) => !a.startsWith("-"));
  if (argv.length === 0) return [];
  if (words[0] === "help") return words.slice(1);
  // `ais usage --help` belongs to tokscale; only our own `breakdown` has ais help.
  if (words[0] && Object.hasOwn(HELP, words[0]) && words[1] === "help") return [words[0]];
  if (words[0] === "usage" && words[1] !== "breakdown") return undefined;
  if (head.includes("-h") || head.includes("--help")) return words;
  return undefined;
}
