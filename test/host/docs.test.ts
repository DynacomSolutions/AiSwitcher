import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("host guidance discloses platform, permission and recovery limits", () => {
  const readme = readFileSync("README.md", "utf8").split("## Portable host app")[1]?.split("\n## ")[0] ?? "";
  for (const phrase of [
    "macOS arm64", "Windows x86_64", "Linux x86_64", "AppImage", "unsigned",
    "Secure Boot", "first boot", "typed", "administrator", "cleanup",
    "15 minutes", "truncated", "licence", "offline", "revocation", "lost",
    "recovery", "session-only", "pending",
  ]) expect(readme).toContain(phrase);
  expect(readme).not.toContain("\u2014");
  const release = readFileSync("docs/agents/release.md", "utf8");
  expect(release).toContain("host-v");
  expect(release).toContain("SHA256SUMS");
});
