import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLine, findDomains, findEmails, findHomePaths, findIps, findMachineNicknames, isAllowedDomain,
  isPythonShebang, scannableSegments, scan,
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

  test("does not exempt mixed-case domains in URLs, email-shaped strings, comments or Markdown", () => {
    for (const text of [
      'const url = "https://Customer.COM";',
      'const address = "ops@Customer.service.DEV";',
      "// https://Customer.COM and ops@Customer.service.DEV",
      "See https://Customer.COM and ops@Customer.service.DEV",
    ]) {
      const path = text.startsWith("See ") ? "README.md" : "src/sample.ts";
      expect(checkLine(path, text)).toContain("blocked-domain");
      if (text.includes("ops@")) expect(checkLine(path, text)).toContain("blocked-email");
    }
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
    const found = segments.flatMap(segment => findDomains(segment));
    expect(found).toContain("internal.example-corp.dev");
  });

  test("still catches a real domain inside a comment", () => {
    const state = { inBlock: false };
    const segments = scannableSegments("src/example.ts", "// see internal.example-corp.dev for the dashboard", state);
    const found = segments.flatMap(segment => findDomains(segment));
    expect(found).toContain("internal.example-corp.dev");
  });

  test("tracks multi-line block comments", () => {
    const state = { inBlock: false };
    const first = scannableSegments("src/example.ts", "/* the dashboard lives at", state);
    expect(state.inBlock).toBe(true);
    const second = scannableSegments("src/example.ts", " internal.example-corp.dev */ const x = 1;", state);
    expect(state.inBlock).toBe(false);
    expect([...first, ...second].flatMap(segment => findDomains(segment))).toContain("internal.example-corp.dev");
  });

  test("lexes repeated comments and quoted comment delimiters by segment kind", () => {
    const state = { inBlock: false };
    const parts = scannableSegments("src/example.ts", '/* first */ /* "polkit.Result.NO" */ const value = "/* // https://internal.example-corp.dev */";', state);
    expect(parts.flatMap(segment => findDomains(segment))).toContain("polkit.Result.NO");
    expect(checkLine("src/example.ts", '/* first */ /* "polkit.Result.NO" */')).toContain("blocked-domain");
    expect(checkLine("src/example.ts", 'const value = "/* // https://internal.example-corp.dev */";')).toContain("blocked-domain");
  });

  test("keeps multiline template strings and scans JavaScript strings and comments", () => {
    const state = { inBlock: false };
    expect(checkLine("src/example.js", 'const url = "https://Customer.COM";')).toContain("blocked-domain");
    expect(checkLine("src/example.js", "// https://Customer.COM")).toContain("blocked-domain");
    expect(checkLine("src/example.ts", "const url = `", state)).toEqual([]);
    expect(checkLine("src/example.ts", "https://Customer.COM", state)).toContain("blocked-domain");
    expect(checkLine("src/example.ts", "`;", state)).toEqual([]);
  });

  test("plain text/config files are scanned in full", () => {
    const state = { inBlock: false };
    const segments = scannableSegments("k8s/deployment.yaml", "hostname: internal.example-corp.dev", state);
    expect(segments.flatMap(segment => findDomains(segment))).toContain("internal.example-corp.dev");
  });

  test("Python attribute calls are code, while strings and hash comments remain scanned", () => {
    expect(checkLine("scripts/example.py", 'subprocess.run(["python3", "-V"])')).toEqual([]);
    for (const line of [
      'target = "https://internal.example-corp.dev"',
      "target = r'internal.example-corp.dev'",
      'target = f"https://internal.example-corp.dev/{name}"',
      'subprocess.run(args) # "internal.example-corp.dev"',
      'target = "# internal.example-corp.dev"',
      'target = "escaped \\" quote internal.example-corp.dev"',
    ]) expect(checkLine("scripts/example.py", line)).toContain("blocked-domain");
  });

  test("Python triple-quoted strings retain scanning across lines and after closing", () => {
    for (const quote of ['"""', "'''"]) {
      const state = { inBlock: false };
      expect(checkLine("scripts/example.py", `text = ${quote}Documentation`, state)).toEqual([]);
      expect(checkLine("scripts/example.py", "internal.example-corp.dev", state)).toContain("blocked-domain");
      expect(checkLine("scripts/example.py", `${quote}; subprocess.run(args)`, state)).toEqual([]);
      expect(checkLine("scripts/example.py", "subprocess.run(args)", state)).toEqual([]);
      expect(checkLine("scripts/example.py", `text = ${quote}internal.example-corp.dev${quote}`, state)).toContain("blocked-domain");
    }
  });

  test("Python strings do not suppress full-line address and identifying-path checks", () => {
    expect(checkLine("scripts/example.py", "# 203.0.114.9")).toContain("blocked-ip");
    expect(checkLine("scripts/example.py", "# ops@internal-example-corp.dev")).toContain("blocked-email");
    expect(checkLine("scripts/example.py", '# /home/' + ["jane", "doe"].join(""))).toContain("identifying-home-path");
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

describe("code identifier chains", () => {
  test("a constant access chain is not a domain, real domains still are", () => {
    expect(findDomains("polkit.Result.NO")).toEqual(["polkit.Result.NO"]);
    expect(findDomains('expect(x).toContain("polkit.Result.NO")')).toEqual(["polkit.Result.NO"]);
    expect(findDomains("reach corp.internal-example.NO or console.internal-example.dev")).toEqual(["corp.internal-example.NO", "console.internal-example.dev"]);
    expect(findDomains("INTERNAL-EXAMPLE.DEV")).toEqual(["INTERNAL-EXAMPLE.DEV"]);
    for (const prefix of ["@", "scheme://", "https:", "mailto:"]) {
      expect(findDomains(`${prefix}polkit.Result.NO`, true)).toEqual(["polkit.Result.NO"]);
    }
  });

  test("only a complete systemd template token is exempt", () => {
    expect(findEmails("getty@tty1.service serial-getty@.service container@web.socket")).toEqual([]);
    expect(findEmails("getty@tty1.service.d")).toEqual(["getty@tty1.service.d"]);
    expect(findEmails("getty@tty1.service ops@Customer.service.DEV")).toEqual(["ops@Customer.service.DEV"]);
    expect(findEmails("+ops@tty1.service")).toEqual(["ops@tty1.service"]);
    expect(findEmails("prefix:ops@tty1.service")).toEqual(["ops@tty1.service"]);
  });
});

describe("findEmails", () => {
  test("allows example/invalid addresses", () => {
    expect(findEmails("contact fixture@example.invalid or one@example.com")).toEqual([]);
  });

  test("blocks a real-looking address", () => {
    expect(findEmails("contact ops@internal-example-corp.dev")).toEqual(["ops@internal-example-corp.dev"]);
  });

  test("ignores systemd template unit names but still blocks real addresses beside them", () => {
    expect(findEmails("getty@tty1.service serial-getty@.service container@web.socket")).toEqual([]);
    expect(findEmails("getty@tty1.service ops@internal-example-corp.dev")).toEqual(["ops@internal-example-corp.dev"]);
    expect(findEmails("ops@service.dev")).toEqual(["ops@service.dev"]);
    expect(findEmails("getty@tty1.service ops@Customer.service.DEV")).toEqual(["ops@Customer.service.DEV"]);
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

  test("code-chain exception applies only to tagged strings, including Python strings", () => {
    expect(checkLine("src/example.ts", 'const result = "polkit.Result.NO";')).toEqual([]);
    expect(checkLine("src/example.ts", '/* "polkit.Result.NO" */')).toContain("blocked-domain");
    const state = { inBlock: false };
    expect(checkLine("src/example.ts", "/* comment begins", state)).toEqual([]);
    expect(checkLine("src/example.ts", '"polkit.Result.NO"', state)).toContain("blocked-domain");
    expect(checkLine("example.py", 'result = "polkit.Result.NO"')).toEqual([]);
    expect(checkLine("example.py", "# polkit.Result.NO")).toContain("blocked-domain");
    expect(checkLine("src/example.ts", 'const url = "https://polkit.Result.NO";')).toContain("blocked-domain");
  });
});

describe("python files", () => {
  const code = "result = subprocess.run(cmd); m = match.group(1)";
  test("shebang detection", () => {
    expect(isPythonShebang("#!/usr/bin/env python3")).toBe(true);
    expect(isPythonShebang("#!/usr/bin/python")).toBe(true);
    expect(isPythonShebang("#!/bin/bash")).toBe(false);
  });

  test("attribute access is ignored for .py and python-shebang files", () => {
    expect(checkLine("tool.py", code)).toEqual([]);
    expect(checkLine("image/lib/tool", code, { inBlock: false, python: true })).toEqual([]);
  });

  test("a real domain inside a python string or comment is still flagged", () => {
    const state = () => ({ inBlock: false, python: true });
    expect(checkLine("tool", 'url = "https://internal.example-corp.dev/x"', state())).toContain("blocked-domain");
    expect(checkLine("tool", "x = 1  # see internal.example-corp.dev", state())).toContain("blocked-domain");
    expect(checkLine("tool.py", "u = 'internal.example-corp.dev'", { inBlock: false })).toContain("blocked-domain");
  });

  test("a domain inside a multi-line triple-quoted string is still flagged", () => {
    const state: { inBlock: boolean; python: boolean; triple?: string } = { inBlock: false, python: true };
    expect(checkLine("tool", 'doc = """start', state)).toEqual([]);
    expect(checkLine("tool", "reach internal.example-corp.dev now", state)).toContain("blocked-domain");
    expect(checkLine("tool", 'end""" + subprocess.run', state)).toEqual([]);
  });

  test("non-python extensionless files are still scanned in full", () => {
    expect(checkLine("tool", code.replace("subprocess.run", "internal.example-corp.dev"))).toContain("blocked-domain");
  });
});

describe("staged scan skips generated lockfiles like tree mode", () => {
  test("Cargo.lock registry line is ignored, unknown domain in a normal file is flagged", () => {
    const root = mkdtempSync(join(tmpdir(), "idscan-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-q");
      mkdirSync(join(root, "apps"));
      writeFileSync(join(root, "apps/Cargo.lock"), 'source = "registry+https://github.com/rust-lang/crates.io-index"\n');
      git("add", ".");
      expect(scan(root, "staged")).toEqual([]);
      writeFileSync(join(root, "notes.txt"), "see console.internal-example.dev\n");
      git("add", ".");
      expect(scan(root, "staged").length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("Python commit scans preserve multiline context and inspect the selected blob", () => {
  const root = mkdtempSync(join(tmpdir(), "idscan-python-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("config", "user.name", "SYNTHETIC_FIXTURE");
    git("config", "user.email", "fixture@example.invalid");
    const filename = join(root, "example.py");
    writeFileSync(filename, '"""Documentation\nreserved example.invalid\n"""\nsubprocess.run(args)\n');
    git("add", "example.py");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "test(fixtures): initialise synthetic Python");
    const first = git("rev-parse", "HEAD");
    expect(scan(root, [first])).toEqual([]);
    writeFileSync(filename, '"""Documentation\ninternal.example-corp.dev\n"""\nsubprocess.run(args)\n');
    git("add", "example.py");
    // A clean working copy must not conceal the blocked line in the index.
    writeFileSync(filename, '"""Documentation\nexample.invalid\n"""\nsubprocess.run(args)\n');
    expect(scan(root, "staged").map((finding) => finding.rule)).toEqual(["blocked-domain"]);
    git("-c", "commit.gpgsign=false", "commit", "-qm", "test(fixtures): change synthetic docstring");
    const second = git("rev-parse", "HEAD");
    expect(scan(root, [second]).map((finding) => finding.rule)).toEqual(["blocked-domain"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
