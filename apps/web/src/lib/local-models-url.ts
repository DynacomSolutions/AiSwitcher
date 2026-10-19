/** URL helpers for the Local Models page. Kept React-free so root `bun test` covers them. */

export function modelPath(name?: string): string {
  return name === undefined ? "/local-models" : `/local-models/${encodeURIComponent(name)}`;
}

export function readFilter(params: URLSearchParams): string {
  return params.get("q") ?? "";
}

export function withFilter(params: URLSearchParams, q: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (q.length > 0) next.set("q", q);
  else next.delete("q");
  return next;
}
