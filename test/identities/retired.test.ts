import { describe, expect, test } from "bun:test";
import {
  activeIdentities,
  findRetiredByConfigDir,
  isRetired,
  lastRetirementEventMs,
  retireIdentityFields,
  unretireIdentityFields,
} from "../../src/identities/retired.ts";
import { IdentityResolutionError, RetiredIdentityError } from "../../src/identities/errors.ts";
import type { Identity } from "../../src/identities/types.ts";

function make(extra: Partial<Identity> = {}): Identity {
  return { name: "alpha", label: "Alpha", configDir: "/tmp/does-not-exist/alpha", ...extra };
}

describe("retired helpers", () => {
  test("isRetired is true only for retired === true", () => {
    expect(isRetired({})).toBe(false);
    expect(isRetired({ retired: false })).toBe(false);
    expect(isRetired({ retired: true })).toBe(true);
  });

  test("activeIdentities filters retired entries and keeps order", () => {
    const list = [make({ name: "a" }), make({ name: "b", retired: true }), make({ name: "c", retired: false })];
    expect(activeIdentities(list).map((i) => i.name)).toEqual(["a", "c"]);
  });

  test("retire then unretire swaps the marker fields", () => {
    const identity = make({ unretiredAt: "2026-01-01T00:00:00.000Z" });
    retireIdentityFields(identity, new Date("2026-02-01T00:00:00.000Z"));
    expect(identity.retired).toBe(true);
    expect(identity.retiredAt).toBe("2026-02-01T00:00:00.000Z");
    expect("unretiredAt" in identity).toBe(false);

    unretireIdentityFields(identity, new Date("2026-03-01T00:00:00.000Z"));
    expect("retired" in identity).toBe(false);
    expect("retiredAt" in identity).toBe(false);
    expect(identity.unretiredAt).toBe("2026-03-01T00:00:00.000Z");
  });

  test("lastRetirementEventMs returns the newest event or undefined", () => {
    expect(lastRetirementEventMs(make())).toBeUndefined();
    expect(lastRetirementEventMs({ retiredAt: "2026-02-01T00:00:00.000Z" })).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
    expect(
      lastRetirementEventMs({ retiredAt: "2026-02-01T00:00:00.000Z", unretiredAt: "2026-03-01T00:00:00.000Z" }),
    ).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
  });

  test("findRetiredByConfigDir normalises paths and ignores active identities", () => {
    const list = [
      make({ name: "live", configDir: "/tmp/does-not-exist/live" }),
      make({ name: "gone", configDir: "/tmp/does-not-exist/gone", retired: true }),
    ];
    expect(findRetiredByConfigDir(list, "/tmp/does-not-exist/gone/")?.name).toBe("gone");
    expect(findRetiredByConfigDir(list, "/tmp/does-not-exist/x/../gone")?.name).toBe("gone");
    expect(findRetiredByConfigDir(list, "/tmp/does-not-exist/live")).toBeUndefined();
  });
});

describe("RetiredIdentityError", () => {
  test("message and type", () => {
    const err = new RetiredIdentityError("claude", { name: "alpha", retiredAt: "2026-02-01T00:00:00.000Z" });
    expect(err).toBeInstanceOf(IdentityResolutionError);
    expect(err.message).toBe(
      'identity "alpha" for claude is retired (since 2026-02-01T00:00:00.000Z) and cannot be used. Run "ais identities unretire alpha --tool=claude" to restore it.',
    );
    expect(new RetiredIdentityError("codex", { name: "b" }).message).toContain("since an unknown date");
  });
});
