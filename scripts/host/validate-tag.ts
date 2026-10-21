import { appendFileSync, readFileSync } from "node:fs";
import { run } from "./release-assets";

export function validHostTag(tag: string, version: string): boolean {
  return tag === `host-v${version}` && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version);
}

export function validateReleaseCommit(tag: string, version: string, sha: string, execute: (args: string[]) => string = run): void {
  if (!validHostTag(tag, version) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Tag must match the host version at this exact workflow commit.");
  const tagged = execute(["git", "rev-parse", `refs/tags/${tag}^{commit}`]).trim();
  if (tagged !== sha) throw new Error("The selected tag does not point to the checked workflow commit.");
  execute(["git", "merge-base", "--is-ancestor", sha, "origin/main"]);
}

if (import.meta.main) {
  const tag = process.env.HOST_TAG ?? "";
  const sha = process.env.GITHUB_SHA ?? "";
  const version = (JSON.parse(readFileSync("apps/host/package.json", "utf8")) as { version: string }).version;
  validateReleaseCommit(tag, version, sha);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\ntag=${tag}\n`);
}
