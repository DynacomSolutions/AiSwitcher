import { describe, expect, test } from "bun:test";
import { readInboxStdin } from "../../src/live/inbox.ts";

describe("live stdin contract", () => {
  test("reads only the supplied tar stream and never resolves an inbox path", async () => {
    const source = new Uint8Array([0, 1, 2, 3, 255]);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(source); controller.close(); } });
    expect(await readInboxStdin(stream)).toEqual(source);
  });

  test("rejects an oversized stdin stream before returning bytes", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1)); controller.close(); } });
    await expect(readInboxStdin(stream)).rejects.toThrow("size limit");
  });
});
