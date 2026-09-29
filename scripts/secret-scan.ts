// Secret scanner used by the pre-commit/pre-push hooks and CI. Prefers
// gitleaks (https://github.com/gitleaks/gitleaks) when it is on PATH,
// configured by .gitleaks.toml at the repo root; falls back to a built-in
// regex scanner for common token shapes (API keys, private keys, JWTs,
// provider tokens) when gitleaks is not installed, so the check is never
// silently skipped.
//
// Modes mirror identifier-scan.ts:
//   --tree                   scan the current working tree (full lint)
//   --staged                 scan the indexed diff (pre-commit)
//   --pre-push <remote>      scan outgoing commits, reading update lines from stdin
//   --range <base> <head>    scan an explicit commit range
//   --ci                     scan IDENTIFIER_BASE_SHA..IDENTIFIER_HEAD_SHA
import { existsSync } from "node:fs";
import { ciRevisions, outgoingCommits, rangeCommits } from "./identifier-scan.ts";

function fail(): never { throw new Error("secret-scan: operation failed"); }

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail();
  return result.stdout.toString();
}

function hasGitleaks(): boolean {
  // Bun.spawnSync throws synchronously (ENOENT) rather than returning a
  // non-zero exit code when the executable isn't on PATH at all.
  try {
    return Bun.spawnSync(["gitleaks", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

function runGitleaks(root: string, args: string[]): boolean {
  const configPath = `${root}/.gitleaks.toml`;
  const configArgs = existsSync(configPath) ? ["--config", configPath] : [];
  const result = Bun.spawnSync(
    ["gitleaks", ...args, "--no-banner", "--redact", ...configArgs],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  return result.exitCode === 0;
}

// Built-in fallback, kept aligned with scripts/privacy-check.ts's
// credential-literal patterns: common provider API key/token shapes, cloud
// access keys, PEM private-key headers, bearer tokens and JWT-shaped
// strings. Only used when gitleaks is not available on PATH.
const STRUCTURAL_CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
  /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  /\bBearer\s+([A-Za-z0-9_./+=-]{8,})/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
// This one alone needs an entropy check: unlike the structural patterns
// above, "api_key: \"...\"" matches equally well on a real secret and on an
// obviously-fake test fixture ("access_token: \"codex-access\""), which
// this codebase's own tests are full of.
const KEY_VALUE_CREDENTIAL_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{12,})["']/gi;

// A plain lowercase, hyphen/underscore-joined run of short "words" (up to 5)
// reads as a descriptive placeholder ("codex-access", "ali-plan-key"), not a
// real credential: real tokens are effectively random, so a genuine one
// only matches this by chance far less often than fixtures use this style.
function looksLikePlaceholder(value: string): boolean {
  return /^[a-z]+([_-][a-z0-9]+){0,4}$/.test(value) && value.length < 32;
}

function builtinLineHasSecret(text: string): boolean {
  if (text.includes("SYNTHETIC_FIXTURE")) return false;
  if (STRUCTURAL_CREDENTIAL_PATTERNS.some(pattern => { pattern.lastIndex = 0; return pattern.test(text); })) return true;
  KEY_VALUE_CREDENTIAL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_VALUE_CREDENTIAL_PATTERN.exec(text))) {
    if (!looksLikePlaceholder(match[1]!)) return true;
  }
  return false;
}

function builtinScanDiff(diff: string): number {
  let findings = 0;
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) path = line.slice(4).replace(/^"|"$/g, "").replace(/^b\//, "");
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (builtinLineHasSecret(line.slice(1))) { console.error(`${path}: possible-secret-literal`); findings++; }
    }
  }
  return findings;
}

function builtinScanTree(root: string): number {
  let findings = 0;
  const files = git(root, ["ls-files"]).trim().split("\n").filter(Boolean);
  for (const path of files) {
    const result = Bun.spawnSync(["git", "show", `HEAD:${path}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) continue;
    if (result.stdout.includes(0)) continue;
    const lines = result.stdout.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (builtinLineHasSecret(lines[i]!)) { console.error(`${path}:${i + 1}: possible-secret-literal`); findings++; }
    }
  }
  return findings;
}

function builtinScanCommits(root: string, commits: string[] | "staged"): number {
  let findings = 0;
  const changes = commits === "staged" ? ["staged"] : commits;
  for (const id of changes) {
    const diff = id === "staged"
      ? git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", "--"])
      : git(root, ["show", "--format=", "--root", "-m", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", id, "--"]);
    findings += builtinScanDiff(diff);
  }
  return findings;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const gitleaks = hasGitleaks();

    if (args.length === 1 && args[0] === "--tree") {
      if (gitleaks) return runGitleaks(root, ["detect", "--no-git", "--source", root]) ? 0 : 1;
      return builtinScanTree(root) ? 1 : 0;
    }
    if (args.length === 1 && args[0] === "--staged") {
      if (gitleaks) return runGitleaks(root, ["protect", "--staged"]) ? 0 : 1;
      return builtinScanCommits(root, "staged") ? 1 : 0;
    }
    if (args.length === 3 && args[0] === "--range") {
      const commits = rangeCommits(root, args[1]!, args[2]!);
      if (gitleaks) {
        let ok = true;
        for (const id of commits) ok = runGitleaks(root, ["detect", "--log-opts", `-1 ${id}`]) && ok;
        return ok ? 0 : 1;
      }
      return builtinScanCommits(root, commits) ? 1 : 0;
    }
    if (args.length === 1 && args[0] === "--ci") {
      const base = process.env.IDENTIFIER_BASE_SHA;
      const head = process.env.IDENTIFIER_HEAD_SHA;
      if (!base || !head) fail();
      const commits = ciRevisions(root, base, head);
      if (gitleaks) {
        let ok = true;
        for (const id of commits) ok = runGitleaks(root, ["detect", "--log-opts", `-1 ${id}`]) && ok;
        return ok ? 0 : 1;
      }
      return builtinScanCommits(root, commits) ? 1 : 0;
    }
    if (args.length >= 2 && args[0] === "--pre-push") {
      const commits = outgoingCommits(root, await Bun.stdin.text(), args[1]!);
      if (gitleaks) {
        let ok = true;
        for (const id of commits) ok = runGitleaks(root, ["detect", "--log-opts", `-1 ${id}`]) && ok;
        return ok ? 0 : 1;
      }
      return builtinScanCommits(root, commits) ? 1 : 0;
    }
    return fail();
  } catch {
    console.error("secret-scan: operation failed");
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
