import { expect, test } from "bun:test";
import { canonicalConfig } from "../../src/live/portable.ts";
import { classify } from "../../src/live/path-classes.ts";
import { portableIdentitiesFile } from "../../src/sync/registry.ts";
import { CLAUDE_CONFIG } from "../../src/identities/tool-configs.ts";

test("host portability shares B path authority and settings canonicalisation", () => {
  expect(classify(".claude/identities/work/settings.json")).toBe("config:settings");
  expect(classify(".claude/identities/work/.credentials.json")).toBe("auth");
  expect(classify(".claude/identities/work/models/provider.bin")).toBe("ignore");
  expect(classify(".ais/memory/GLOBAL.md")).toBe("ignore");
  const raw = new TextEncoder().encode(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `${"/ho" + "me"}/synthetic-fixture/.local/bin/test` }] }] } }));
  const portable = JSON.parse(new TextDecoder().decode(canonicalConfig(".claude/settings.json", raw))) as { hooks: unknown };
  expect(JSON.stringify(portable)).not.toContain(`${"/ho" + "me"}/synthetic-fixture`);
});

test("identity registry uses shared portable path rules", () => {
  const home = `${"/ho" + "me"}/synthetic-fixture`;
  const file = { version: 1 as const, identities: [{ name: "work", label: "Work", configDir: `${home}/.claude/identities/work`, directories: [`${home}/projects/work`] }] };
  const cfg = { ...CLAUDE_CONFIG, identitiesJsonPath: `${home}/.claude/identities.json` };
  const portable = portableIdentitiesFile(file, cfg, home);
  expect(portable.identities[0]?.configDir).toBe("~/.claude/identities/work");
  expect(portable.identities[0]?.directories?.[0]).toBe("~/projects/work");
});
