import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { readClaudeTranscript } from "../../src/cli/sessions/claude.ts";
import { readSessionTrees } from "../../src/cli/sessions/tree.ts";
import type { Identity } from "../../src/identities/types.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import { partObjectPrefix, SessionStore } from "../../src/gateway/sessions/session-store.ts";
import { SessionsDbSource } from "../../src/server/sessions-db/db-source.ts";
import { SessionsReaderMetrics } from "../../src/server/sessions-db/metrics.ts";
import { PartCache } from "../../src/server/sessions-db/part-cache.ts";
import { PartLoader } from "../../src/server/sessions-db/part-lines.ts";
import { FakeObjects, makeKeys, sha, storeParts, wholePass } from "../gateway/sessions-enrich-kit.ts";
import { claudeSession, cleanTemps, msAt, tempDir } from "./sessions-db-kit.ts";

/** The console reader against the real SessionStore on Postgres (the view, the tail window query), with a fake object store. */

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("console sessions reader database tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP console sessions reader database tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("console sessions reader database tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  const SID = "11111111-2222-4333-8444-555555555555";
  const REL = `projects/-srv-example/${SID}.jsonl`;
  const admin = new SQL(url);
  const stores: SessionStore[] = [];
  beforeEach(async () => {
    await migrate(url);
    await admin`TRUNCATE ais_session_file RESTART IDENTITY CASCADE`;
  });
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
    await cleanTemps();
  });
  afterAll(async () => {
    await admin.close();
  });

  describe("console reader on Postgres", () => {
    test("tree and transcript equal the file reader for a multi-part session", async () => {
      const store = new SessionStore(url, { poolMax: 3 });
      stores.push(store);
      const keys = await makeKeys();
      const objects = new FakeObjects();
      const lines = claudeSession("pg", 12);
      const parts = await storeParts(objects, keys.recipient, "f1", lines, 3, 0, 0, partObjectPrefix("claude", SID, 0));
      const res = await store.ingest({ node: "node-a", root: "/data/pool", relPath: REL, generation: 0, kind: "claude", origin: "pool-folder", sessionRef: SID, headSha256: sha("head"), mtimeMs: msAt(11), parts });
      expect(res.status).toBe("committed");
      const whole = wholePass("claude", REL, lines);
      const c = (await store.enrichQueue(1))[0]!;
      expect(await store.applyEnrichment({ fileId: c.fileId, expectedIndexedBytes: 0, fields: whole.fields, state: whole.state })).toBe(true);
      await admin`UPDATE ais_session_file SET identity = 'testa'`;

      const configDir = await tempDir();
      const { mkdir, writeFile, utimes } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");
      const path = join(configDir, REL);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, lines.map((l) => `${l}\n`).join(""));
      await utimes(path, new Date(msAt(9)), new Date(msAt(9)));
      const identity = { name: "testa", configDir } as Identity;

      const metrics = new SessionsReaderMetrics();
      const loader = new PartLoader({ source: objects, identity: keys.identity, cache: new PartCache(1 << 20), metrics });
      const db = new SessionsDbSource({ store, loader, metrics, windowBytes: 4 * 1024 * 1024 });

      const slices = await db.readTrees({ kinds: ["claude"], targets: [{ tool: "claude", identity: "testa" }], opts: { days: 400 } });
      const files = await readSessionTrees("claude", identity, { days: 400 });
      expect(slices[0]!.nodes).toEqual(files.nodes);

      const dto = (await db.readTranscript({ tool: "claude", identity: "testa", id: SID }))!;
      expect(dto).toEqual((await readClaudeTranscript(identity, SID))!);
      // A small window reads only the last parts and says truncated.
      const small = new SessionsDbSource({ store, loader, metrics, windowBytes: 200 });
      const tail = (await small.readTranscript({ tool: "claude", identity: "testa", id: SID }))!;
      expect(tail.truncated).toBe(true);
      expect(tail.turns.at(-1)!.text).toContain("Answer 11");
    });
  });
}
