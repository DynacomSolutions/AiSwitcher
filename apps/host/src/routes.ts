export function contentRoute(id: string): string {
  return `/drives/${encodeURIComponent(id)}`;
}

export function filterRoute(pathname: string, key: string, value: string | null, currentSearch = ""): string {
  const query = new URLSearchParams(currentSearch);
  if (value === null || value === "") query.delete(key);
  else query.set(key, value);
  const encoded = query.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
}
