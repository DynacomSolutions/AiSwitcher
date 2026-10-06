import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function invokeCreate(name: string, extraFlags: string[] = []): Promise<{
  output: string;
  exitCode: number;
  registryPath: string;
  originalRegistry: string;
  home: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "ais-invalid-create-SYNTHETIC_FIXTURE-"));
  homes.push(home);

  const registryPath = join(home, ".claude", "identities.json");
  await mkdir(join(home, ".claude"), { recursive: true });
  const originalRegistry = JSON.stringify(
    {
      version: 1,
      identities: [{ name: "fixture-personal", label: "Fixture Personal", configDir: "/tmp/SYNTHETIC_FIXTURE_personal" }],
    },
    null,
    2,
  );
  await writeFile(registryPath, originalRegistry);

  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/ais.ts"),
      "identities",
      "create",
      "--tool=claude",
      `--name=${name}`,
      ...extraFlags,
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        AIS_SYNC_CONFIG: join(home, "sync-config.json"),
        AI_PROFILE_SWITCHER_REAL_BIN_DIR: join(home, "real-bin"),
        AI_PROFILE_SWITCHER_SHIM_DIR: join(home, "shim-bin"),
        PATH: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => proc.kill(), 5_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  return { output: `${stdout}${stderr}`, exitCode, registryPath, originalRegistry, home };
}

describe("identities create early name validation", () => {
  test.each(["Identity-A", "", "identity_a"])('rejects invalid supplied name %j before prompts or registry changes', async (name) => {
    const { output, exitCode, registryPath, originalRegistry, home } = await invokeCreate(name);

    expect(exitCode).toBe(1);
    expect(output).toContain(`Error: Invalid name "${name}"`);
    expect(output).toContain("use lowercase letters, digits, and single hyphens only");
    expect(output).not.toContain("Create a new identity");
    expect(output).not.toContain("Ready to create");
    expect(await readFile(registryPath, "utf8")).toBe(originalRegistry);
    await expect(access(join(home, ".claude", "identities"))).rejects.toThrow();
  });

  test("keeps name validation strict while preserving uppercase display labels", async () => {
    const { output, exitCode, registryPath, home } = await invokeCreate("identity-a", [
      "--label=Identity A",
      "--description=",
      "--directories=",
      "--aliases=",
    ]);

    expect(exitCode).toBe(0);
    expect(output).toContain("Created identity identity-a");
    expect(output).not.toContain("Create a new identity");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(registry.identities.at(-1)).toMatchObject({ name: "identity-a", label: "Identity A" });
    await expect(access(join(home, ".claude", "identities", "identity-a"))).resolves.toBeNull();
  });
});
