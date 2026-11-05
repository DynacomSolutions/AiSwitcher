import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRemoteBase } from "../../../src/cli/gateway/local-remote.ts";

let dir: string;
let secrets: string;
let remembered: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-local-remote-"));
  secrets = join(dir, "secrets");
  remembered = join(dir, "remembered");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const exists = (p: string): Promise<boolean> => readFile(p, "utf8").then(() => true, () => false);

describe("resolveRemoteBase", () => {
  test("a URL from ~/.secrets is used and remembered", async () => {
    await writeFile(secrets, "AIS_GATEWAY_PROXY_URL=https://gw.example.com\n");
    expect(await resolveRemoteBase({ env: {}, secretsPath: secrets, rememberPath: remembered })).toBe("https://gw.example.com");
    expect((await readFile(remembered, "utf8")).trim()).toBe("https://gw.example.com");
  });

  test("a shell-env URL is used but never remembered", async () => {
    await writeFile(secrets, "OTHER=1\n");
    expect(await resolveRemoteBase({ env: { AIS_GATEWAY_REMOTE_URL: "https://env.example.com" }, secretsPath: secrets, rememberPath: remembered })).toBe("https://env.example.com");
    expect(await resolveRemoteBase({ env: { AIS_GATEWAY_PROXY_URL: "https://env2.example.com" }, secretsPath: secrets, rememberPath: remembered })).toBe("https://env2.example.com");
    expect(await exists(remembered)).toBe(false);
  });

  test("a readable ~/.secrets without the key clears the remembered copy", async () => {
    await writeFile(remembered, "https://old.example.com\n");
    await writeFile(secrets, "OTHER=1\n");
    expect(await resolveRemoteBase({ env: {}, secretsPath: secrets, rememberPath: remembered })).toBe("");
    expect(await exists(remembered)).toBe(false);
  });

  test("an unreadable ~/.secrets falls back to the remembered copy", async () => {
    await writeFile(remembered, "https://old.example.com\n");
    expect(await resolveRemoteBase({ env: {}, secretsPath: join(dir, "missing"), rememberPath: remembered })).toBe("https://old.example.com");
  });
});
