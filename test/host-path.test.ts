import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { translateHostPath } from "../src/identities/match.ts";

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
