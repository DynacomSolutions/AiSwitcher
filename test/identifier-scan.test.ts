import { describe, expect, test } from "bun:test";
import {
  checkLine, findDomains, findEmails, findHomePaths, findIps, findMachineNicknames, isAllowedDomain,
  scannableSegments,
} from "../scripts/identifier-scan.ts";

describe("domain allowlist", () => {
  test("reserved and vendor domains are allowed, including subdomains", () => {
    for (const domain of [
      "example.com", "sub.example.com", "example.org", "example.net",
      "github.com", "api.github.com", "chatgpt.com", "kimi.com", "auth.kimi.com",
      "z.ai", "api.z.ai", "x.ai", "auth.x.ai",
    ]) expect(isAllowedDomain(domain)).toBe(true);
  });

  test("everything else is blocked by default", () => {
    for (const domain of ["evil.example.com.attacker.net", "internal-console.example-corp.dev", "corp-vpn.internal"]) {
      expect(isAllowedDomain(domain)).toBe(false);
    }
  });
});

describe("findDomains", () => {
  test("flags a plausible private/internal-looking domain", () => {
    expect(findDomains("reachable at console.internal-example.dev")).toEqual(["console.internal-example.dev"]);
  });

  test("allows RFC 2606 example domains", () => {
    expect(findDomains("see https://example.com/docs and evil.example.com")).toEqual([]);
  });

  test("does not flag file extensions", () => {
    for (const text of [
      "see src/server/guard.ts for details", "read package.json for scripts",
      "apps/tui/src/herdr.rs implements the wrapper", "docs live in README.md",
      "config.toml holds the settings", "check tsconfig.json",
    ]) expect(findDomains(text)).toEqual([]);
  });

  test("does not flag semver-shaped tokens", () => {
    expect(findDomains("bumped to v1.2.3 and bun@1.3.14")).toEqual([]);
  });

  test("does not flag object property chains", () => {
    for (const text of [
      "process.env.HOME", "identity.name.trim()", "JSON.stringify(value)",
      "console.log(result)", "user.email", "event.id", "matrix.target.name",
    ]) expect(findDomains(text)).toEqual([]);
  });

  test("does not flag macOS .app bundle paths", () => {
    expect(findDomains("/Applications/Codex.app/Contents/Resources")).toEqual([]);
  });
});

describe("scannableSegments code-awareness", () => {
  test("ignores a bare property chain in TypeScript code", () => {
    const state = { inBlock: false };
    const segments = scannableSegments("src/example.ts", "const home = process.env.HOME;", state);
    for (const segment of segments) expect(findDomains(segment)).toEqual([]);
  });

  test("still catches a real domain inside a string literal", () => {
    const state = { inBlock: false };
    const segments = scannableSegments("src/example.ts", 'const url = "https://internal.example-corp.dev/api";', state);
    const found = segments.flatMap(findDomains);
    expect(found).toContain("internal.example-corp.dev");
  });

  test("still catches a real domain inside a comment", () => {
    const state = { inBlock: false };
    const segments = scannableSegments("src/example.ts", "// see internal.example-corp.dev for the dashboard", state);
    const found = segments.flatMap(findDomains);
    expect(found).toContain("internal.example-corp.dev");
  });

  test("tracks multi-line block comments", () => {
    const state = { inBlock: false };
    const first = scannableSegments("src/example.ts", "/* the dashboard lives at", state);
    expect(state.inBlock).toBe(true);
    const second = scannableSegments("src/example.ts", " internal.example-corp.dev */ const x = 1;", state);
    expect(state.inBlock).toBe(false);
    expect([...first, ...second].flatMap(findDomains)).toContain("internal.example-corp.dev");
  });

  test("plain text/config files are scanned in full", () => {
    const state = { inBlock: false };
    const segments = scannableSegments("k8s/deployment.yaml", "hostname: internal.example-corp.dev", state);
    expect(segments.flatMap(findDomains)).toContain("internal.example-corp.dev");
  });
});

describe("findIps", () => {
  test("allows loopback and RFC 5737/3849 documentation ranges", () => {
    for (const text of ["127.0.0.1", "192.0.2.10", "198.51.100.42", "203.0.113.5", "::1", "2001:db8::1"]) {
      expect(findIps(text)).toEqual([]);
    }
  });

  test("blocks other IPv4 literals, including private ranges", () => {
    for (const ip of ["10.0.0.5", "172.16.4.1", "192.168.1.1", "203.0.114.9"]) {
      expect(findIps(ip)).toEqual([ip]);
    }
  });

  test("blocks a real-looking IPv6 literal", () => {
    expect(findIps("fe80:0000:0000:0000:0202:b3ff:fe1e:8329")).toEqual(["fe80:0000:0000:0000:0202:b3ff:fe1e:8329"]);
  });

  test("does not flag version-shaped or short colon runs", () => {
    expect(findIps("v1.2.3 build 999.999.999.999")).toEqual([]);
    expect(findIps("a:b:c ratio")).toEqual([]);
  });
});

describe("findEmails", () => {
  test("allows example/invalid addresses", () => {
    expect(findEmails("contact fixture@example.invalid or one@example.com")).toEqual([]);
  });

  test("blocks a real-looking address", () => {
    expect(findEmails("contact ops@internal-example-corp.dev")).toEqual(["ops@internal-example-corp.dev"]);
  });
});

describe("findHomePaths", () => {
  test("allows placeholder usernames", () => {
    for (const path of ["/home/user/project", "/home/example-user/project", "/Users/me/project", "/home/ci/project"]) {
      expect(findHomePaths(path)).toEqual([]);
    }
  });

  test("blocks a real-looking username", () => {
    expect(findHomePaths("/home/" + ["jane", "doe"].join("") + "/project")).toHaveLength(1);
  });
});

describe("findMachineNicknames", () => {
  test("blocks personal device nicknames", () => {
    for (const text of [
      "observed on the MacBook, first-run 13G mirror",
      "was not found on the MacBook (no local Rust build)",
      "reproduced on my laptop this morning",
      "tested on an iMac and a Mac Mini",
    ]) expect(findMachineNicknames(text).length).toBeGreaterThan(0);
  });

  test("never flags generic macOS/platform prose", () => {
    for (const text of [
      "Installer backup hangs on macOS: runBackup loops at ~157% CPU",
      "aarch64-apple-darwin native on apple-builder",
      "supports macOS and Linux",
      "a Mac in the generic sense, not a device nickname",
    ]) expect(findMachineNicknames(text)).toEqual([]);
  });
});

describe("checkLine integration", () => {
  test("clean lines produce no rules", () => {
    expect(checkLine("src/example.ts", "export const REPO = \"github.com/example\";")).toEqual([]);
  });

  test("aggregates multiple simultaneous violations", () => {
    const rules = checkLine("README.md", "ops@internal-example-corp.dev is reachable at 203.0.114.9");
    expect(rules).toContain("blocked-email");
    expect(rules).toContain("blocked-ip");
  });
});
