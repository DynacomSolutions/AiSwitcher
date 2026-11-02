import { parseToken } from "./tokens.ts";

function basicPassword(value: string, app: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0 || decoded.slice(0, sep) !== app) return undefined;
    return decoded.slice(sep + 1);
  } catch {
    return undefined;
  }
}

/**
 * The gateway token from the request headers: Bearer, x-api-key, api-key or
 * Basic (`<app>:<token>`). Never read from the query string. Returns the first
 * candidate shaped like a gateway token, or undefined.
 */
export function extractToken(req: Request, app: string): string | undefined {
  const candidates: Array<string | undefined> = [];
  const auth = req.headers.get("authorization")?.trim();
  if (auth) {
    const m = /^(bearer|basic)\s+(\S+)$/i.exec(auth);
    if (m) candidates.push(m[1]!.toLowerCase() === "bearer" ? m[2] : basicPassword(m[2]!, app));
  }
  candidates.push(req.headers.get("x-api-key")?.trim(), req.headers.get("api-key")?.trim());
  return candidates.find((c): c is string => c !== undefined && parseToken(c) !== undefined);
}
