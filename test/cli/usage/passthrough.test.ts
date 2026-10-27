import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ais usage tui argv", () => {
  test.skipIf(process.platform === "win32")("hands snapshot flag, tui and extras to the shared tokscale binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-usage-tui-"));
    try {
      const home = join(dir, "home");
      const out = join(dir, "argv.txt");
      const fake = join(dir, "fake-tokscale");
      await writeFile(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\n`);
      await chmod(fake, 0o700);

      const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../src/ais.ts"), "usage", "tui", "--some-extra-flag"], {
        env: { ...process.env, HOME: home, AIS_TOKSCALE_SHARED_BIN: fake },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });

      expect((await readFile(out, "utf8")).trimEnd().split("\n")).toEqual([
        "--ais-shared-snapshot",
        join(home, ".ais", "cache", "usage", "snapshot.json"),
        "tui",
        "--some-extra-flag",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
