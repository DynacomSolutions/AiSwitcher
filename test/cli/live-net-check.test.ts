import { afterEach, describe, expect, it } from "bun:test";
import { runLiveCommand } from "../../src/cli/live/dispatch.ts";

describe("ais live net-check", () => {
  afterEach(() => { process.exitCode = 0; });

  it("prints the machine-readable online and local model contract", async () => {
    const lines: string[] = [];
    let refresh = false;
    await runLiveCommand(["net-check"], { json: true, fresh: true }, {
      online: async (fresh) => (refresh = fresh, true),
      discover: async () => [{ name: "synthetic-model", path: "/synthetic/model.gguf", sizeBytes: 1 }],
      runner: () => "/synthetic/llama-cli",
      write: (line) => lines.push(line),
    });
    expect(refresh).toBe(true);
    expect(lines).toEqual(['{"online":true,"localModel":true}']);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("returns status 1 when offline and reports unavailable local models", async () => {
    const lines: string[] = [];
    await runLiveCommand(["net-check"], { json: true }, {
      online: async () => false,
      discover: async () => [],
      runner: () => undefined,
      write: (line) => lines.push(line),
    });
    expect(lines).toEqual(['{"online":false,"localModel":false}']);
    expect(process.exitCode).toBe(1);
  });

  it("reports a model only when both a runner and a discovered model exist", async () => {
    const lines: string[] = [];
    await runLiveCommand(["net-check"], { json: true }, {
      online: async () => true,
      discover: async () => [{ name: "synthetic-model", path: "/synthetic/model.gguf", sizeBytes: 1 }],
      runner: () => undefined,
      write: (line) => lines.push(line),
    });
    expect(lines).toEqual(['{"online":true,"localModel":false}']);

    lines.length = 0;
    await runLiveCommand(["net-check"], { json: true }, {
      online: async () => false,
      discover: async () => [{ name: "synthetic-model", path: "/synthetic/model.gguf", sizeBytes: 1 }],
      runner: () => "/synthetic/llama-cli",
      write: (line) => lines.push(line),
    });
    expect(lines).toEqual(['{"online":false,"localModel":true}']);
    expect(process.exitCode).toBe(1);
  });
});
