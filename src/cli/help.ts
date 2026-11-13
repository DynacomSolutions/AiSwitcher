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
      "route-all-via-gateway": sub("ais identities route-all-via-gateway [--dry-run]", "Move each login the gateway holds into its member store, back up and replace it with the gateway entry"),
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
    usage: "ais usage [breakdown|service install|import-batch] [--identity=] [--tool=] [--json]",
    desc: "Token usage and cost, grouped by provider",
    flags: [
      ["--days=30", "breakdown window"],
      ["<tokscale args>", "anything else runs tokscale, e.g. `ais usage tui`"],
    ],
    examples: ["ais usage --json", "ais usage breakdown --days=7", "ais usage service install"],
    subs: {
      breakdown: sub("ais usage breakdown [identity] [--tool=] [--days=30] [--json]", "Per-tool-call breakdown"),
      service: sub("ais usage service install", "Install the bounded Linux user collector unit"),
      "import-batch": sub("ais usage import-batch <batch-manifest.json> [--dry-run] [--json]", "Keep sessions an older batch copy has and the current batch lost"),
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
  gateway: {
    usage: "ais gateway serve|local|app|usage|store|claude-proxy|t3-proxy|codex-home ...",
    desc: "AI Gateway: token-authenticated proxy over AIS logins",
    examples: ["AIS_GATEWAY_DATABASE_URL=postgres://... AIS_GATEWAY_ADMIN_TOKEN=... ais gateway serve"],
    subs: {
      serve: sub("ais gateway serve [--port=] [--admin-port=]", "Run the proxy and admin API (env: AIS_GATEWAY_PORT, AIS_GATEWAY_ADMIN_PORT, AIS_GATEWAY_DATABASE_URL, AIS_GATEWAY_ADMIN_TOKEN; PostgreSQL credential store: AIS_GATEWAY_CREDENTIAL_STORE=pg, AIS_GATEWAY_STORE_KEY, AIS_GATEWAY_FILE_STORE, AIS_GATEWAY_STORE_IMPORT, AIS_GATEWAY_REPLICA_URL)"),
      store: sub("ais gateway store import [--dry-run] | sync [--once] | setup --key-file=<path>", "import: copy this host's gateway logins, registries and heartbeat into the PostgreSQL credential store; idempotent, a login is only replaced by a fresher one (env: AIS_GATEWAY_DATABASE_URL, AIS_GATEWAY_STORE_KEY). sync: keep this host's login files in step with the store (gateway refreshes written back, new host logins pushed; newest token wins); the profile-sync daemon runs it whenever the store is configured. setup: record the store's database URL (stdin) and key in ~/.secrets for sync (env or ~/.secrets: AIS_GATEWAY_STORE_DATABASE_URL, AIS_GATEWAY_STORE_KEY or AIS_GATEWAY_STORE_KEY_FILE)"),
      local: sub("ais gateway local [install|status]", "Host-local failover proxy on 127.0.0.1 (env: AIS_GATEWAY_LOCAL_PORT, AIS_GATEWAY_REMOTE_URL); install sets up the ais-gateway-local.service user unit"),
      app: sub(
        "ais gateway app add|update <name> --namespace=<ns> --provider=<p> [--style=anthropic|openai] (--pool [--identities=a,b] | --identity=<id>) [--models=glob,glob] [--daily-tokens=N] [--reserve=100]; app list|show|rotate|revoke [<name>]",
        "Manage gateway apps; add and rotate write Secret ais-gateway-<app> and ~/.secrets (admin: AIS_GATEWAY_ADMIN_URL, AIS_GATEWAY_ADMIN_TOKEN, AIS_GATEWAY_PROXY_URL in ~/.secrets)",
      ),
      usage: sub("ais gateway usage [--app=] [--provider=] [--days=7] [--json]", "Tokens used per app"),
      "claude-proxy": sub(
        "ais gateway claude-proxy <claude config dir>... [--proxy=<url>] [--ca=<path>] [--check]",
        "Point Claude folders at the gateway usage proxy (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, always with a loopback NO_PROXY); --check only reports folders whose proxy would break a loopback base URL (proxy: AIS_GATEWAY_CONNECT_PROXY_URL in ~/.secrets or env; CA default ~/.ais/gateway-connect-ca.pem)",
      ),
      "t3-proxy": sub(
        "ais gateway t3-proxy [--proxy=<url>] [--ca=<path>] [--check] [--remove]",
        "Route api.anthropic.com for the T3 Code server only (not its children) through the gateway CONNECT proxy so T3's account usage and reset credits come from the gateway: installs ~/.ais/t3/anthropic-proxy.cjs and sets NODE_OPTIONS (--require), AIS_T3_ANTHROPIC_PROXY and NODE_EXTRA_CA_CERTS in ~/.t3/service.env (T3CODE_HOME honoured; never HTTPS_PROXY); --check only reports, --remove undoes it; restart T3 to apply (never done here)",
      ),
      "codex-home": sub(
        "ais gateway codex-home <codex home dir>... [--check]",
        "Set up Codex folders on the gateway so Codex and T3 Code show real usage limits: placeholder ChatGPT login (auth.json 0600, token from AIS_GATEWAY_APP_<APP>_TOKEN in ~/.secrets), chatgpt_base_url, requires_openai_auth; registers the folder in ~/.ais/gateway-codex-homes.json so app add/rotate refresh its token; --check only reports",
      ),
    },
  },
  browser: {
    usage: "ais browser approve|list|revoke|agent-token|extension|mcp ...",
    desc: "AIS Browser: bind Chrome extensions to an identity or swap pool; agent tokens",
    examples: ["ais browser approve ABCD2345 --identity=work --name=work-chrome"],
    subs: {
      approve: sub("ais browser approve <code> (--identity=<id> | --pool=<pool>) [--name=<n>]", "Approve a pairing code shown by the extension and bind that profile to the target"),
      list: sub("ais browser list [--json]", "List browser bindings"),
      revoke: sub("ais browser revoke <name>", "Revoke a browser binding and drop its connection"),
      "agent-token": sub(
        "ais browser agent-token <identity> [--revoke]",
        "Mint an agent token (replacing any earlier one); written to <configDir>/ais-browser-token (0600) for claude and codex and to ~/.secrets as AIS_BROWSER_AGENT_<IDENTITY>_TOKEN, never printed. --revoke removes it",
      ),
      extension: sub(
        "ais browser extension path | update [--from=<zip>]",
        "path prints the folder to Load unpacked (~/.ais/browser-extension); update installs the latest ais-browser-extension.zip release asset there atomically (gh, else GITHUB_TOKEN/GH_TOKEN), or --from=<zip> for a local file",
      ),
      mcp: sub("ais browser mcp", "Stdio MCP server exposing the browser tools; started by Claude and Codex launches that have an agent token (not for manual use)"),
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
