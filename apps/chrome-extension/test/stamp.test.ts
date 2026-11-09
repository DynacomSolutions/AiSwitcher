import { describe, expect, test } from "bun:test";
import { stampManifest } from "../stamp.ts";

describe("stampManifest", () => {
  test("uses the AIS version", () => {
    expect(stampManifest({ version: "0.0.0", name: "x" }, "0.5.33")).toEqual({ version: "0.5.33", name: "x" });
  });
  test("prerelease suffix only goes in version_name", () => {
    expect(stampManifest({ version: "0.0.0" }, "0.6.0-rc.1")).toEqual({ version: "0.6.0", version_name: "0.6.0-rc.1" });
  });
  test("rejects versions Chrome would refuse", () => {
    expect(() => stampManifest({}, "v1")).toThrow();
    expect(() => stampManifest({}, "1.70000.0")).toThrow();
  });
  test("a build stamps the root package.json version", async () => {
    const dir = `${import.meta.dir}/../dist/stamp-test`;
    const proc = Bun.spawn(["bun", "run", "build.ts", dir], { cwd: `${import.meta.dir}/..`, stdout: "ignore", stderr: "inherit" });
    expect(await proc.exited).toBe(0);
    const pkg = (await Bun.file(`${import.meta.dir}/../../../package.json`).json()) as { version: string };
    expect((await Bun.file(`${dir}/manifest.json`).json()).version).toBe(pkg.version.split("-")[0]!);
  });
});
