import { appendFileSync } from "node:fs";

export type HostCheckSelection = "host" | "all";

const hostInputs = [
  /^apps\/host\//,
  /^scripts\/host\//,
  /^test\/host\//,
  /^src\/host\//,
  /^image\/contract\//,
];
const knownUnrelated = [
  /^(README|TASKS)\.md$/,
  /^docs\/agents\/[^/]+\.md$/,
  /^apps\/web\//,
  /^apps\/tui\//,
];
const fullCheckInputs = [
  /^\.github\/workflows\//,
  /^package\.json$/,
  /^tsconfig\.json$/,
  /^scripts\/identifier-allowlist\.ts$/,
  /^Cargo\.toml$/,
  /^Cargo\.lock$/,
  /^apps\/host\/Cargo\.lock$/,
  /^image\/release-key\.pub$/,
  /^src\/(shared|identities|sync|live)\//,
];

export function affectedHostChecks(paths: readonly string[]): HostCheckSelection[] {
  if (paths.length === 0) return [];
  const unknown = paths.some((path) => !hostInputs.some((pattern) => pattern.test(path)) && !knownUnrelated.some((pattern) => pattern.test(path)) && !fullCheckInputs.some((pattern) => pattern.test(path)));
  if (unknown) return ["all"];
  if (paths.some((path) => /(^|\/)(bun\.lock|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$/.test(path))) return ["all"];
  if (paths.some((path) => fullCheckInputs.some((pattern) => pattern.test(path)))) return ["all"];
  if (paths.some((path) => hostInputs.some((pattern) => pattern.test(path)))) return ["host"];
  if (paths.every((path) => knownUnrelated.some((pattern) => pattern.test(path)))) return [];
  return ["all"];
}

if (import.meta.main) {
  let paths = Bun.argv.slice(2);
  let forceAll = false;
  if (paths.includes("--github")) {
    forceAll = process.env.GITHUB_EVENT_NAME !== "pull_request" || process.env.HOST_PRODUCTION === "true";
    const base = process.env.BASE_SHA ?? "";
    const head = process.env.HEAD_SHA ?? "";
    if (!forceAll && /^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(head)) {
      const diff = Bun.spawnSync(["git", "diff", "--name-only", "-z", `${base}...${head}`], { timeout: 30_000 });
      if (diff.exitCode === 0) paths = diff.stdout.toString().split("\0").filter(Boolean);
      else forceAll = true;
    } else forceAll = true;
  }
  const selection = forceAll ? ["all"] : affectedHostChecks(paths);
  const value = selection.length ? selection.join(" ") : "skip";
  if (Bun.argv.includes("--github")) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    appendFileSync(process.env.GITHUB_OUTPUT, `selection=${value}\n`);
  }
  console.log(value);
}
