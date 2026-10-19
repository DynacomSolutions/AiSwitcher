import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

for (const quiet of [false, true]) {
  test(`sync reports deferred paths alongside other conflicts (quiet=${quiet})`, async () => {
    const home = await mkdtemp(join(tmpdir(), "ais-sync-report-"));
    homes.push(home);
    // Isolate module mocks and HOME from the other sync tests and real profiles.
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test";
      import { mkdir } from "node:fs/promises";
      import { join } from "node:path";
      const home = process.env.HOME;
      const profile = join(home, ".codex", "identities", "SYNTHETIC_FIXTURE_identity");
      const log = ".codex/identities/SYNTHETIC_FIXTURE_identity/history.jsonl";
      const config = ".codex/identities/SYNTHETIC_FIXTURE_identity/settings.json";
      await mkdir(profile, { recursive: true });
      await Bun.write(join(home, log), "SYNTHETIC_FIXTURE_incomplete");
      await Bun.write(join(home, config), '{"setting":"local"}');
      await Bun.write(process.env.AIS_SYNC_CONFIG, JSON.stringify({ version: 2, remotes: ["SYNTHETIC_FIXTURE_remote"] }));
      const rsync = await import(${JSON.stringify(new URL("../../src/sync/rsync.ts", import.meta.url).pathname)});
      mock.module(${JSON.stringify(new URL("../../src/sync/rsync.ts", import.meta.url).pathname)}, () => ({
        ...rsync,
        runRsync: async (_remote, _direction, _filters, _home, options) => {
          await mkdir(join(options.localRoot, ".codex", "identities", "SYNTHETIC_FIXTURE_identity"), { recursive: true });
          await Bun.write(join(options.localRoot, log), "SYNTHETIC_FIXTURE_imported\\n");
          await Bun.write(join(options.localRoot, config), '{"setting":"incoming"}');
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }));
      const { CODEX_CONFIG } = await import(${JSON.stringify(new URL("../../src/identities/tool-configs.ts", import.meta.url).pathname)});
      const { syncConfiguredProfiles } = await import(${JSON.stringify(new URL("../../src/sync/service.ts", import.meta.url).pathname)});
      const result = await syncConfiguredProfiles({ direction: "pull", includeDatabases: false,
        quiet: ${quiet}, scope: { kind: "identity", cfg: CODEX_CONFIG, identityName: "SYNTHETIC_FIXTURE_identity" } });
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home, AIS_SYNC_CONFIG: join(home, "sync.json") },
      stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
    const result = JSON.parse(stdout);
    result.preservedConflictPaths.sort();
    expect(result).toMatchObject({
      pulled: ["SYNTHETIC_FIXTURE_remote"], preservedConflicts: 2,
      preservedConflictPaths: [
        ".codex/identities/SYNTHETIC_FIXTURE_identity/history.jsonl",
        ".codex/identities/SYNTHETIC_FIXTURE_identity/settings.json",
      ],
    });
    if (quiet) expect(stderr).toBe("");
    else {
      expect(stderr).toContain("history.jsonl");
      expect(stderr).toContain("settings.json");
      expect(stderr).toContain("ais sync recover");
    }
  }, 20_000);
}
