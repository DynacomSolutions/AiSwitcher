export type HostCheckSelection = "host" | "all";

const hostInputs = [
  /^apps\/host\//,
  /^scripts\/host\//,
  /^test\/host\//,
  /^src\/host\//,
  /^image\/contract\//,
];
const knownUnrelated = [
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
  const selection = affectedHostChecks(Bun.argv.slice(2));
  console.log(selection.length ? selection.join(" ") : "skip");
}
