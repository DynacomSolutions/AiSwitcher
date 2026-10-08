import { afterEach, expect, spyOn, test } from "bun:test";
import * as clack from "@clack/prompts";
import { promptForIdentity } from "../src/identities/prompt.ts";
import type { IdentitiesFile, ToolConfig } from "../src/identities/types.ts";

afterEach(() => {
  for (const fn of ["select", "intro", "outro"] as const) spyOn(clack, fn).mockRestore();
});

test("interactive picker does not offer pools", async () => {
  const file: IdentitiesFile = {
    version: 1,
    identities: [
      { name: "solo", label: "Solo", configDir: "/example/solo" },
      { name: "acct-a", label: "Account A", configDir: "/example/acct-a" },
      { name: "acct-b", label: "Account B", configDir: "/example/acct-b" },
      { name: "shared-pool", label: "Shared Pool", configDir: "/example/shared-pool", swapPool: { accounts: ["acct-a", "acct-b"] } },
    ],
  };
  const cfg = { toolName: "claude" } as ToolConfig;
  let offered: string[] = [];
  spyOn(clack, "intro").mockImplementation(() => {});
  spyOn(clack, "outro").mockImplementation(() => {});
  spyOn(clack, "select").mockImplementation((async (opts: { options: Array<{ value: string }> }) => {
    offered = opts.options.map((o) => o.value);
    return "solo";
  }) as never);
  const result = await promptForIdentity(file, cfg, 1000);
  expect(result.identity.name).toBe("solo");
  expect(offered).toContain("acct-a");
  expect(offered).not.toContain("shared-pool");
});
