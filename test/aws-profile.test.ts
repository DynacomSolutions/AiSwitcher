import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awsProfilesConfigPath,
  isBedrockIdentity,
  loadAwsProfileMapping,
  parseAwsConfig,
  resolveAwsProfileForIdentity,
} from "../src/identities/aws-profile.ts";
import type { Identity } from "../src/identities/types.ts";

function identity(name: string, overrides: Partial<Identity> = {}): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}`, ...overrides };
}

const AWS_CONFIG = `
[profile nazare]
sso_session = Nazare
sso_account_id = 499324396263
region = eu-west-2
cli_pager=

[profile pcg-dev]
sso_session = Nazare
sso_account_id = 975049896933
region = eu-west-2

[profile pcg-prod]
sso_session = Nazare
sso_account_id = 779846811377
region = eu-west-2
request_checksum_calculation=WHEN_REQUIRED
s3 =
  max_concurrent_requests = 1000
  multipart_threshold = 128MB

[sso-session Nazare]
sso_region = eu-west-2

[default]
region = us-east-1
`;

describe("parseAwsConfig", () => {
  test("extracts region and sso_account_id per profile, ignoring nested and sso-session sections", () => {
    const parsed = parseAwsConfig(AWS_CONFIG);
    expect(parsed["nazare"]).toEqual({ region: "eu-west-2", accountId: "499324396263" });
    expect(parsed["pcg-dev"]).toEqual({ region: "eu-west-2", accountId: "975049896933" });
    expect(parsed["pcg-prod"]).toEqual({ region: "eu-west-2", accountId: "779846811377" });
    expect(parsed["default"]).toEqual({ region: "us-east-1" });
  });

  test("an sso-session section never becomes a profile, and indented keys are ignored", () => {
    const parsed = parseAwsConfig(AWS_CONFIG);
    // The `s3 =` sub-keys are indented and must not leak into pcg-prod's
    // region/account mapping; Nazare has no [profile Nazare] section.
    expect(parsed["pcg-prod"]).toEqual({ region: "eu-west-2", accountId: "779846811377" });
    expect(parsed["Nazare"]).toBeUndefined();
  });

  test("missing keys simply stay absent", () => {
    expect(parseAwsConfig("[profile loneregion]\nregion = us-west-2\n")).toEqual({
      loneregion: { region: "us-west-2" },
    });
  });
});

describe("loadAwsProfileMapping", () => {
  test("an absent file means no mapping, not an error", () => {
    expect(loadAwsProfileMapping("/tmp/does-not-exist/aws-profiles.json")).toEqual({});
  });

  test("a malformed file throws with the path in the message", () => {
    expect(() => loadAwsProfileMapping("/dev/null")).toThrow(/aws-profiles|Invalid AWS profiles config/i);
  });

  test("version 1 shape maps identity name -> profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-aws-profiles-"));
    try {
      const path = join(dir, "aws-profiles.json");
      writeFileSync(path, JSON.stringify({ version: 1, identities: { pcg: { profile: "pcg-prod" } } }));
      expect(loadAwsProfileMapping(path)).toEqual({ pcg: "pcg-prod" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isBedrockIdentity", () => {
  test("config.toml with model_provider amazon-bedrock is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "ais-bedrock-yes-"));
    try {
      writeFileSync(join(root, "config.toml"), 'model_provider = "amazon-bedrock"\nmodel = "openai.gpt-6-astra"\n');
      expect(isBedrockIdentity(identity("x", { configDir: root }))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a regular codex identity is not", () => {
    const root = mkdtempSync(join(tmpdir(), "ais-bedrock-no-"));
    try {
      writeFileSync(join(root, "config.toml"), 'model_provider = "openai"\n');
      expect(isBedrockIdentity(identity("x", { configDir: root }))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing configDir is not a Bedrock identity and never throws", () => {
    expect(isBedrockIdentity(identity("x", { configDir: "/tmp/does-not-exist/at-all" }))).toBe(false);
  });

  test("CLAUDE_CODE_USE_BEDROCK in the identity env is honoured", () => {
    expect(isBedrockIdentity(identity("x", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }))).toBe(true);
  });
});

describe("resolveAwsProfileForIdentity", () => {
  const deps = {
    readText: (path: string): string => {
      if (path.endsWith("aws-profiles.json")) return JSON.stringify({ version: 1, identities: { pcg: { profile: "pcg-prod" } } });
      if (path.endsWith("config")) return AWS_CONFIG;
      throw new Error(`unexpected path ${path}`);
    },
    awsProfilesPath: "/fixtures/aws-profiles.json",
    awsConfigPath: "/fixtures/config",
  };

  test("registry env AWS_PROFILE wins over the machine-local mapping", () => {
    const resolved = resolveAwsProfileForIdentity(identity("pcg", { env: { AWS_PROFILE: "nazare" } }), deps);
    expect(resolved).toEqual({ profile: "nazare", region: "eu-west-2", accountId: "499324396263" });
  });

  test("falls back to the machine-local mapping and enriches from the AWS CLI config", () => {
    expect(resolveAwsProfileForIdentity(identity("pcg"), deps)).toEqual({
      profile: "pcg-prod",
      region: "eu-west-2",
      accountId: "779846811377",
    });
  });

  test("an unmapped identity resolves to undefined", () => {
    expect(resolveAwsProfileForIdentity(identity("personal"), deps)).toBeUndefined();
  });

  test("a malformed mapping file throws rather than silently declining", () => {
    expect(() =>
      resolveAwsProfileForIdentity(identity("pcg"), {
        ...deps,
        readText: () => "not json",
      }),
    ).toThrow(/Invalid AWS profiles config/);
  });

  test("defaults: mapping path sits under the AIS config dir", () => {
    expect(awsProfilesConfigPath()).toContain(join(".ais", "config", "aws-profiles.json"));
  });

  test("a profile unknown to the AWS CLI config still resolves, without region/account", () => {
    const resolved = resolveAwsProfileForIdentity(identity("pcg"), {
      ...deps,
      readText: (path) => (path.endsWith("aws-profiles.json") ? JSON.stringify({ version: 1, identities: { pcg: { profile: "elsewhere" } } }) : AWS_CONFIG),
    });
    expect(resolved).toEqual({ profile: "elsewhere" });
  });
});
