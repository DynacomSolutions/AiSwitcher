import { createHash } from "node:crypto";
import { S3Client } from "bun";
import { Decrypter } from "age-encryption";
import type { SessionPartRow } from "./session-store.ts";
import type { SessionsEnrichConfig } from "./enrich-config.ts";

/** Why a part could not be read. The enrichment counts each kind and backs off from the file. */
export type PartErrorKind = "fetch" | "missing" | "decrypt" | "integrity" | "bad_key";

export class PartReadError extends Error {
  constructor(
    readonly kind: PartErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PartReadError";
  }
}

/** Where encrypted part objects come from. */
export interface PartSource {
  /** The stored bytes of one object. Throws `PartReadError` (`fetch`, `missing` or `bad_key`). */
  read(objectKey: string): Promise<Uint8Array>;
}

/** Bun S3 client against HoardDB object storage. It only reads (spike 0.2: Bun cannot send `If-None-Match`, and the console needs reads only). */
export class S3PartSource implements PartSource {
  private readonly client: S3Client;

  constructor(private readonly cfg: Pick<SessionsEnrichConfig, "endpoint" | "bucket" | "prefix" | "region" | "accessKeyId" | "secretAccessKey">) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
  }

  async read(objectKey: string): Promise<Uint8Array> {
    if (!objectKey || objectKey.includes("..") || objectKey.startsWith("/") || !objectKey.startsWith(this.cfg.prefix)) {
      throw new PartReadError("bad_key", "the object key is outside the configured prefix");
    }
    try {
      return await this.client.file(objectKey).bytes();
    } catch (err) {
      const code = String((err as { code?: unknown })?.code ?? "");
      if (code === "NoSuchKey" || code === "ERR_S3_NO_SUCH_KEY" || /no such key|not found/i.test(String((err as Error)?.message ?? ""))) {
        throw new PartReadError("missing", "the part object does not exist");
      }
      // The message of a storage error can name the endpoint: keep only the code.
      throw new PartReadError("fetch", `the part object could not be read${code ? ` (${code})` : ""}`);
    }
  }
}

/** Decrypts one part: age, then gunzip, then the checks against the part row. Returns the plain text of the byte range. */
export async function decodePart(stored: Uint8Array, part: SessionPartRow, identity: string): Promise<string> {
  let gz: Uint8Array;
  try {
    const d = new Decrypter();
    d.addIdentity(identity);
    gz = await d.decrypt(stored);
  } catch {
    throw new PartReadError("decrypt", "the part could not be decrypted");
  }
  let plain: Uint8Array;
  try {
    plain = Bun.gunzipSync(new Uint8Array(gz));
  } catch {
    throw new PartReadError("integrity", "the part is not valid gzip");
  }
  if (plain.byteLength !== part.plainBytes) throw new PartReadError("integrity", "the part has the wrong length");
  if (createHash("sha256").update(plain).digest("hex") !== part.plainSha256) throw new PartReadError("integrity", "the part hash differs from the index");
  return new TextDecoder().decode(plain);
}
