import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiCredentialStores, persistKimiCredentials, readFreshestKimiCredentials } from "../../../src/cli/limits/kimi-store.ts";
import { KIMI_CONFIG, PI_CONFIG } from "../../../src/identities/tool-configs.ts";
import type { Identity } from "../../../src/identities/types.ts";

// kimi-store resolves BOTH registries by identity name, so the tests build
// real temp registries for the kimi AND pi tools with same-named identities,
// repointing the tools' identitiesJsonPath for the duration of each test.
const tempDirs: string[] = [];
const savedPaths: Record<string, string> = { kimi: "", pi: "" };

let kimiIdentityDir = "";
let piIdentityDir = "";

beforeEach(async () => {
  const kimiRoot = await mkdtemp(join(tmpdir(), "ais-kimi-store-kimi-"));
  const piRoot = await mkdtemp(join(tmpdir(), "ais-kimi-store-pi-"));
  tempDirs.push(kimiRoot, piRoot);
  // Repoint the registries FIRST — every registry write below must land in
  // the temp paths. The real ~/.kimi-code and ~/.pi registries are never
  // touched: savedPaths restores the originals in afterEach.
  savedPaths.kimi = KIMI_CONFIG.identitiesJsonPath;
  savedPaths.pi = PI_CONFIG.identitiesJsonPath;
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(kimiRoot, "identities.json");
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(piRoot, "identities.json");
  const kimiIdentity = { name: "acme", label: "Acme", configDir: join(kimiRoot, "identities", "acme") };
  const piIdentity = { name: "acme", label: "Acme", configDir: join(piRoot, "identities", "acme") };
  kimiIdentityDir = kimiIdentity.configDir;
  piIdentityDir = piIdentity.configDir;
  await mkdir(kimiIdentity.configDir, { recursive: true });
  await mkdir(piIdentity.configDir, { recursive: true });
  await writeFile(KIMI_CONFIG.identitiesJsonPath, JSON.stringify({ version: 1, identities: [kimiIdentity] }));
  await writeFile(PI_CONFIG.identitiesJsonPath, JSON.stringify({ version: 1, identities: [piIdentity] }));
});

afterEach(async () => {
  if (savedPaths.kimi) (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths.kimi;
  if (savedPaths.pi) (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths.pi;
  savedPaths.kimi = "";
  savedPaths.pi = "";
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function acmeFrom(tool: "kimi" | "pi"): Identity {
  return { name: "acme", label: "Acme", configDir: tool === "kimi" ? kimiIdentityDir : piIdentityDir };
}

const CREDENTIALS_PATH = (identity: Identity) => join(identity.configDir, "credentials", "kimi-code.json");
const AUTH_PATH = (identity: Identity) => join(identity.configDir, "auth.json");

describe("kimiCredentialStores", () => {
  test("resolves both stores for a same-named identity, whichever side calls", async () => {
    const fromKimi = await kimiCredentialStores(acmeFrom("kimi"), "kimi");
    const fromPi = await kimiCredentialStores(acmeFrom("pi"), "pi");
    expect(fromKimi.map((s) => s.kind)).toEqual(["native", "pi"]);
    expect(fromPi.map((s) => s.kind)).toEqual(["native", "pi"]);
  });

  test("a missing counterpart registry just shrinks the store list", async () => {
    await rm(PI_CONFIG.identitiesJsonPath);
    const stores = await kimiCredentialStores(acmeFrom("kimi"), "kimi");
    expect(stores.map((s) => s.kind)).toEqual(["native"]);
  });
});

describe("persistKimiCredentials", () => {
  test("writes the refreshed token through to BOTH stores in each store's own shape", async () => {
    const next = { access_token: "a2", refresh_token: "r2", expires_at: 1_800_000_000 };
    await persistKimiCredentials(acmeFrom("kimi"), "kimi", next);

    // native store: kimi's own shape (token fields in seconds)
    const native = JSON.parse(await readFile(CREDENTIALS_PATH(acmeFrom("kimi")), "utf8"));
    expect(native.access_token).toBe("a2");
    expect(native.refresh_token).toBe("r2");
    expect(native.expires_at).toBe(1_800_000_000);

    // pi store: pi's auth.json shape (access/refresh/expires in MS)
    const pi = JSON.parse(await readFile(AUTH_PATH(acmeFrom("pi")), "utf8"))["kimi-coding"];
    expect(pi.type).toBe("oauth");
    expect(pi.access).toBe("a2");
    expect(pi.refresh).toBe("r2");
    expect(pi.expires).toBe(1_800_000_000_000);
  });

  test("preserves unknown keys in both stores across the write", async () => {
    await mkdir(join(kimiIdentityDir, "credentials"), { recursive: true });
    await writeFile(CREDENTIALS_PATH(acmeFrom("kimi")), JSON.stringify({ access_token: "a1", scope: "profile", custom: 7 }));
    await writeFile(AUTH_PATH(acmeFrom("pi")), JSON.stringify({ "kimi-coding": { type: "oauth", access: "a1", extra: true }, "other-provider": { type: "api_key", key: "k" } }));

    await persistKimiCredentials(acmeFrom("kimi"), "kimi", { access_token: "a2", refresh_token: "r2" });

    const native = JSON.parse(await readFile(CREDENTIALS_PATH(acmeFrom("kimi")), "utf8"));
    expect(native.scope).toBe("profile");
    expect(native.custom).toBe(7);
    const piAuth = JSON.parse(await readFile(AUTH_PATH(acmeFrom("pi")), "utf8"));
    expect(piAuth["kimi-coding"].extra).toBe(true);
    expect(piAuth["other-provider"].key).toBe("k");
  });
});

describe("readFreshestKimiCredentials", () => {
  test("returns the copy with the LATEST expires_at, whichever store holds it", async () => {
    await mkdir(join(kimiIdentityDir, "credentials"), { recursive: true });
    // native holds a stale token, pi holds the fresher one
    await writeFile(CREDENTIALS_PATH(acmeFrom("kimi")), JSON.stringify({ access_token: "stale", refresh_token: "r-stale", expires_at: 1_700_000_000 }));
    await writeFile(AUTH_PATH(acmeFrom("pi")), JSON.stringify({ "kimi-coding": { type: "oauth", access: "fresh", refresh: "r-fresh", expires: 1_900_000_000_000 } }));

    const freshest = await readFreshestKimiCredentials(acmeFrom("kimi"), "kimi");
    expect(freshest).toEqual({ access_token: "fresh", refresh_token: "r-fresh", expires_at: 1_900_000_000 });
  });

  test("self-heals: after persisting the freshest token, BOTH stores read it back", async () => {
    await mkdir(join(kimiIdentityDir, "credentials"), { recursive: true });
    await writeFile(CREDENTIALS_PATH(acmeFrom("kimi")), JSON.stringify({ access_token: "dead", expires_at: 1_600_000_000 }));
    await persistKimiCredentials(acmeFrom("pi"), "pi", { access_token: "live", refresh_token: "r-live", expires_at: 1_950_000_000 });

    for (const self of ["kimi", "pi"] as const) {
      expect(await readFreshestKimiCredentials(acmeFrom(self), self)).toEqual({
        access_token: "live",
        refresh_token: "r-live",
        expires_at: 1_950_000_000,
      });
    }
  });

  test("no usable copy anywhere -> undefined", async () => {
    expect(await readFreshestKimiCredentials(acmeFrom("kimi"), "kimi")).toBeUndefined();
  });
});
