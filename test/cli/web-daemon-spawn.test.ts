import { describe, expect, test } from "bun:test";
import { daemonSpawnArgs } from "../../src/cli/web.ts";

/**
 * The detached daemon's argv, tested as a pure function. This is the
 * plumbing that carries `--idle-shutdown-ms=N` from an IMPLICIT spawn (e.g.
 * `ais herdr`, see herdr.test.ts's "console daemon lifetime" tests) into
 * the daemon child's own `--serve-internal` invocation (src/cli/web.ts's
 * runWebCommand reads it back out and passes it to startConsoleServer).
 * An explicit `ais web start`/`open` never supplies idleShutdownMs, so its
 * daemon's argv carries no such flag and it runs forever - unchanged from
 * before this fix.
 */
describe("daemonSpawnArgs", () => {
  test("explicit ais web start: no idle-shutdown flag at all", () => {
    const args = daemonSpawnArgs(["/usr/local/bin/ais"], undefined, 47129);
    expect(args).toEqual(["/usr/local/bin/ais", "web", "--serve-internal", "--port=47129"]);
    expect(args.some((a) => a.startsWith("--idle-shutdown-ms"))).toBe(false);
  });

  test("an implicit spawn (e.g. ais herdr) carries --idle-shutdown-ms", () => {
    const args = daemonSpawnArgs(["/usr/local/bin/ais"], undefined, 47129, 600_000);
    expect(args).toContain("--idle-shutdown-ms=600000");
  });

  test("setsid, when available, is prepended so a closed terminal cannot SIGHUP the daemon", () => {
    const args = daemonSpawnArgs(["/usr/local/bin/ais"], "/usr/bin/setsid", 47129);
    expect(args[0]).toBe("/usr/bin/setsid");
  });

  test("the dev entrypoint (bun runtime + script path) is passed through untouched", () => {
    const args = daemonSpawnArgs(["/usr/bin/bun", "/repo/src/ais.ts"], undefined, 4000, 1000);
    expect(args).toEqual([
      "/usr/bin/bun",
      "/repo/src/ais.ts",
      "web",
      "--serve-internal",
      "--port=4000",
      "--idle-shutdown-ms=1000",
    ]);
  });
});
