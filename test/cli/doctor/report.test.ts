import { describe, expect, test } from "bun:test";
import { formatDoctorReport } from "../../../src/cli/doctor/report.ts";
import type { DoctorResult } from "../../../src/cli/doctor/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

// process.stdout.isTTY is false under `bun test` (see test/cli/colors.test.ts),
// so colors.ts's wrap functions are no-ops here — assertions below check
// plain text, not ANSI codes.

function identity(name: string, label = name): Identity {
  return { name, label, configDir: `/tmp/does-not-exist/${name}` };
}

function responsive(toolName: DoctorResult["toolName"], name: string, elapsedMs = 2400): DoctorResult {
  return { toolName, identity: identity(name), status: "responsive", elapsedMs };
}

function hung(toolName: DoctorResult["toolName"], name: string, detail: string): DoctorResult {
  return { toolName, identity: identity(name), status: "hung", elapsedMs: 20_000, detail };
}

function unavailable(toolName: DoctorResult["toolName"], name: string, detail: string): DoctorResult {
  return { toolName, identity: identity(name), status: "unavailable", detail };
}

describe("formatDoctorReport", () => {
  test("empty input", () => {
    expect(formatDoctorReport([])).toBe("No matching identities found.");
  });

  test("groups results by tool under one header each, with an identity count", () => {
    const output = formatDoctorReport([responsive("claude", "personal"), responsive("codex", "personal")]);
    expect(output).toContain("claude (1 identity)");
    expect(output).toContain("codex (1 identity)");
  });

  test("a responsive identity shows the status and elapsed time", () => {
    const output = formatDoctorReport([responsive("claude", "personal", 2456)]);
    expect(output).toContain("responsive");
    expect(output).toContain("2.5s");
  });

  test("a hung identity shows its detail message", () => {
    const output = formatDoctorReport([hung("claude", "identity-a", 'claude did not respond within 20s (MCP disabled, so this isn\'t an MCP-server issue)')]);
    expect(output).toContain("hung");
    expect(output).toContain("MCP disabled");
  });

  test("an unavailable identity has no elapsed time", () => {
    const output = formatDoctorReport([unavailable("grok", "personal", "Could not locate the real 'grok' binary")]);
    expect(output).toContain("unavailable");
    expect(output).not.toContain("s)"); // no "(N.Ns)" elapsed suffix anywhere
  });

  test("a trailing summary line calls out hung identities by tool/name", () => {
    const output = formatDoctorReport([responsive("claude", "personal"), hung("claude", "identity-a", "timed out")]);
    const lines = output.split("\n");
    const summary = lines[lines.length - 1]!;
    expect(summary).toContain("claude/identity-a");
    expect(summary).not.toContain("claude/personal");
  });

  test("no summary line at all when nothing is hung", () => {
    const output = formatDoctorReport([responsive("claude", "personal"), responsive("codex", "personal")]);
    expect(output).not.toContain("Hung:");
  });

  test("multiple tool sections are separated by a blank line", () => {
    const output = formatDoctorReport([responsive("claude", "personal"), responsive("codex", "personal")]);
    const lines = output.split("\n");
    const claudeIdx = lines.findIndex((l) => l.startsWith("claude"));
    const codexIdx = lines.findIndex((l) => l.startsWith("codex"));
    expect(lines[codexIdx - 1]).toBe("");
    expect(claudeIdx).toBeLessThan(codexIdx);
  });
});
