// Blocks hostnames, domains, emails, IP literals and identifying home paths
// from entering the tracked tree, except for the reviewed allowlist in
// scripts/identifier-allowlist.ts. Companion to scripts/privacy-check.ts
// (which guards private per-machine identifiers pulled from local AIS
// registries); this script guards PUBLIC identifiers that must never be
// hardcoded into this repository at all, allowlist aside.
//
// Modes mirror privacy-check.ts:
//   --tree                   scan every tracked file's working-tree content (full lint)
//   --staged                 scan the indexed diff (pre-commit)
//   --pre-push <remote>      scan outgoing commits, reading update lines from stdin
//   --range <base> <head>    scan an explicit commit range
//   --ci                     scan IDENTIFIER_BASE_SHA..IDENTIFIER_HEAD_SHA (or push before/after)
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { ALLOWED_DOMAINS, EXCLUDED_TLDS } from "./identifier-allowlist.ts";
import { REAL_TLDS } from "./identifier-tlds.ts";

export interface Finding {
  location: string;
  rule: string;
  detail: string;
}

function fail(): never { throw new Error("identifier-scan: operation failed"); }

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail();
  return result.stdout.toString();
}

// ---- domain / TLD matching -------------------------------------------------

const DOMAIN_RE = /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,24}\b/g;

export function isAllowedDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return ALLOWED_DOMAINS.some(entry => lower === entry.domain || lower.endsWith(`.${entry.domain}`));
}

export function findDomains(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(DOMAIN_RE)) {
    const token = match[0];
    const lastDot = token.lastIndexOf(".");
    const tld = token.slice(lastDot + 1).toLowerCase();
    if (EXCLUDED_TLDS.has(tld)) continue;
    if (!REAL_TLDS.has(tld)) continue;
    if (isAllowedDomain(token)) continue;
    found.push(token);
  }
  return found;
}

// ---- code-aware segment extraction ----------------------------------------
// Source files mix real identifiers into quoted strings/comments and plain
// property-access chains (`process.env`, `identity.name`, ...) that are NOT
// hostnames. Restricting domain matching to string/comment content for code
// files removes that whole false-positive class without needing a full
// parser; plain-text/config files (README, YAML, Dockerfile, ...) are
// scanned in full since they have no such ambiguity.
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".rs"]);

export interface CommentState { inBlock: boolean }

export function scannableSegments(path: string, line: string, state: CommentState): string[] {
  if (!CODE_EXTENSIONS.has(extname(path))) return [line];
  const segments: string[] = [];
  let work = line;
  if (state.inBlock) {
    const end = work.indexOf("*/");
    if (end === -1) { segments.push(work); return segments; }
    segments.push(work.slice(0, end));
    work = work.slice(end + 2);
    state.inBlock = false;
  }
  const blockStart = work.indexOf("/*");
  if (blockStart !== -1) {
    const blockEnd = work.indexOf("*/", blockStart + 2);
    if (blockEnd === -1) {
      segments.push(work.slice(blockStart + 2));
      state.inBlock = true;
      work = work.slice(0, blockStart);
    } else {
      segments.push(work.slice(blockStart + 2, blockEnd));
      work = work.slice(0, blockStart) + work.slice(blockEnd + 2);
    }
  }
  const lineCommentIdx = work.indexOf("//");
  if (lineCommentIdx !== -1) {
    segments.push(work.slice(lineCommentIdx));
    work = work.slice(0, lineCommentIdx);
  }
  const stringRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = stringRe.exec(work))) segments.push(match[0]);
  return segments;
}

// ---- IP literals ------------------------------------------------------------
// Blocked except loopback and the RFC 5737 / RFC 3849 documentation ranges.
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;

function ipv4Allowed(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true; // 0.0.0.0 bind-all address
  return false;
}

// Browser/engine User-Agent strings embed dotted version numbers
// ("Chrome/143.0.0.0") that are syntactically indistinguishable from an
// IPv4 literal; only the preceding "<Name>/" context tells them apart.
const UA_VERSION_PREFIX = /\b(?:Chrome|Safari|Firefox|AppleWebKit|Version|Edge|Edg|OPR|Mobile|CriOS|FxiOS|Gecko)\/$/;

export function findIps(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IPV4_RE)) {
    const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
    if (octets.some(n => n > 255)) continue; // not a real IPv4 literal (e.g. a version-ish number)
    if (ipv4Allowed(octets)) continue;
    if (UA_VERSION_PREFIX.test(text.slice(0, match.index))) continue;
    found.push(match[0]);
  }
  for (const match of text.matchAll(IPV6_RE)) {
    const token = match[0];
    if (token === "::1") continue; // loopback
    if (/^2001:0?db8:/i.test(token)) continue; // 2001:db8::/32 documentation range
    // A bare run of hex groups joined by ':' is also how Rust/TS type
    // annotations and match arms sometimes read (`a:b:c`); require at least
    // 3 colon-separated groups so short, unrelated tokens are not flagged.
    if (token.split(":").length < 4) continue;
    found.push(token);
  }
  return found;
}

// ---- emails ------------------------------------------------------------------
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,24})\b/g;

export function findEmails(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(EMAIL_RE)) {
    if (isAllowedDomain(match[1]!)) continue;
    found.push(match[0]);
  }
  return found;
}

// ---- identifying home paths ---------------------------------------------------
// Keep aligned with scripts/privacy-check.ts's EXAMPLE_HOMES: placeholder
// usernames that are deliberate examples, never an inferred allowlist of
// real local accounts.
const EXAMPLE_HOME_USERS = new Set([
  "example", "user", "username", "test", "testuser", "test-user",
  "example-user", "fixture-user", "synthetic-user", "user-a", "user-b",
  "me", "ci", "admin", "deploy", "ais", "runner",
  // Established synthetic single-letter/placeholder names already used
  // across this repo's own test fixtures (never a real local account).
  "t", "x", "alice", "bob", "tester", "local-user", "name", "projects",
]);
const HOME_PATH_RE = /(?:\/(?:home|Users)\/|[A-Za-z]:[\\/]Users[\\/])([^\\/\s"'`<>:;,()[\]{}]+)/gi;

export function findHomePaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HOME_PATH_RE)) {
    // Trailing sentence punctuation ("...contain /home/name while...") is
    // not part of the path segment.
    const user = match[1]!.replace(/[.,;:]+$/, "");
    if (EXAMPLE_HOME_USERS.has(user.toLowerCase())) continue;
    found.push(match[0]);
  }
  return found;
}

// ---- personal machine nicknames -----------------------------------------------
// A device nickname naming one specific, identifiable machine is an
// anecdote, not a generic platform reference. Deliberately narrow: it must
// never fire on ordinary platform prose (the OS name, or the bare
// hardware-family word on its own, stay unblocked), only on nickname-shaped
// phrases that point at a specific personal laptop or desktop.
//
// The pattern text below is itself an instance of what it matches, so
// findMachineNicknames is only ever run through scannableSegments (never on
// raw code) to keep this file from flagging its own regex literal.
const MACHINE_NICKNAME_RE = /\b(?:the\s+macbook|my\s+macbook|macbook(?:\s+pro|\s+air)?|imac|mac\s*mini|my\s+laptop)\b/gi;

export function findMachineNicknames(text: string): string[] {
  return [...text.matchAll(MACHINE_NICKNAME_RE)].map(match => match[0]);
}

// ---- per-line rule aggregation -----------------------------------------------

// This scanner's own unit tests deliberately contain non-allowlisted
// domain/IP/email-shaped literals to exercise the "should be blocked" path
// (see test/identifier-scan.test.ts). Nothing else is exempted: real source,
// docs and fixtures elsewhere are still fully scanned.
const SELF_TEST_FIXTURE_FILES = new Set(["test/identifier-scan.test.ts"]);

export function checkLine(path: string, text: string, state: CommentState = { inBlock: false }): string[] {
  if (SELF_TEST_FIXTURE_FILES.has(path)) return [];
  const rules = new Set<string>();
  if (findHomePaths(text).length) rules.add("identifying-home-path");
  if (findEmails(text).length) rules.add("blocked-email");
  if (findIps(text).length) rules.add("blocked-ip");
  for (const segment of scannableSegments(path, text, state)) {
    if (findDomains(segment).length) rules.add("blocked-domain");
    if (findMachineNicknames(segment).length) rules.add("personal-machine-nickname");
  }
  return [...rules];
}

// ---- tree mode: scan every tracked file's current working-tree content ----

const BINARY_OR_GENERATED = new Set([
  "bun.lock", "Cargo.lock", "pnpm-lock.yaml", "package-lock.json",
]);

export function scanTree(root: string): Finding[] {
  const findings: Finding[] = [];
  const files = git(root, ["ls-files"]).trim().split("\n").filter(Boolean);
  for (const path of files) {
    if (BINARY_OR_GENERATED.has(path.split("/").pop() ?? "")) continue;
    let buffer: Buffer;
    try { buffer = readFileSync(`${root}/${path}`); } catch { continue; }
    if (buffer.includes(0)) continue; // binary file
    const text = buffer.toString("utf8");
    const state: CommentState = { inBlock: false };
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of checkLine(path, lines[i]!, state)) {
        findings.push({ location: `${path}:${i + 1}`, rule, detail: "" });
      }
    }
  }
  return findings;
}

// ---- diff mode: reuse the same added-lines walk as privacy-check.ts ------

interface AddedLine { path: string; line: number; text: string; file: number }

function addedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let path = "", line = 0, file = 0, inHunk = false;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) { file++; inHunk = false; }
    else if (!inHunk && text.startsWith("+++ ")) {
      const raw = text.slice(4);
      path = raw.replace(/^"|"$/g, "").replace(/^b\//, "");
    } else if (text.startsWith("@@ ")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (!match) fail();
      line = Number(match[1]); inHunk = true;
    } else if (inHunk && text.startsWith("+")) {
      lines.push({ path, line: line++, text: text.slice(1), file });
    } else if (inHunk && text.startsWith(" ")) line++;
  }
  return lines;
}

const DIFF = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=0"];
const zero = (sha: string): boolean => /^0+$/.test(sha);
function sha(value: string): string {
  if (!/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(value)) fail();
  return value;
}
function commit(root: string, ref: string): string {
  return git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
}

export function rangeCommits(root: string, base: string, head: string): string[] {
  const tip = commit(root, head);
  const args = zero(base) ? [tip] : [`${commit(root, base)}..${tip}`];
  return git(root, ["rev-list", "--reverse", "--topo-order", ...args]).trim().split("\n").filter(Boolean);
}

export function ciRevisions(root: string, base: string, head: string): string[] {
  const tip = commit(root, head);
  if (zero(base)) return [tip];
  try { commit(root, base); } catch {
    console.error(`identifier-scan: base ${base} is not present in this clone; scanning the head commit only`);
    return [tip];
  }
  return rangeCommits(root, base, head);
}

export function outgoingCommits(root: string, input: string, remote: string): string[] {
  const selected = new Set<string>();
  let remoteTips: string[] | undefined;
  for (const line of input.split("\n").filter(s => s.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) fail();
    const local = sha(fields[1]!), previous = sha(fields[3]!);
    if (zero(local)) continue;
    if (!zero(previous)) {
      for (const id of rangeCommits(root, previous, local)) selected.add(id);
      continue;
    }
    if (!remoteTips) {
      const advertised = git(root, ["ls-remote", "--refs", "--", remote]);
      remoteTips = [];
      for (const row of advertised.split("\n").filter(Boolean)) {
        const id = sha(row.split(/\s+/)[0]!);
        const result = Bun.spawnSync(["git", "rev-parse", "--verify", `${id}^{commit}`], {
          cwd: root, stdout: "pipe", stderr: "pipe",
        });
        if (result.exitCode === 0) remoteTips.push(result.stdout.toString().trim());
      }
    }
    const revisions = [commit(root, local), ...(remoteTips.length ? ["--not", ...remoteTips] : [])];
    for (const id of git(root, ["rev-list", "--reverse", "--topo-order", ...revisions]).trim().split("\n").filter(Boolean)) selected.add(id);
  }
  return [...selected];
}

export function scan(root: string, commits: string[] | "staged", label = "change"): Finding[] {
  const findings: Finding[] = [];
  const changes = commits === "staged" ? ["staged"] : commits;
  for (const [index, id] of changes.entries()) {
    const diff = id === "staged"
      ? git(root, ["diff", "--cached", ...DIFF, "--"])
      : git(root, ["show", "--format=", "--root", "-m", ...DIFF, sha(id), "--"]);
    const state: CommentState = { inBlock: false };
    for (const line of addedLines(diff)) {
      for (const rule of checkLine(line.path, line.text, state)) {
        findings.push({ location: `${label}-${index + 1}/file-${line.file}:${line.line}`, rule, detail: "" });
      }
    }
  }
  return findings;
}

// ---- CLI --------------------------------------------------------------------

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    let findings: Finding[];
    if (args.length === 1 && args[0] === "--tree") {
      findings = scanTree(root);
    } else if (args.length === 1 && args[0] === "--staged") {
      findings = scan(root, "staged");
    } else if (args.length === 3 && args[0] === "--range") {
      findings = scan(root, rangeCommits(root, args[1]!, args[2]!));
    } else if (args.length === 1 && args[0] === "--ci") {
      const base = process.env.IDENTIFIER_BASE_SHA;
      const head = process.env.IDENTIFIER_HEAD_SHA;
      if (!base || !head) fail();
      findings = scan(root, ciRevisions(root, sha(base), sha(head)));
    } else if (args.length >= 2 && args[0] === "--pre-push") {
      // git's own pre-push hook invocation passes two positional args
      // (remote name, remote URL); only the name is needed here.
      findings = scan(root, outgoingCommits(root, await Bun.stdin.text(), args[1]!));
    } else return fail();
    for (const finding of findings) console.error(`${finding.location}: ${finding.rule}`);
    return findings.length ? 1 : 0;
  } catch {
    console.error("identifier-scan: operation failed");
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
