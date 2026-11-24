import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** Argument errors of `scripts/sessions-compare.ts` exit 2 with a message. They never throw. */

async function run(args: string[]): Promise<{ code: number; err: string; out: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../../scripts/sessions-compare.ts"), ...args], { env: { ...process.env, AIS_GATEWAY_STORE_DATABASE_URL: "" }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, err, out };
}

describe("sessions-compare arguments", () => {
  test("a flag with no value exits 2 and names the flag", async () => {
    for (const flag of ["--config-dir", "--node", "--days", "--rows", "--out"]) {
      const r = await run(["--node", "n", "--config-dir", "/x", flag]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`${flag} needs a value`);
      expect(r.err).not.toContain("TypeError");
    }
    const r = await run(["--config-dir", "--node", "n"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--config-dir needs a value");
  });

  test("missing and unknown arguments exit 2", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["--node", "n"])).err).toContain("--config-dir is required");
    expect((await run(["--node", "n", "--config-dir", "/x", "--days", "0"])).err).toContain("--days");
    expect((await run(["--bogus"])).err).toContain("unknown argument");
  });

  test("--print-sql prints a SELECT and exits 0", async () => {
    const r = await run(["--print-sql"]);
    expect(r.code).toBe(0);
    expect(r.out.trim().toUpperCase().startsWith("SELECT")).toBe(true);
  });
});
