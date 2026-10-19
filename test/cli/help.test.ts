import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as migration from "../../src/shared/migrate-ais-home.ts";
import { runCli } from "../../src/cli/dispatch.ts";
import { HELP, helpText } from "../../src/cli/help.ts";

process.env.NO_COLOR = "1";
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const r of restorers.splice(0)) r();
});

async function run(...argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const mig = spyOn(migration, "migrateLegacyAisHome").mockImplementation(async () => {});
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
  restorers.push(() => [mig, log, error, exit].forEach((s) => s.mockRestore()));
  await runCli(argv);
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("ais help levels", () => {
  test.each(["identities", "sync", "swap"])("every help form for %s is identical", async (group) => {
    const forms = [[group, "help"], [group, "--help"], [group, "-h"], ["help", group], ["--help", group]];
    const outs = [];
    for (const f of forms) outs.push((await run(...f)).out);
    expect(outs[0]).toBe(helpText([group]));
    for (const o of outs) expect(o).toBe(outs[0]);
  });

  test("subcommand --help matches help <group> <sub>", async () => {
    const a = (await run("identities", "create", "--help")).out;
    expect(a).toBe((await run("help", "identities", "create")).out);
    expect(a).toContain("ais identities create");
  });

  test("top-level help is short and every group has one line", async () => {
    const { out } = await run("help");
    expect(out.split("\n").length).toBeLessThanOrEqual(40);
    for (const g of Object.keys(HELP)) expect(out).toContain(g);
  });

  test("group help stays short", () => {
    for (const g of Object.keys(HELP)) expect(helpText([g]).split("\n").length).toBeLessThanOrEqual(30);
  });

  test("unknown group and subcommand give one-line errors with valid names", async () => {
    const bad = (await run("identitis", "--help")).err;
    expect(bad.split("\n")).toHaveLength(1);
    expect(bad).toContain('Unknown command "identitis"');
    expect(bad).toContain("identities");
    const badSub = (await run("identities", "creat", "--help")).err;
    expect(badSub.split("\n")).toHaveLength(1);
    expect(badSub).toContain("create");
  });

  test("no em dashes in help data", () => {
    expect(JSON.stringify(HELP)).not.toContain("—");
  });
});
