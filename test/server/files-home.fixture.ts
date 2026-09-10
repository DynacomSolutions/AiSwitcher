/** Run by test/server/files.test.ts as a subprocess with HOME pointed at a
 * fresh temp dir: Bun caches os.homedir() at process start, so the
 * "~"-display contract (listRoots()/tree() emit "~/..." paths the client
 * sends back verbatim) is only exercisable end-to-end when HOME is set
 * before the process boots. Exits 0 after asserting the exact flow the
 * user reported: select the ais root, list "~/.ais", open and save a file
 * by its "~"-display path, and confirm escapes are still rejected. The
 * runner owns creating and removing the temp home. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";

const home = process.env.HOME;
if (!home) throw new Error("HOME must point at the temp home the test runner created");

const base = join(home, ".ais");
const skills = join(base, "skills");
await mkdir(skills, { recursive: true });
await writeFile(join(skills, "demo.md"), "# demo");

const registryDir = join(home, ".claude");
await mkdir(registryDir, { recursive: true });
await writeFile(
  join(registryDir, "identities.json"),
  JSON.stringify({ version: 1, identities: [{ name: "test", label: "Test", configDir: base }] }),
);

const configs: ToolConfig[] = [
  {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    identitiesJsonPath: join(registryDir, "identities.json"),
    identitiesRootDir: join(registryDir, "identities"),
    globalMemoryProjection: "claude-append-file",
  },
];

const { listRoots, tree, readTextFile, writeTextFile } = await import("../../src/server/files.ts");

const roots = await listRoots(configs);
const aisRoot = roots.find((r) => r.root === "ais");
if (!aisRoot || aisRoot.path !== "~/.ais") {
  throw new Error(`ais root display path expected "~/.ais", got ${aisRoot?.path}`);
}

const top = await tree("ais", "~/.ais", configs);
if (!top.entries.some((e) => e.name === "skills")) throw new Error("tree ~/.ais is missing the skills entry");

const nested = await tree("ais", "~/.ais/skills", configs);
if (!nested.entries.some((e) => e.name === "demo.md")) throw new Error("tree ~/.ais/skills is missing demo.md");

const read = await readTextFile("ais", "~/.ais/skills/demo.md", configs);
if (read.content !== "# demo") throw new Error(`unexpected file content: ${read.content}`);

const written = await writeTextFile("ais", "~/.ais/skills/demo.md", "updated", configs);
if (!written.ok) throw new Error("writeTextFile did not report ok");
const reread = await readTextFile("ais", "~/.ais/skills/demo.md", configs);
if (reread.content !== "updated") throw new Error(`round-trip content mismatch: ${reread.content}`);

let rejected = false;
try {
  await readTextFile("ais", "~/../../etc/passwd", configs);
} catch (err) {
  rejected = String(err).includes("escapes");
}
if (!rejected) throw new Error("a ~ path escaping the root was not rejected");

console.log("fixture-ok");
