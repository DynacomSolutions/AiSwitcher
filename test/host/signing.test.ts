import { expect, test } from "bun:test";

test("macOS signing skips missing credentials and preserves sign, notarise, staple ordering", () => {
  const result = Bun.spawnSync(["python3", "-B", "test/host/sign_macos_test.py"], {
    stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 64 * 1024,
  });
  expect(result.stderr.toString()).toContain("OK");
  expect(result.exitCode).toBe(0);
}, 35_000);
