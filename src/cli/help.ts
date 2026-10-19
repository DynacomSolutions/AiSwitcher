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
  update: { usage: "ais update", desc: "Re-download the latest ais and wrapper binaries" },
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
    usage: "ais usage [breakdown] [--identity=] [--tool=] [--json]",
    desc: "Token usage and cost, grouped by provider",
    flags: [
      ["--days=30", "breakdown window"],
      ["<tokscale args>", "anything else runs tokscale, e.g. `ais usage tui`"],
    ],
    examples: ["ais usage --json", "ais usage breakdown --days=7"],
    subs: { breakdown: sub("ais usage breakdown [identity] [--tool=] [--days=30] [--json]", "Per-tool-call breakdown") },
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
      usage: sub("ais swap <tool> usage", "Per-member usage split (claude, codex)"),
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

/** Closest valid names first (prefix or substring), else all of them. */
function nearest(word: string, candidates: string[]): string {
  const hits = candidates.filter((c) => c.startsWith(word.slice(0, 2)) || c.includes(word) || word.includes(c));
  return (hits.length ? hits : candidates).join(", ");
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
    throw new CliUsageError(`Unknown ${group} subcommand "${subName}". Valid: ${nearest(subName, Object.keys(node.subs ?? {}))}`);
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
  if (head.includes("-h") || head.includes("--help")) return words;
  if (words[0] && words[0] in HELP && words[1] === "help") return [words[0]];
  return undefined;
}

export const validCommands = (): string => Object.keys(HELP).join(", ");
