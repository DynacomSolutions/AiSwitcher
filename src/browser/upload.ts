// Agent side of upload_file: the MCP shim reads the files on the machine the agent runs on and sends their content.
// The gateway and the extension only ever receive content; no path reaches the machine that runs Chrome.
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, type UploadFile } from "./tool-args.ts";

/** Reads the files an agent named for upload_file. Throws an Error whose message is ready for the agent. */
export async function readUploadFiles(paths: unknown): Promise<UploadFile[]> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || p === "")) throw new Error("paths must be a list of file paths");
  if (paths.length > MAX_UPLOAD_FILES) throw new Error(`paths allows at most ${MAX_UPLOAD_FILES} files`);
  const files = (paths as string[]).map((p) => resolve(p));
  let total = 0;
  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${file} is not a file on this machine`);
    total += info.size;
  }
  if (total > MAX_UPLOAD_BYTES) throw new Error(`files are ${total} bytes in total; the limit is ${MAX_UPLOAD_BYTES} bytes`);
  return Promise.all(files.map(async (file) => ({
    name: basename(file),
    // Bun names the type from the file extension; a parameter such as ";charset=utf-8" is dropped.
    mimeType: Bun.file(file).type.split(";")[0]!.trim() || "application/octet-stream",
    data: (await readFile(file)).toString("base64"),
  })));
}
