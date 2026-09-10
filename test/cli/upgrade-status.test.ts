import { describe, expect, test } from "bun:test";
import {
  applyUpgradeEvent,
  createUpgradeRows,
  formatUpgradeFrame,
  formatUpgradeRow,
  type UpgradeEvent,
  type UpgradeRow,
} from "../../src/cli/upgrade-status.ts";

const rows = (): UpgradeRow[] => createUpgradeRows(["claude", "zai", "ali"]);

describe("createUpgradeRows", () => {
  test("seeds every tool as a pending row in plan order", () => {
    expect(rows()).toEqual([
      { id: "claude", status: "pending" },
      { id: "zai", status: "pending" },
      { id: "ali", status: "pending" },
    ]);
  });
});

describe("applyUpgradeEvent", () => {
  test("start moves only the named row to running", () => {
    const next = applyUpgradeEvent(rows(), { type: "start", id: "zai" });
    expect(next.map((row) => row.status)).toEqual(["pending", "running", "pending"]);
  });

  test("finish records the outcome detail per status", () => {
    let next = applyUpgradeEvent(rows(), { type: "start", id: "claude" });
    next = applyUpgradeEvent(next, { type: "finish", id: "claude", ok: true, detail: "4.2.1 -> 4.3.0 (12.3s)" });
    next = applyUpgradeEvent(next, { type: "start", id: "zai" });
    next = applyUpgradeEvent(next, { type: "finish", id: "zai", ok: false, detail: "install/upgrade failed (1.0s)" });
    expect(next[0]).toEqual({ id: "claude", status: "done", detail: "4.2.1 -> 4.3.0 (12.3s)" });
    expect(next[1]).toEqual({ id: "zai", status: "failed", detail: "install/upgrade failed (1.0s)" });
  });

  test("skip records the reason, e.g. a deduped shared installer", () => {
    const next = applyUpgradeEvent(rows(), { type: "skip", id: "ali", detail: "shares installer with zai" });
    expect(next[2]).toEqual({ id: "ali", status: "skipped", detail: "shares installer with zai" });
  });

  test("is pure: the input array is never mutated and unknown ids are ignored", () => {
    const before = rows();
    const next = applyUpgradeEvent(before, { type: "start", id: "zai" });
    expect(before.every((row) => row.status === "pending")).toBe(true);
    expect(before).not.toBe(next);
    expect(applyUpgradeEvent(before, { type: "start", id: "nonexistent" })).toEqual(before);
  });

  test("a restart clears the previous detail", () => {
    let next = applyUpgradeEvent(rows(), { type: "finish", id: "claude", ok: true, detail: "4.3.0 (1.0s)" });
    next = applyUpgradeEvent(next, { type: "start", id: "claude" });
    expect(next[0]).toEqual({ id: "claude", status: "running", detail: undefined });
  });
});

describe("formatUpgradeRow", () => {
  // bun test runs with stdout detached from any TTY, so colors.ts's own
  // detection renders these helpers plain; assert the visible text only.
  test("renders one stable line per row state", () => {
    const width = 6;
    expect(formatUpgradeRow({ id: "claude", status: "pending" }, width, "⠙")).toBe("claude  pending");
    expect(formatUpgradeRow({ id: "claude", status: "running" }, width, "⠙")).toBe("claude  ⠙ installing…");
    expect(formatUpgradeRow({ id: "claude", status: "done", detail: "4.3.0 (1.0s)" }, width, "⠙")).toBe(
      "claude  ✔ 4.3.0 (1.0s)",
    );
    expect(formatUpgradeRow({ id: "claude", status: "failed", detail: "boom" }, width, "⠙")).toBe("claude  ✘ boom");
    expect(formatUpgradeRow({ id: "claude", status: "skipped", detail: "no shim" }, width, "⠙")).toBe(
      "claude  - no shim",
    );
  });
});

describe("formatUpgradeFrame", () => {
  test("pads names to the widest tool and keeps plan order", () => {
    const frame = formatUpgradeFrame(
      [
        { id: "claude", status: "running" },
        { id: "zai", status: "pending" },
      ],
      "⠹",
    );
    expect(frame.split("\n")).toEqual(["claude  ⠹ installing…", "zai     pending"]);
  });
});
