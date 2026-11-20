import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { bunListenConn, SharedListener, type ListenConn, type OpenListenConn } from "../../src/gateway/pg-listen.ts";

/** A fake LISTEN connection factory. `opened` lists every connection made, in order. */
function fakeOpener(opts: { failOpens?: number } = {}) {
  const opened: Array<{
    listening: Set<string>;
    closed: boolean;
    notify: (channel: string, payload: string) => void;
    drop: () => void;
  }> = [];
  let failOpens = opts.failOpens ?? 0;
  const open: OpenListenConn = async (onNotify, onClose) => {
    if (failOpens > 0) {
      failOpens -= 1;
      throw new Error("connection refused");
    }
    const rec = { listening: new Set<string>(), closed: false, notify: onNotify, drop: onClose };
    opened.push(rec);
    const conn: ListenConn = {
      listen: async (channel) => void rec.listening.add(channel),
      unlisten: async (channel) => void rec.listening.delete(channel),
      close: async () => void (rec.closed = true),
    };
    return conn;
  };
  return { open, opened };
}

const quiet = (): void => undefined;

describe("SharedListener", () => {
  test("many channels share one connection and notices go to the right subscribers", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet);
    const files: string[] = [];
    const apps: string[] = [];
    const browser: string[] = [];
    await l.listen("ais_gateway_files", (p) => files.push(p));
    await l.listen("gateway_apps_changed", (p) => apps.push(p));
    await l.listen("ais_gateway_browser", (p) => browser.push(p));
    expect(opened).toHaveLength(1);
    expect([...opened[0]!.listening].sort()).toEqual(["ais_gateway_browser", "ais_gateway_files", "gateway_apps_changed"]);
    opened[0]!.notify("gateway_apps_changed", "a1");
    opened[0]!.notify("ais_gateway_files", "f1");
    opened[0]!.notify("other", "x");
    expect({ files, apps, browser }).toEqual({ files: ["f1"], apps: ["a1"], browser: [] });
    await l.close();
  });

  test("two subscribers on one channel both get the notice, and unlisten stops only its own", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet);
    const a: string[] = [];
    const b: string[] = [];
    const offA = await l.listen("c", (p) => a.push(p));
    await l.listen("c", (p) => b.push(p));
    opened[0]!.notify("c", "1");
    await offA();
    await offA(); // a second call changes nothing
    opened[0]!.notify("c", "2");
    expect(a).toEqual(["1"]);
    expect(b).toEqual(["1", "2"]);
    expect(opened[0]!.listening.has("c")).toBe(true);
    await l.close();
  });

  test("the last unlisten on a channel stops listening on it", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet);
    const off = await l.listen("c", () => undefined);
    await off();
    expect(opened[0]!.listening.has("c")).toBe(false);
    expect(l.channels).toBe(0);
    await l.close();
  });

  test("a dropped connection is reopened and every channel is listened on again", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet, 5);
    const files: string[] = [];
    const apps: string[] = [];
    await l.listen("files", (p) => files.push(p));
    await l.listen("apps", (p) => apps.push(p));
    opened[0]!.drop();
    await Bun.sleep(60);
    expect(opened).toHaveLength(2);
    expect([...opened[1]!.listening].sort()).toEqual(["apps", "files"]);
    opened[1]!.notify("apps", "after");
    // A late notice from the dead connection is ignored.
    opened[0]!.notify("files", "stale");
    expect(apps).toEqual(["after"]);
    expect(files).toEqual([]);
    await l.close();
  });

  test("reopening retries while the database is unreachable", async () => {
    const { open, opened } = fakeOpener();
    let refuse = 0;
    const flaky: OpenListenConn = async (n, c) => {
      if (refuse > 0) {
        refuse -= 1;
        throw new Error("down");
      }
      return open(n, c);
    };
    const l = new SharedListener(flaky, quiet, 5);
    await l.listen("c", () => undefined);
    refuse = 2;
    opened[0]!.drop();
    await Bun.sleep(120);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.listening.has("c")).toBe(true);
    await l.close();
  });

  test("an explicit reconnect reopens a dropped connection and is cheap when it is up", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet, 60_000);
    await l.listen("c", () => undefined);
    await l.reconnect();
    expect(opened).toHaveLength(1);
    opened[0]!.drop();
    await l.reconnect();
    expect(opened).toHaveLength(2);
    expect(opened[1]!.listening.has("c")).toBe(true);
    await l.close();
  });

  test("a failing first listen throws and leaves no subscriber behind", async () => {
    const { opened } = fakeOpener();
    const open: OpenListenConn = async () => ({
      listen: async () => {
        throw new Error("no LISTEN");
      },
      unlisten: async () => undefined,
      close: async () => void opened.push({ listening: new Set(), closed: true, notify: () => undefined, drop: () => undefined }),
    });
    const l = new SharedListener(open, quiet);
    await expect(l.listen("c", () => undefined)).rejects.toThrow();
    expect(l.channels).toBe(0);
  });

  test("a throwing subscriber does not stop the others", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet);
    const seen: string[] = [];
    await l.listen("c", () => {
      throw new Error("boom");
    });
    await l.listen("c", (p) => seen.push(p));
    opened[0]!.notify("c", "x");
    expect(seen).toEqual(["x"]);
    await l.close();
  });

  test("close ends the connection and later listens fail", async () => {
    const { open, opened } = fakeOpener();
    const l = new SharedListener(open, quiet);
    await l.listen("c", () => undefined);
    await l.close();
    expect(opened[0]!.closed).toBe(true);
    await expect(l.listen("c", () => undefined)).rejects.toThrow("closed");
  });
});

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;

describe.skipIf(!url)("the Bun LISTEN connection", () => {
  test("three channels use one server connection and notices arrive by channel", async () => {
    const admin = new SQL(url as string, { max: 1 });
    const listener = new SharedListener(bunListenConn(url as string), quiet);
    try {
      const seen: string[] = [];
      for (const ch of ["pgl_test_a", "pgl_test_b", "pgl_test_c"]) await listener.listen(ch, (p) => seen.push(`${ch}:${p}`));
      const rows = await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'LISTEN "pgl_test_%' AND pid <> pg_backend_pid()`;
      expect(rows[0].n).toBe(1);
      await admin`SELECT pg_notify('pgl_test_b', '2')`;
      await admin`SELECT pg_notify('pgl_test_a', '1')`;
      for (let i = 0; i < 50 && seen.length < 2; i += 1) await Bun.sleep(50);
      expect(seen.sort()).toEqual(["pgl_test_a:1", "pgl_test_b:2"]);
    } finally {
      await listener.close();
      await admin.close();
    }
  });
});
