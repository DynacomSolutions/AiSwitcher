/**
 * A size-capped LRU of decoded parts (plain text). A part is immutable and checked against its stored hash before it
 * goes in, so a hit is as good as a fetch. The size is the plain byte count of the part, which tracks the memory of the
 * string closely for JSONL. A part larger than the cap is never kept. Cap 0 keeps nothing.
 */
export class PartCache {
  private readonly map = new Map<string, { text: string; bytes: number }>();
  private used = 0;

  constructor(private readonly capBytes: number) {}

  get size(): number {
    return this.used;
  }

  get entries(): number {
    return this.map.size;
  }

  get(key: string): string | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    // Most recent last: a Map keeps insertion order.
    this.map.delete(key);
    this.map.set(key, e);
    return e.text;
  }

  set(key: string, text: string, bytes: number): void {
    if (this.capBytes <= 0 || bytes > this.capBytes) return;
    const old = this.map.get(key);
    if (old) {
      this.used -= old.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { text, bytes });
    this.used += bytes;
    for (const [k, e] of this.map) {
      if (this.used <= this.capBytes) break;
      this.map.delete(k);
      this.used -= e.bytes;
    }
  }
}
