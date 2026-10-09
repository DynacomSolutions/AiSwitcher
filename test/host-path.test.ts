import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { translateHostPath, untranslateHostPath } from "../src/identities/match.ts";

describe("translateHostPath", () => {
  const local = "/synthetic/container-home";
  const env = { AIS_HOST_HOME: "/synthetic/host-home" };

  test("rewrites the host-home prefix to the local home", () => {
    expect(translateHostPath("/synthetic/host-home/.claude/identities/a", env, local)).toBe(
      "/synthetic/container-home/.claude/identities/a",
    );
    expect(translateHostPath("/synthetic/host-home", env, local)).toBe(local);
  });

  test("tolerates a trailing slash on AIS_HOST_HOME", () => {
    expect(translateHostPath("/synthetic/host-home/x", { AIS_HOST_HOME: "/synthetic/host-home/" }, local)).toBe(
      "/synthetic/container-home/x",
    );
  });

  test("is a no-op when the prefix is absent or only a sibling name matches", () => {
    expect(translateHostPath("/elsewhere/x", env, local)).toBe("/elsewhere/x");
    expect(translateHostPath("/synthetic/host-home2/x", env, local)).toBe("/synthetic/host-home2/x");
  });

  test("defaults to no change when AIS_HOST_HOME is unset or equals the local home", () => {
    expect(translateHostPath("/synthetic/host-home/x", {}, local)).toBe("/synthetic/host-home/x");
    expect(translateHostPath("/synthetic/container-home/x", { AIS_HOST_HOME: local }, local)).toBe(
      "/synthetic/container-home/x",
    );
    const real = `${homedir()}/.claude/x`;
    expect(translateHostPath(real, {})).toBe(real);
  });
});

describe("untranslateHostPath", () => {
  const local = "/synthetic/container-home";
  const env = { AIS_HOST_HOME: "/synthetic/host-home" };

  test("rewrites the local-home prefix to the host home", () => {
    expect(untranslateHostPath("/synthetic/container-home/.claude/x", env, local)).toBe("/synthetic/host-home/.claude/x");
    expect(untranslateHostPath(local, env, local)).toBe("/synthetic/host-home");
    expect(untranslateHostPath("/synthetic/container-home2/x", env, local)).toBe("/synthetic/container-home2/x");
  });

  test("is a no-op outside a container", () => {
    expect(untranslateHostPath("/synthetic/container-home/x", {}, local)).toBe("/synthetic/container-home/x");
  });
});

describe("identities store in a container", () => {
  test("load maps host configDirs to the local home; save writes host paths back", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { loadIdentitiesFile, saveIdentitiesFile } = await import("../src/identities/store.ts");
    const dir = await mkdtemp(`${tmpdir()}/ais-host-path-`);
    const path = `${dir}/identities.json`;
    const prev = process.env.AIS_HOST_HOME;
    try {
      const host = "/synthetic/host-home";
      await Bun.write(
        path,
        JSON.stringify({ version: 1, identities: [{ name: "a", label: "A", configDir: `${host}/.claude/identities/a` }] }),
      );
      // Host case: AIS_HOST_HOME unset leaves the path untouched.
      delete process.env.AIS_HOST_HOME;
      expect((await loadIdentitiesFile(path)).identities[0]?.configDir).toBe(`${host}/.claude/identities/a`);
      process.env.AIS_HOST_HOME = host;
      const loaded = await loadIdentitiesFile(path);
      expect(loaded.identities[0]?.configDir).toBe(`${homedir()}/.claude/identities/a`);
      await saveIdentitiesFile(path, loaded);
      expect(await readFile(path, "utf8")).toContain(`${host}/.claude/identities/a`);
      expect(await readFile(path, "utf8")).not.toContain(homedir());
    } finally {
      if (prev === undefined) delete process.env.AIS_HOST_HOME;
      else process.env.AIS_HOST_HOME = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
