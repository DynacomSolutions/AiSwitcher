/** Random UUIDs keep 6 chars; human-chosen ids show up to 12. */
export function shortSessionId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 6) : id.slice(0, 12);
}
