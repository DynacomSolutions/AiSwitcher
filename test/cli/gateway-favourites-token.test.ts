import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { runFavouritesTokenCommand } from "../../src/cli/gateway/favourites-token.ts";
import type { GatewayCliDeps } from "../../src/cli/gateway/apps.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const expected = (admin: string): string => createHmac("sha256", admin).update("ais-favourites-v1").digest("hex");
const deps = (out: string[], secretsPath: string): GatewayCliDeps => ({ out: (l) => out.push(l), secretsPath, fetch, kubectl: async () => ({ code: 0, stderr: "" }), now: () => 0 });

test("prints the derived token from the environment and nothing else", async () => {
  const out: string[] = [];
  await runFavouritesTokenCommand([], deps(out, "/nonexistent/secrets"), { AIS_GATEWAY_ADMIN_TOKEN: "admin-value-1" });
  expect(out).toEqual([expected("admin-value-1")]);
});

test("reads the admin token from the secrets file when the environment has none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ais-fav-token-"));
  dirs.push(dir);
  const file = join(dir, "secrets");
  writeFileSync(file, "AIS_GATEWAY_ADMIN_TOKEN=admin-value-2\n", { mode: 0o600 });
  const out: string[] = [];
  await runFavouritesTokenCommand([], deps(out, file), {});
  expect(out).toEqual([expected("admin-value-2")]);
});

test("refuses without an admin token, and with extra arguments", async () => {
  await expect(runFavouritesTokenCommand([], deps([], "/nonexistent/secrets"), {})).rejects.toThrow("AIS_GATEWAY_ADMIN_TOKEN");
  await expect(runFavouritesTokenCommand(["x"], deps([], "/nonexistent/secrets"), { AIS_GATEWAY_ADMIN_TOKEN: "a" })).rejects.toThrow("Usage");
});
