import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { aggregatePassed, checkWorkflow, type Workflow } from "../../scripts/host/check-workflows";
import { parseArtifacts } from "../../scripts/host/windows-tests";
import { validateReleaseCommit } from "../../scripts/host/validate-tag";

const read = (name: string) => Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;

describe("host workflow policy", () => {
  test("checks the actual workflow structures", () => {
    expect(checkWorkflow(read("host-app"), false)).toEqual([]);
    expect(checkWorkflow(read("release-host-app"), true)).toEqual([]);
  });
  test("rejects runner, permission, scheduling and container regressions", () => {
    for (const change of [
      (w: Workflow) => { w.jobs.checks!["runs-on"] = ["self-hosted"]; },
      (w: Workflow) => { w.jobs.checks!.container = "example.invalid/image"; },
      (w: Workflow) => { w.on.schedule = [{ cron: "0 0 * * *" }]; },
      (w: Workflow) => { w.permissions = { contents: "write" }; },
      (w: Workflow) => { w.jobs.checks!.env = { CERT: "${{ secrets.DYNACOM_APPLE_DEVELOPER_ID_P12_BASE64 }}" }; },
    ]) {
      const workflow = read("host-app");
      change(workflow);
      expect(checkWorkflow(workflow, false).length).toBeGreaterThan(0);
    }
  });
  test("the aggregate accepts only deliberate dependency skips", () => {
    expect(aggregatePassed("success", "skip", "skipped", "skipped")).toBe(true);
    expect(aggregatePassed("success", "host", "success", "success")).toBe(true);
    for (const status of ["skipped", "failure", "cancelled", "unknown"]) {
      expect(aggregatePassed("success", "host", status, "success")).toBe(false);
      expect(aggregatePassed("success", "all", "success", status)).toBe(false);
    }
    expect(aggregatePassed("failure", "skip", "skipped", "skipped")).toBe(false);
    expect(aggregatePassed("success", "", "skipped", "skipped")).toBe(false);
    expect(aggregatePassed("success", "skip", "failure", "skipped")).toBe(false);
    expect(aggregatePassed("success", "host", "success", "success", "success", "success")).toBe(true);
    expect(aggregatePassed("success", "host", "success", "success", "success", "failure")).toBe(false);
    expect(aggregatePassed("success", "skip", "skipped", "skipped", "skipped", "success")).toBe(false);
    expect(aggregatePassed("success", "host", "success")).toBe(false);
  });
  test("only the Windows test job uses a Windows runner", () => {
    const workflow = read("host-app");
    expect(workflow.jobs["windows-build"]!["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs["windows-test"]!["runs-on"]).toBe("windows-latest");
    workflow.jobs["windows-build"]!["runs-on"] = "windows-latest";
    expect(checkWorkflow(workflow, false).length).toBeGreaterThan(0);
  });
  test("Windows test executables are located from cargo's JSON messages", () => {
    const line = (value: object) => JSON.stringify({ reason: "compiler-artifact", ...value });
    const found = parseArtifacts([
      "not json",
      line({ executable: "/t/deps/a-1", manifest_path: "/h/crates/core/Cargo.toml", target: { kind: ["test"], name: "a" }, profile: { test: true } }),
      line({ executable: "/t/ais-host-helper.exe", manifest_path: "/h/crates/helper/Cargo.toml", target: { kind: ["bin"], name: "x" }, profile: { test: false } }),
      line({ executable: null, manifest_path: "/h/crates/helper/Cargo.toml", target: { kind: ["lib"], name: "x" }, profile: { test: false } }),
    ], "/h");
    expect(found).toEqual({ tests: [{ source: "/t/deps/a-1", exe: "tests/a-1", crate: "crates/core" }], bins: ["/t/ais-host-helper.exe"] });
  });
  test("release checks and every consumer stay on the validated commit", () => {
    for (const change of [
      (w: Workflow) => { w.jobs.checks!.with = { production: true, ref: "main" }; },
      (w: Workflow) => { w.jobs.checks!.needs = []; },
      (w: Workflow) => { w.jobs.checks!.secrets = "inherit"; },
      (w: Workflow) => { w.jobs.release!.needs = ["sign"]; },
      (w: Workflow) => { w.jobs.sign!.needs = ["validate"]; },
      (w: Workflow) => { w.jobs.release!.if = "${{ always() }}"; },
      (w: Workflow) => { w.jobs.sign!.steps![0]!.with = { ref: "main" }; },
    ]) {
      const workflow = read("release-host-app");
      change(workflow);
      expect(checkWorkflow(workflow, true).length).toBeGreaterThan(0);
    }
  });
  test("the tag resolves to the exact checked commit already present on main", () => {
    const sha = "a".repeat(40);
    const commands: string[][] = [];
    const execute = (args: string[]) => {
      commands.push(args);
      return args[1] === "rev-parse" ? `${sha}\n` : "";
    };
    expect(() => validateReleaseCommit("host-v0.1.0", "0.1.0", sha, execute)).not.toThrow();
    expect(commands).toEqual([
      ["git", "rev-parse", "refs/tags/host-v0.1.0^{commit}"],
      ["git", "merge-base", "--is-ancestor", sha, "origin/main"],
    ]);
    expect(() => validateReleaseCommit("host-v0.1.0", "0.1.0", sha, () => "b".repeat(40))).toThrow("does not point");
    expect(() => validateReleaseCommit("host-v0.1.0", "0.1.0", sha, (args) => {
      if (args[1] === "merge-base") throw new Error("SYNTHETIC_FIXTURE commit is outside main");
      return sha;
    })).toThrow("outside main");
    for (const tag of ["v0.1.0", "host-v0.2.0", "host-v0.1.0\nextra"]) {
      expect(() => validateReleaseCommit(tag, "0.1.0", sha, execute)).toThrow("Tag must match");
    }
    expect(() => validateReleaseCommit("host-v0.1.0", "0.1.0", "short", execute)).toThrow("exact workflow commit");
  });
});
