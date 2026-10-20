import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { affectedHostChecks } from "../../scripts/host/affected";
import { contentRoute, filterRoute } from "../../apps/host/src/routes";
import { acceptOperationProgress } from "../../apps/host/src/operation";
import { selectPackagedExecutable, validateNativeSmoke } from "../../scripts/host/native-smoke";

describe("host dependency selection", () => {
  test("runs the shell suite when a host UI file changes", () => {
    expect(affectedHostChecks(["apps/host/src/App.tsx"])).toEqual(["host"]);
  });

  test("runs the host suite for adapter and B contract inputs", () => {
    expect(affectedHostChecks(["src/host/contract.ts"])).toEqual(["host"]);
    expect(affectedHostChecks(["image/contract/manifest.schema.json"])).toEqual(["host"]);
  });

  test("fails safe to all host checks for uncertain shared inputs", () => {
    expect(affectedHostChecks(["package.json"])).toEqual(["all"]);
    expect(affectedHostChecks(["apps/other/unknown.txt"])).toEqual(["all"]);
    expect(affectedHostChecks(["apps/host/src/App.tsx", "apps/other/unknown.txt"])).toEqual(["all"]);
    expect(affectedHostChecks(["src/sync/service.ts"])).toEqual(["all"]);
    expect(affectedHostChecks(["src/live/dispatch.ts"])).toEqual(["all"]);
    expect(affectedHostChecks(["image/release/minisign.pub"])).toEqual(["all"]);
    expect(affectedHostChecks(["apps/web/pnpm-lock.yaml"])).toEqual(["all"]);
    expect(affectedHostChecks(["apps/host/bun.lock"])).toEqual(["all"]);
    expect(affectedHostChecks(["Cargo.lock"])).toEqual(["all"]);
    expect(affectedHostChecks(["package.json", "apps/host/src/App.tsx"])).toEqual(["all"]);
    expect(affectedHostChecks(["apps/host/src/App.tsx", "unknown/path.ts"])).toEqual(["all"]);
    expect(affectedHostChecks(["src/shared/run-wrapper.ts"])).toEqual(["all"]);
    expect(affectedHostChecks(["src/identities/registry.ts"])).toEqual(["all"]);
    expect(affectedHostChecks(["image/release-key/signing.ts"])).toEqual(["all"]);
  });

  test("skips unrelated prose while checking build and workflow inputs", () => {
    expect(affectedHostChecks(["docs/agents/history.md"])).toEqual([]);
    expect(affectedHostChecks(["apps/host/Cargo.lock"])).toEqual(["all"]);
    expect(affectedHostChecks([".github/workflows/host-app.yml"])).toEqual(["all"]);
  });

  test("the production entry and capabilities expose no mock bridge or broad access", () => {
    const main = readFileSync(new URL("../../apps/host/src/main.tsx", import.meta.url), "utf8");
    const capability = JSON.parse(readFileSync(new URL("../../apps/host/src-tauri/capabilities/main.json", import.meta.url), "utf8")) as { permissions: string[] };
    expect(main).not.toContain("bridge.test");
    expect(main).toContain('from "./bridge"');
    expect(capability.permissions).toEqual(["core:event:allow-listen", "core:event:allow-unlisten"]);
    expect(capability.permissions.join(" ")).not.toMatch(/shell|fs|filesystem/i);
  });
});

describe("packaged native smoke selection", () => {
  test("accepts an existing executable for the current platform", () => {
    expect(selectPackagedExecutable(process.execPath)).toBe(process.execPath);
  });

  test("requires both a zero exit status and the native ready marker", () => {
    expect(() => validateNativeSmoke(0, "AIS_HOST_READY\n")).not.toThrow();
    expect(() => validateNativeSmoke(0, "no marker\n")).toThrow("without the native ready marker");
    expect(() => validateNativeSmoke(2, "AIS_HOST_READY\n")).toThrow("status 2");
  });
});

describe("content routes", () => {
  test("round-trips drive content IDs as path segments", () => {
    const route = contentRoute("drive/one");
    expect(route).toBe("/drives/drive%2Fone");
    expect(route.split("?")[0]).toBe("/drives/drive%2Fone");
  });

  test("replaces filter query state without changing the content path", () => {
    expect(filterRoute("/drives/drive-one", "status", "ready", "?sort=name")).toBe("/drives/drive-one?sort=name&status=ready");
  });

  test("ignores progress from another operation and keeps completed state", () => {
    const current = { id: "a", phase: "running" as const, completedBytes: 2, totalBytes: 4, canCancel: true, errorCode: null };
    expect(acceptOperationProgress(null, current)).toBe(current);
    const stale = { ...current, id: "b", completedBytes: 3 };
    expect(acceptOperationProgress(current, stale)).toBe(current);
    const done = { ...current, phase: "completed" as const, canCancel: false };
    expect(acceptOperationProgress(done, { ...done, phase: "running", canCancel: true })).toBe(done);
  });
});

