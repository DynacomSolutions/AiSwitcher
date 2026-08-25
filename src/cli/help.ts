import { bold, cyan, dim } from "./colors.ts";

const COMMANDS: Array<[string, string]> = [
  ["version", "Print the installed ais version"],
  ["update", "Re-download the latest claude/codex/grok/kimi/zai/ali/pi/open/ais binaries"],
  ["upgrade", "Install or upgrade every real CLI required by the installed AIS shims"],
  ["sync list|add|remove|now|dedupe|recover", "Merge/recover profiles over SSH or locally"],
  ["identities [list] [--tool=claude|codex|grok|kimi|zai|ali|pi]", "List identities (default; omit --tool to show all)"],
  ["identities show <name> [--tool=]", "Show one identity's full detail"],
  ["identities create --tool=<t> [--name=] ...", "Create an identity (prompts for anything omitted)"],
  ["identities update <name> --tool=<t> ...", "Update label/description/configDir"],
  ["identities delete <name> --tool=<t> --yes", "Remove from the registry (configDir is left on disk)"],
  ["identities add-directory <name> <pattern> --tool=<t>", ""],
  ["identities remove-directory <name> <pattern> --tool=<t>", ""],
  ["identities add-alias <name> <alias> --tool=<t>", ""],
  ["identities remove-alias <name> <alias> --tool=<t>", ""],
  ["identities chrome-overrides list [--tool=]", ""],
  ["identities chrome-overrides add --tool=<t> --directories=a,b --target-identity=<name> [--label=]", ""],
  ["identities chrome-overrides remove --tool=<t> <index>", ""],
  ["usage [--identity=] [--tool=] [--json]", "Provider-grouped token usage & cost from every client, including Pi"],
  ["usage [--identity=] [--tool=] <tokscale args>", "Full tokscale (tui/graph/monthly/pricing/...), scoped"],
  ["limits [identity] [--tool=] [--json|--watch|--cached]", "Live 5h/weekly/monthly rate-limit usage per identity"],
  ["auth login|refresh|enable <identity> --tool=ali", "SSH-only interactive auth browser and 10-minute cookie renewal"],
  ["auth import <pi-id> --tool=pi --claude=<id> ...", "Merge provider credentials into one Pi identity"],
  ["doctor [--identity=] [--tool=] [--json]", "Live responsiveness probe per identity — catches a hung/stuck identity"],
  ["resume [session-id] [--identity=] [--tool=] [--json]", "Interactive tree picker (or direct launch) for resumable sessions"],
  ["help", "Show this message"],
];

const NOTES = `--tool is required for "create"; every other name-targeted "identities"
mutation auto-resolves --tool when the name exists in only one of the
claude/codex/grok/kimi/zai/ali/pi registries, and requires --tool when it exists in more than
one (or none). "list"/"show"/"chrome-overrides list" default to showing all
registries when --tool is omitted.

"auth import <pi-id> --tool=pi" accepts any of --claude=<id>, --codex=<id>,
--grok=<id>, --kimi=<id>, --zai=<id>, --ali=<id>, and bare --opencode-go.
The OpenCode Go flag reads OPENCODE_API_KEY or securely prompts for it; the key
is never accepted in argv. It merges those credentials into Pi's auth.json
without printing secret values. Alibaba's
configured Crush model catalogue is translated into Pi's models.json, so no
third-party Pi extension is required.

"sync add <ssh-host>" stores one or more SSH-config aliases in
~/.ais/config/sync-v2.json. After every top-level wrapped-tool launch, a
detached worker pulls, merges, and pushes profile/session files with
stable-session-ID deduplication without delaying the real agent;
changes made during a live session are debounced and reconciled again, with a
detached final pull/merge/push after exit. Authentication is always non-interactive
(BatchMode=yes), so an unavailable or unauthorised host warns and never
blocks the real AI CLI. "sync now" runs the same exchange explicitly;
--pull-only and --push-only narrow its direction. Deletes are not propagated,
copied usage is counted once, and divergent session events are unioned.
"sync dedupe [--dry-run]" enforces or previews the same invariant locally.
"sync recover [--dry-run]" additively restores histories retained by older
AIS conflict/dedupe archives without deleting those recovery copies.

"identities create --tool=zai|ali [--api-key=]" (and "update ... --api-key="
to rotate it later) writes the key straight into that identity's own Crush
config (crush.json): neither zai nor ali has an interactive login of its
own to fall back on the way claude/codex/grok/kimi do, so without a key an
identity is created but unusable until one is supplied, either now or later
via update. Omitting --api-key at creation time just prompts for it instead
(blank is fine, set it up manually later).

"usage" reads each matched identity's local history (tokscale for Claude,
Codex, Grok, and Kimi; native Crush/Pi records for the others), then merges
the same provider+identity across clients. The table and --json output name
providers, not wrapper tools. Omit both flags to report every identity;
--tool remains a collection-source filter. --identity matching more than one
registry shows every match and merges compatible provider rows, not an error.
Pi CLI/party adapters are attributed to their upstream providers and are not
counted again when their native Claude/Codex history is also collected.

"usage <tokscale args>" (e.g. "usage tui") instead execs the real tokscale
directly with those args (tui, graph, monthly, hourly, pricing, report,
wrapped, the social commands — anything tokscale supports), with full
terminal passthrough so the interactive TUI works. A literal "--" before the
args is optional, only needed if the first arg would otherwise look like one
of --identity=/--tool=/--json. --identity scopes it to exactly one identity
(pass --tool= too if that name exists in more than one registry); omit
--identity to merge every configured identity into one process instead of
tokscale's own empty-by-default scan roots — right for both "show me
everything" (tui, etc.) and identity-agnostic commands like "pricing".

"resume" scans every configured identity's claude/codex/grok/kimi/zai/ali session
data directly (no subprocess, no live API) for sessions whose OWN recorded working
directory matches where you ran "ais resume" from — not a substring/prefix
match, and not any single tool's own notion of "current directory" (grok's
own --continue/sessions list silently collapse to the enclosing git root;
this does not). Run from a real terminal with no session id, it shows the
same tool/identity tree "limits" does as an interactive picker (arrow keys
navigate between sessions only, Enter resumes the highlighted one, Ctrl+C
cancels); piped/redirected, or with nothing to resume, it prints that same
tree once instead. An exact session id skips the picker and resumes that
session directly, and is stable across runs. --identity/--tool narrow which
registries are scanned, same as "usage".

"limits" is a different data source than "usage" — tokscale counts historical
tokens from local logs; "limits" shows each provider's live server-side quota
(the same 5h/weekly window "/usage" shows interactively in Claude/Grok, or
Codex's statusline). claude, codex, kimi, and zai are all fetched live (a
real, cheap, read-only call per identity — zai's hits Z.ai's own quota API
with the key from that identity's crush.json); grok has no on-demand API at
all, so it's a best-effort read of the last observed usage from its own
local activity log — always flagged as "as of <time> ago", never presented
as live. Alibaba's Token plan has no API-key quota endpoint, so ali reads the
same live windows through its OneConsole gateway with the valid console Cookie
header stored in that identity's console-cookie.txt. "identity" is a
positional (e.g. "ais limits identity-a"), not
--identity=. --cached skips every live call (claude/codex/kimi/zai report
"not available" without one; grok is unaffected since it never makes a live
call anyway). --watch redraws in place on an interval (--interval=<seconds>,
default 30) instead of printing once; degrades to a single plain run if
stdout isn't a TTY.

"doctor" is a health check, not a usage/billing report: it sends one real,
minimal turn per identity (claude/grok: a plain -p prompt, with claude's MCP
servers disabled via --strict-mcp-config so a slow/misconfigured MCP server
can't produce a false positive; codex: reuses "limits"'s existing app-server
handshake) and reports whether the real binary answered within a hard
timeout (20s for claude/grok, ~9s for codex). "hung" means the process
itself never responded — not a rate-limit or billing condition, and not
something "limits" or "usage" can tell you, since both only report data a
live process actually returned. Confirmed real-world cause of at least one
incident: too many orphaned/still-running concurrent agent sessions under
one identity made every subsequent prompt on that identity hang indefinitely
while auth stayed valid and fast throughout — closing those agents fixed it
immediately. --identity/--tool narrow which identities are probed, same as
"usage"/"limits".`;

// Column width is computed only from commands that actually carry a
// description — the long, description-less chrome-overrides commands would
// otherwise blow the aligned column out to their length instead.
function formatCommands(): string {
  const withDesc = COMMANDS.filter(([, desc]) => desc);
  const width = Math.max(...withDesc.map(([cmd]) => cmd.length));
  return COMMANDS.map(([cmd, desc]) =>
    desc ? `  ${cyan(cmd.padEnd(width))}  ${dim(desc)}` : `  ${cyan(cmd)}`,
  ).join("\n");
}

export function runHelp(): void {
  console.log(`${bold("ais")} — manage AiProfileSwitcher identities and installed binaries

${bold("Usage:")}
  ais <command> [subcommand] [args] [flags]

${bold("Commands:")}
${formatCommands()}

${bold("Notes:")}
${NOTES}
`);
}
