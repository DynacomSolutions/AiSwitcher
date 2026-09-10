import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addedLines, checkLine, loadPrivateTerms, outgoingCommits, rangeCommits, readExternalTerms, scan } from "../scripts/privacy-check.ts";
import { installHooks } from "../scripts/install-privacy-hooks.ts";

const directories: string[] = [];
const checker = resolve(import.meta.dir, "../scripts/privacy-check.ts");
const privateName = ["synthetic", "private", "person"].join("-");
const privateHome = ["", "home", privateName, "project"].join("/");
const credential = ["sk", "SYNTHETIC".repeat(4)].join("-");
const credit = ["RateLimitResetCredit", "syntheticOpaqueExample"].join("_");
const marker = "SYNTHETIC_FIXTURE";
const zero = "0".repeat(40);
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "privacy-test-"));
  directories.push(path);
  return path;
}
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("test git command failed");
  return result.stdout.toString().trim();
}
function repository(): string {
  const root = directory();
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Synthetic Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(root, ".git", "hooks"));
  writeFileSync(join(root, "example.txt"), "example\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Synthetic initial fixture");
  return root;
}
function record(root: string, text: string): string {
  writeFileSync(join(root, "example.txt"), text);
  git(root, "add", "example.txt");
  git(root, "commit", "-m", "Synthetic change fixture");
  return git(root, "rev-parse", "HEAD");
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public rules", () => {
  test("identifying homes and deliberately allowed examples", () => {
    for (const text of [
      privateHome,
      ["", "Users", privateName, "project"].join("/"),
      ["C:", "Users", privateName, "project"].join("\\"),
      JSON.stringify(["C:", "Users", privateName].join("\\")),
    ]) expect(checkLine("example.ts", text)).toContain("identifying-home-path");
    for (const name of ["example", "user", "test-user", "synthetic-user"]) {
      expect(checkLine("example.ts", ["", "home", name, "project"].join("/"))).toEqual([]);
    }
    for (const name of ["ali" + "ce", "b" + "ob"]) {
      expect(checkLine("example.ts", ["", "home", name, "project"].join("/"))).toContain("identifying-home-path");
    }
    expect(checkLine("example.ts", `${privateHome} ${marker}`)).toContain("identifying-home-path");
  });

  test("opaque provider IDs and credentials require explicit synthetic markers", () => {
    const samples = [
      credential, ["AKIA", "X".repeat(16)].join(""),
      ["Bearer", "synthetic-token-value"].join(" "),
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      ["github_pat_", "SYNTHETIC".repeat(4)].join(""),
      JSON.stringify({ api_key: ["synthetic", "credentialvalue"].join("") }),
    ];
    for (const sample of samples) {
      expect(checkLine("example.ts", sample)).toContain("credential-literal");
      expect(checkLine("example.ts", `${sample} ${marker}`)).toContain("credential-literal");
    }
    const markedToken = ["sk", marker, "001"].join("-");
    for (const sample of [
      markedToken, ["Bearer", `${marker}_001`].join(" "),
      ["github_pat", marker, "001"].join("_"),
      JSON.stringify({ api_key: `${marker}_001` }),
    ]) expect(checkLine("example.ts", sample)).toEqual([]);
    expect(checkLine("example.ts", `${markedToken} ${credential}`)).toContain("credential-literal");
    expect(checkLine("example.ts", JSON.stringify({
      api_key: ["synthetic", "credentialvalue"].join(""), note: marker,
    }))).toContain("credential-literal");
    const markedCredit = ["RateLimitResetCredit", marker, "001"].join("_");
    expect(checkLine("example.ts", markedCredit)).toEqual([]);
    expect(checkLine("example.ts", credit)).toContain("provider-credit-id");
    expect(checkLine("example.ts", `${credit} ${marker}`)).toContain("provider-credit-id");
    expect(checkLine("example.ts", `${markedCredit} ${credit}`)).toContain("provider-credit-id");
  });

  test("fixture provenance is checked only in fixture and test paths", () => {
    const provenance = ["Cap" + "tured", "from a li" + "ve", "account response"].join(" ");
    for (const path of ["test/example.ts", "fixtures/example.json", "src/example.test.ts"]) {
      expect(checkLine(path, provenance)).toContain("live-fixture-provenance");
    }
    expect(checkLine("docs/example.md", provenance)).toEqual([]);
    expect(checkLine("fixtures/example.json", "Constructed synthetic example")).toEqual([]);
    const syntheticText = ["Ver" + "batim shape con" + "firmed", "li" + "ve against the real team account", "on this machine"].join(" ");
    expect(checkLine("test/example.ts", syntheticText)).toContain("live-fixture-provenance");
    expect(checkLine("test/example.ts", ["Con" + "firmed", "li" + "ve account response"].join(" "))).toContain("live-fixture-provenance");
  });

  test("private terms use identifier boundaries and explicit generic exclusions", () => {
    expect(checkLine("example.ts", privateName.toUpperCase(), [privateName])).toContain("private-identifier");
    expect(checkLine("example.ts", "example-workflow", ["wf"])).toEqual([]);
    expect(checkLine("example.ts", "prefixabbrsuffix", ["abbr"])).toEqual([]);
    expect(checkLine("example.ts", '"ABBR"', ["abbr"])).toContain("private-identifier");
    for (const term of ["personal", "work", "default", "identity-a", "identity-team", "example", "user"]) {
      expect(checkLine("example.ts", term, [term])).toEqual([]);
    }
  });
});

describe("external policy", () => {
  test("names, aliases, labels and hostname exclude generic identities", () => {
    const root = directory(), registry = join(directory(), "identities.json");
    const label = "Synthetic Display Label", machine = "synthetic-machine";
    writeFileSync(registry, JSON.stringify({
      version: 1, identities: [
        { name: privateName, aliases: ["synthetic-alias", "work"], label },
        { name: "example", label: "Default" }, { name: "user" },
      ],
    }));
    const terms = loadPrivateTerms(root, undefined, [registry], machine);
    expect(terms).toEqual([privateName, "synthetic-alias", label.toLowerCase(), machine]);
    for (const text of [label.toUpperCase(), machine.toUpperCase()]) {
      expect(checkLine("example.ts", text, terms)).toContain("private-identifier");
      expect(checkLine("example.ts", text)).toEqual([]);
    }
    for (const generic of ["personal", "work", "default", "identity-a", "identity-team", "example", "user"]) {
      expect(loadPrivateTerms(root, undefined, [], generic)).toEqual([]);
    }
    for (const malformed of [null, 1, [], "", " "]) {
      writeFileSync(registry, JSON.stringify({ version: 1, identities: [{ name: privateName, label: malformed }] }));
      expect(() => loadPrivateTerms(root, undefined, [registry], machine)).toThrow("privacy-check: operation failed");
    }
    writeFileSync(registry, `${privateName}: malformed`);
    expect(() => loadPrivateTerms(root, undefined, [registry], machine)).toThrow("privacy-check: operation failed");
    expect(() => loadPrivateTerms(root, undefined, [directory()], machine)).toThrow("privacy-check: operation failed");
  });

  test("rejects repository policy files, including symlink disguises", () => {
    const root = directory(), outside = directory(), inside = join(root, "terms.txt");
    writeFileSync(inside, privateName);
    expect(() => readExternalTerms(root, inside)).toThrow("privacy-check: operation failed");
    const disguise = join(outside, "disguise.txt");
    symlinkSync(inside, disguise);
    expect(() => readExternalTerms(root, disguise)).toThrow("privacy-check: operation failed");
    const external = join(outside, "external.txt");
    writeFileSync(external, privateName);
    const internalLink = join(root, "link.txt");
    symlinkSync(external, internalLink);
    expect(() => readExternalTerms(root, internalLink)).toThrow("privacy-check: operation failed");
    expect(readExternalTerms(root, external)).toEqual([privateName]);
  });

  test("registry inputs enforce lexical and resolved containment before reading", () => {
    const root = directory(), outside = directory();
    const inside = join(root, "identities.json"), external = join(outside, "identities.json");
    const content = JSON.stringify({ version: 1, identities: [{ name: privateName }] });
    writeFileSync(inside, content);
    writeFileSync(external, content);
    const disguise = join(outside, "disguise.json"), internalLink = join(root, "link.json");
    symlinkSync(inside, disguise);
    symlinkSync(external, internalLink);
    for (const path of [inside, disguise, internalLink, join(root, "missing.json")]) {
      expect(() => loadPrivateTerms(root, undefined, [path], "example")).toThrow("privacy-check: operation failed");
    }
    expect(loadPrivateTerms(root, undefined, [external], "example")).toEqual([privateName]);
    expect(loadPrivateTerms(root, undefined, [join(outside, "missing.json")], "example")).toEqual([]);
    const broken = join(outside, "broken.json");
    symlinkSync(join(root, "missing.json"), broken);
    expect(() => loadPrivateTerms(root, undefined, [broken], "example")).toThrow("privacy-check: operation failed");
  });
});

describe("Git scope", () => {
  test("adjacent added comments retain provenance context across lines", () => {
    const root = repository(), path = join(root, "example.test.ts");
    const provenance = "Ver" + "batim shape con" + "firmed";
    const origin = "li" + "ve against the real team account on this machine";
    for (const snippet of [
      ["/*", ` * ${provenance}`, ` * ${origin}`, " */"],
      [`// ${provenance}`, `// ${origin}`],
      ["/*", provenance, origin, "*/"],
    ]) {
      writeFileSync(path, snippet.join("\n") + "\n");
      git(root, "add", "example.test.ts");
      expect(scan(root, "staged").map(f => f.rule)).toContain("live-fixture-provenance");
    }
    writeFileSync(path, [`// ${provenance}`, "const example = 1;", `// ${origin}`].join("\n"));
    git(root, "add", "example.test.ts");
    expect(scan(root, "staged")).toEqual([]);
  });

  test("reads indexed additions and ignores unstaged content and removed lines", () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), `${privateHome}\n`);
    expect(scan(root, "staged")).toEqual([]);
    git(root, "add", "example.txt");
    writeFileSync(join(root, "example.txt"), "example\n");
    expect(scan(root, "staged").map(f => f.rule)).toContain("identifying-home-path");
    git(root, "commit", "-m", "Synthetic negative fixture");
    git(root, "add", "example.txt");
    expect(scan(root, "staged")).toEqual([]);
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new"].join("\n");
    expect(addedLines(diff)[0]?.text).toBe("new");
  });

  test("each commit is checked even when a later commit removes the addition", () => {
    const root = repository(), base = git(root, "rev-parse", "HEAD");
    record(root, `${privateHome}\n`);
    const head = record(root, "example\n");
    expect(scan(root, rangeCommits(root, base, head)).map(f => f.rule)).toContain("identifying-home-path");
    expect(rangeCommits(root, zero, head)).toHaveLength(3);
  });

  test("outgoing existing, new, multiple and deleted refs", () => {
    const root = repository(), base = git(root, "rev-parse", "HEAD"), remote = directory();
    git(remote, "init", "--bare");
    git(root, "remote", "add", "destination", remote);
    git(root, "push", "destination", "main");
    const first = record(root, `${privateHome}\n`);
    const head = record(root, "example\n");
    const update = `refs/heads/main ${head} refs/heads/main ${base}`;
    const branch = `refs/heads/new ${head} refs/heads/new ${zero}`;
    const deletion = `delete ${zero} refs/heads/old ${base}`;
    expect(outgoingCommits(root, update, "destination")).toEqual([first, head]);
    expect(outgoingCommits(root, branch, "destination")).toEqual([first, head]);
    expect(outgoingCommits(root, [update, branch, deletion].join("\n"), "destination")).toEqual([first, head]);
    expect(outgoingCommits(root, deletion, "unreachable")).toEqual([]);
    expect(scan(root, outgoingCommits(root, branch, "destination"))).toHaveLength(1);
    const emptyRemote = directory();
    git(emptyRemote, "init", "--bare");
    expect(outgoingCommits(root, branch, emptyRemote)).toHaveLength(3);
  });

  test("public diagnostics never include values, source lines or policy paths", () => {
    const root = repository();
    writeFileSync(join(root, "example.txt"), `${privateHome} ${credential}\n`);
    git(root, "add", "example.txt");
    const result = Bun.spawnSync([process.execPath, checker, "--staged"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AIS_PRIVACY_TERMS_FILE: join(root, privateName) },
    });
    expect(result.exitCode).toBe(1);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("identifying-home-path");
    for (const secret of [privateName, privateHome, credential, root]) expect(output).not.toContain(secret);
    const failure = Bun.spawnSync([process.execPath, checker, "--range", privateName, "HEAD"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    expect(failure.exitCode).toBe(2);
    expect(failure.stderr.toString()).toBe("privacy-check: operation failed\n");
  });
});

describe("hook installation", () => {
  test("preserves existing hooks, stdin, arguments, failure status and idempotency", () => {
    const root = repository(), hooks = join(root, ".git", "hooks");
    const fakeBun = join(root, "fake-bun");
    writeFileSync(fakeBun, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GUARD_ARGS"\ncat > "$GUARD_INPUT"\nexit "${GUARD_STATUS:-0}"\n', { mode: 0o755 });
    const previous = '#!/bin/sh\nprintf "%s\\n" "$@" > "$OLD_ARGS"\ncat > "$OLD_INPUT"\nexit "${OLD_STATUS:-0}"\n';
    for (const kind of ["pre-commit", "pre-push"]) writeFileSync(join(hooks, kind), previous, { mode: 0o755 });
    installHooks(root, fakeBun);
    const installed = readFileSync(join(hooks, "pre-push"), "utf8");
    installHooks(root, fakeBun);
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(installed);
    expect(readFileSync(join(hooks, "pre-push.before-privacy"), "utf8")).toBe(previous);
    const env = {
      ...process.env, OLD_ARGS: join(root, "old-args"), OLD_INPUT: join(root, "old-input"),
      GUARD_ARGS: join(root, "guard-args"), GUARD_INPUT: join(root, "guard-input"),
    };
    const input = `refs/heads/main ${"1".repeat(40)} refs/heads/main ${zero}\n`;
    const run = (kind: string, extra: Record<string, string> = {}) => Bun.spawnSync(
      [join(hooks, kind), "destination", "synthetic-destination"],
      { cwd: root, env: { ...env, ...extra }, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" },
    );
    expect(run("pre-push").exitCode).toBe(0);
    expect(readFileSync(env.OLD_INPUT, "utf8")).toBe(input);
    expect(readFileSync(env.GUARD_INPUT, "utf8")).toBe(input);
    expect(readFileSync(env.OLD_ARGS, "utf8")).toBe("destination\nsynthetic-destination\n");
    expect(readFileSync(env.GUARD_ARGS, "utf8")).toContain("--pre-push\ndestination\nsynthetic-destination\n");
    writeFileSync(env.GUARD_INPUT, "not called");
    expect(run("pre-push", { OLD_STATUS: "7" }).exitCode).toBe(7);
    expect(readFileSync(env.GUARD_INPUT, "utf8")).toBe("not called");
    expect(run("pre-push", { GUARD_STATUS: "9" }).exitCode).toBe(9);
    expect(run("pre-commit", { OLD_STATUS: "6" }).exitCode).toBe(6);
    expect(run("pre-commit", { GUARD_STATUS: "8" }).exitCode).toBe(8);
    expect(readFileSync(env.GUARD_ARGS, "utf8")).toContain("--staged");
    chmodSync(join(hooks, "pre-commit"), 0o644);
    installHooks(root, fakeBun);
    expect(run("pre-commit").exitCode).toBe(0);
  });

  test("refuses hook paths outside git-common hooks without mutations", () => {
    const root = repository(), outside = directory(), custom = join(root, "custom-hooks");
    mkdirSync(custom);
    const existing = join(outside, "pre-commit"), content = "#!/bin/sh\nexit 0\n";
    writeFileSync(existing, content, { mode: 0o755 });
    const before = readdirSync(outside).sort();
    for (const path of [outside, custom, join(outside, "missing-hooks")]) {
      git(root, "config", "core.hooksPath", path);
      expect(() => installHooks(root)).toThrow("hook installation failed");
      expect(readdirSync(outside).sort()).toEqual(before);
      expect(readFileSync(existing, "utf8")).toBe(content);
      expect(readdirSync(custom)).toEqual([]);
      expect(existsSync(join(outside, "pre-push"))).toBe(false);
      expect(existsSync(join(outside, "missing-hooks"))).toBe(false);
    }
    const hooks = join(root, ".git", "hooks");
    renameSync(hooks, `${hooks}.saved`);
    symlinkSync(outside, hooks, "dir");
    git(root, "config", "core.hooksPath", hooks);
    expect(() => installHooks(root)).toThrow("hook installation failed");
    expect(readdirSync(outside).sort()).toEqual(before);
    expect(readFileSync(existing, "utf8")).toBe(content);
    expect(existsSync(join(outside, "pre-push"))).toBe(false);
  });

  test("default installation refuses changed managed hooks", () => {
    const root = repository(), hooks = join(root, ".git", "hooks");
    git(root, "config", "--unset", "core.hooksPath");
    installHooks(root);
    const target = join(hooks, "pre-commit");
    writeFileSync(target, readFileSync(target, "utf8") + "# custom change\n");
    expect(() => installHooks(root)).toThrow("hook installation failed");
  });
});
