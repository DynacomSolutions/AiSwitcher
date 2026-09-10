import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// These are deliberate examples, not an inferred allowlist of local accounts.
const GENERIC = new Set([
  "personal", "work", "default", "identity-a", "identity-team", "example", "user",
]);
const EXAMPLE_HOMES = new Set([
  "example", "user", "username", "test", "testuser", "test-user", "example-user",
  "fixture-user", "synthetic-user", "user-a", "user-b",
]);
// Keep aligned with src/identities/tool-configs.ts. Actual OS home, not a
// vendor identity override or a repository-controlled configuration path.
const REGISTRY_DIRS = [
  ".claude", ".codex", ".grok", ".kimi-code", ".pi", ".opencode", ".zai", ".ali",
];
export interface AddedLine {
  path: string;
  line: number;
  text: string;
  file: number;
}
export interface Finding {
  location: string;
  rule: string;
}
function fail(): never { throw new Error("privacy-check: operation failed"); }

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail();
  return result.stdout.toString();
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function externalPath(root: string, filename: string): string {
  const target = resolve(filename);
  if (contained(resolve(root), target)) fail();
  const canonical = realpathSync(target);
  if (contained(realpathSync(root), canonical)) fail();
  return canonical;
}

export function readExternalTerms(root: string, filename: string): string[] {
  try {
    return readFileSync(externalPath(root, filename), "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  } catch {
    // Never propagate filesystem errors: they contain private paths.
    return fail();
  }
}

export function loadPrivateTerms(
  root: string,
  termsFile?: string,
  registryPaths = REGISTRY_DIRS.map(dir => join(userInfo().homedir, dir, "identities.json")),
  machineHostname = hostname(),
): string[] {
  const terms = termsFile ? readExternalTerms(root, termsFile) : [];
  for (const filename of registryPaths) {
    let text: string;
    try {
      text = readFileSync(externalPath(root, filename), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { lstatSync(filename); } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
      }
      return fail();
    }
    try {
      const data = JSON.parse(text);
      if (data?.version !== 1 || !Array.isArray(data.identities)) fail();
      for (const identity of data.identities) {
        if (!identity || typeof identity.name !== "string" || !identity.name.trim()
          || (identity.label !== undefined && (typeof identity.label !== "string" || !identity.label.trim()))
          || (identity.aliases !== undefined && (!Array.isArray(identity.aliases)
            || !identity.aliases.every((v: unknown) => typeof v === "string" && v.trim())))) fail();
        terms.push(identity.name, ...(identity.aliases ?? []));
        if (identity.label !== undefined) terms.push(identity.label);
      }
    } catch {
      return fail();
    }
  }
  terms.push(machineHostname);
  return [...new Set(terms.map(s => s.trim().toLowerCase()).filter(s => s && !GENERIC.has(s)))];
}

function privatePattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Punctuation separates identifiers; a short alias never matches inside a word.
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

export function checkLine(path: string, text: string, terms: string[] = []): string[] {
  const rules: string[] = [];
  const normalised = text.replace(/\\\\/g, "\\");
  const homes = normalised.matchAll(/(?:\/(?:home|Users)\/|[A-Za-z]:[\\/]Users[\\/])([^\\/\s"'`<>:;,()[\]{}]+)/gi);
  if ([...homes].some(match => !EXAMPLE_HOMES.has(match[1]!.toLowerCase()))) rules.push("identifying-home-path");
  if (terms.some(term => !GENERIC.has(term.toLowerCase()) && privatePattern(term).test(text))) rules.push("private-identifier");
  const unmarked = (matches: Iterable<RegExpMatchArray>): boolean =>
    [...matches].some(match => !(match[1] ?? match[0]).includes("SYNTHETIC_FIXTURE"));
  if (unmarked(text.matchAll(/\bRateLimitResetCredit_[A-Za-z0-9_-]+/g))) rules.push("provider-credit-id");
  const credentials = [
    /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
    /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g,
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    /\bBearer\s+([A-Za-z0-9_./+=-]{8,})/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{12,})["']/gi,
  ];
  if (credentials.some(pattern => unmarked(text.matchAll(pattern)))) rules.push("credential-literal");
  const fixture = /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path);
  const capture = /\b(?:verbatim|confirm(?:ed|ing)?|captur(?:e[ds]?|ing)|record(?:ed|ing)?|cop(?:y|ied)|dump(?:ed)?|export(?:ed)?|scrap(?:ed|ing))\b/i;
  const live = /\b(?:live|real|production|personal|actual|local|my|our)\b/i;
  const origin = /\b(?:account|machine|host|session|provider|response|payload|registry|identit(?:y|ies)|quota|laptop)\b/i;
  if (fixture && capture.test(text) && live.test(text) && origin.test(text)) rules.push("live-fixture-provenance");
  return rules;
}

export function addedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let path = "", line = 0, file = 0, inHunk = false;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) { file++; inHunk = false; }
    else if (!inHunk && text.startsWith("+++ ")) {
      const raw = text.slice(4);
      // Quoted git paths may use octal escapes. Retain them for classification;
      // no path or patch text is ever included in diagnostics.
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

export function outgoingCommits(root: string, input: string, remote: string): string[] {
  const selected = new Set<string>();
  let remoteTips: string[] | undefined;
  for (const line of input.split("\n").filter(s => s.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) fail();
    const local = sha(fields[1]!), previous = sha(fields[3]!);
    if (zero(local)) continue; // Deletion sends no content.
    if (!zero(previous)) {
      for (const id of rangeCommits(root, previous, local)) selected.add(id);
      continue;
    }
    if (!remoteTips) {
      // Query the destination instead of trusting possibly stale tracking refs.
      // Unknown objects cannot exclude anything; scanning more history is safe.
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

export function scan(root: string, commits: string[] | "staged", terms: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const changes = commits === "staged" ? ["staged"] : commits;
  for (const [index, id] of changes.entries()) {
    const diff = id === "staged"
      ? git(root, ["diff", "--cached", ...DIFF, "--"])
      : git(root, ["show", "--format=", "--root", "-m", ...DIFF, sha(id), "--"]);
    let previous: AddedLine | undefined, inBlock = false;
    let comment: string[] = [];
    for (const line of addedLines(diff)) {
      if (!previous || previous.file !== line.file || previous.line + 1 !== line.line) {
        comment = []; inBlock = false;
      }
      const isComment = inBlock || /^\s*(?:\/\/|\/\*)/.test(line.text);
      if (isComment) comment.push(line.text);
      else comment = [];
      const rules = checkLine(line.path, line.text, terms);
      // Only adjacent added comment lines contribute provenance context.
      if (comment.length > 1 && checkLine(line.path, comment.join("\n")).includes("live-fixture-provenance")) {
        rules.push("live-fixture-provenance");
      }
      for (const rule of new Set(rules)) {
        findings.push({ location: `change-${index + 1}/file-${line.file}:${line.line}`, rule });
      }
      inBlock = (inBlock || /^\s*\/\*/.test(line.text)) && !line.text.includes("*/");
      if (line.text.includes("*/")) comment = [];
      previous = line;
    }
  }
  return findings;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const local = args.includes("--local");
    const clean = args.filter(arg => arg !== "--local");
    if (local && clean[0] === "--ci") fail();
    let revisions: string[] | "staged";
    if (clean.length === 1 && clean[0] === "--staged") revisions = "staged";
    else if (clean.length === 3 && clean[0] === "--range") revisions = rangeCommits(root, clean[1]!, clean[2]!);
    else if (clean.length === 1 && clean[0] === "--ci") {
      const base = process.env.PRIVACY_BASE_SHA;
      const head = process.env.PRIVACY_HEAD_SHA;
      if (!base || !head) fail();
      revisions = rangeCommits(root, sha(base), sha(head));
    } else if (local && clean.length === 3 && clean[0] === "--pre-push") {
      revisions = outgoingCommits(root, await Bun.stdin.text(), clean[1]!);
    } else return fail();
    // Public modes never consult registries or optional external policy inputs.
    const terms = local ? loadPrivateTerms(root, process.env.AIS_PRIVACY_TERMS_FILE) : [];
    const findings = scan(root, revisions, terms);
    for (const finding of findings) console.error(`${finding.location}: ${finding.rule}`);
    return findings.length ? 1 : 0;
  } catch {
    console.error("privacy-check: operation failed");
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
