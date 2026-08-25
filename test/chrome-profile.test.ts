import { describe, expect, test } from "bun:test";
import { resolveChromeMcpTarget } from "../src/identities/chrome-profile.ts";
import type { IdentitiesFile, Identity } from "../src/identities/types.ts";

function identity(name: string, configDir: string): Identity {
  return { name, label: name, configDir };
}

describe("resolveChromeMcpTarget", () => {
  test("no identities, no overrides -> null", () => {
    const file: IdentitiesFile = { version: 1, identities: [] };
    expect(resolveChromeMcpTarget("/tmp/does-not-exist/wherever", undefined, file)).toBeNull();
  });

  test("resolves the active identity via configDir reverse-lookup", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [identity("personal", "/tmp/does-not-exist/personal"), identity("work", "/tmp/does-not-exist/work")],
    };
    const result = resolveChromeMcpTarget(
      "/tmp/does-not-exist/anywhere",
      "/tmp/does-not-exist/personal",
      file,
    );
    expect(result).toMatchObject({ identityName: "personal", source: "active-identity" });
  });

  test("configDirValue matching no known identity -> null", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [identity("personal", "/tmp/does-not-exist/personal")],
    };
    const result = resolveChromeMcpTarget("/tmp/does-not-exist/anywhere", "/tmp/does-not-exist/unknown", file);
    expect(result).toBeNull();
  });

  test("directory override wins over the active identity", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [identity("personal", "/tmp/does-not-exist/personal")],
      chromeProfileOverrides: [
        { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a" },
      ],
    };
    const result = resolveChromeMcpTarget(
      "/tmp/does-not-exist/client-x/repo",
      "/tmp/does-not-exist/personal",
      file,
    );
    expect(result).toMatchObject({ identityName: "identity-a", source: "directory-override" });
  });

  test("a matched override's label is surfaced on the resolution", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [],
      chromeProfileOverrides: [
        { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a", label: "Client X" },
      ],
    };
    const result = resolveChromeMcpTarget("/tmp/does-not-exist/client-x/repo", undefined, file);
    expect(result).toMatchObject({ identityName: "identity-a", label: "Client X" });
  });

  test("directory override applies even with no active identity/configDirValue", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [],
      chromeProfileOverrides: [
        { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a" },
      ],
    };
    const result = resolveChromeMcpTarget("/tmp/does-not-exist/client-x/repo", undefined, file);
    expect(result).toMatchObject({ identityName: "identity-a", source: "directory-override" });
  });

  test("most specific (longest) override wins among nested matches", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [],
      chromeProfileOverrides: [
        { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "shallow" },
        { directories: ["/tmp/does-not-exist/client-x/repo/*"], targetIdentity: "deep" },
      ],
    };
    const result = resolveChromeMcpTarget("/tmp/does-not-exist/client-x/repo/sub", undefined, file);
    expect(result).toMatchObject({ identityName: "deep" });
  });

  test("outside any override directory falls back to the active identity", () => {
    const file: IdentitiesFile = {
      version: 1,
      identities: [identity("personal", "/tmp/does-not-exist/personal")],
      chromeProfileOverrides: [
        { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a" },
      ],
    };
    const result = resolveChromeMcpTarget(
      "/tmp/does-not-exist/somewhere-else",
      "/tmp/does-not-exist/personal",
      file,
    );
    expect(result).toMatchObject({ identityName: "personal", source: "active-identity" });
  });
});
