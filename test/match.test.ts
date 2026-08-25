import { describe, expect, test } from "bun:test";
import { matchDirectory, parseDirectoryPattern } from "../src/identities/match.ts";
import type { Identity } from "../src/identities/types.ts";

function identity(name: string, directories: string[]): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}`, directories };
}

describe("parseDirectoryPattern", () => {
  test("no wildcard -> exact", () => {
    const parsed = parseDirectoryPattern("/tmp/does-not-exist/foo", "ctx");
    expect(parsed.kind).toBe("exact");
  });

  test("trailing /* -> recursive", () => {
    const parsed = parseDirectoryPattern("/tmp/does-not-exist/foo/*", "ctx");
    expect(parsed.kind).toBe("recursive");
    expect(parsed.base).toBe("/tmp/does-not-exist/foo");
  });

  test("wildcard mid-segment is rejected", () => {
    expect(() => parseDirectoryPattern("/tmp/does-not-exist/fo*o", "ctx")).toThrow();
  });

  test("wildcard not as a whole trailing segment is rejected", () => {
    expect(() => parseDirectoryPattern("/tmp/does-not-exist/foo*", "ctx")).toThrow();
  });
});

describe("matchDirectory", () => {
  test("exact pattern matches only that exact directory, not subdirectories", () => {
    const a = identity("a", ["/tmp/does-not-exist/foo"]);
    expect(matchDirectory("/tmp/does-not-exist/foo", [a])).toMatchObject({ identity: a });
    expect(matchDirectory("/tmp/does-not-exist/foo/bar", [a])).toBeNull();
  });

  test("recursive pattern matches the directory itself and everything beneath it", () => {
    const a = identity("a", ["/tmp/does-not-exist/foo/*"]);
    expect(matchDirectory("/tmp/does-not-exist/foo", [a])).toMatchObject({ identity: a });
    expect(matchDirectory("/tmp/does-not-exist/foo/bar/baz", [a])).toMatchObject({ identity: a });
    expect(matchDirectory("/tmp/does-not-exist/foo-other", [a])).toBeNull();
  });

  test("no match returns null", () => {
    const a = identity("a", ["/tmp/does-not-exist/foo"]);
    expect(matchDirectory("/tmp/does-not-exist/somewhere-else", [a])).toBeNull();
  });

  test("exact match outranks a recursive match anchored at the same directory", () => {
    const recursive = identity("recursive-owner", ["/tmp/does-not-exist/foo/*"]);
    const exact = identity("exact-owner", ["/tmp/does-not-exist/foo/bar"]);
    const result = matchDirectory("/tmp/does-not-exist/foo/bar", [recursive, exact]);
    expect(result).toMatchObject({ identity: exact });
  });

  test("most specific (longest) recursive pattern wins among nested matches", () => {
    const shallow = identity("shallow", ["/tmp/does-not-exist/foo/*"]);
    const deep = identity("deep", ["/tmp/does-not-exist/foo/bar/*"]);
    const result = matchDirectory("/tmp/does-not-exist/foo/bar/baz", [shallow, deep]);
    expect(result).toMatchObject({ identity: deep });
  });

  test("true tie between two different identities is reported as ambiguous", () => {
    const a = identity("a", ["/tmp/does-not-exist/foo/*"]);
    const b = identity("b", ["/tmp/does-not-exist/foo/*"]);
    const result = matchDirectory("/tmp/does-not-exist/foo/bar", [a, b]);
    expect(result).toMatchObject({ ambiguous: true });
    if (result && "ambiguous" in result) {
      expect(result.candidates.map((c) => c.name).sort()).toEqual(["a", "b"]);
    }
  });

  test("multiple patterns tying on the same identity is not ambiguous", () => {
    const a = identity("a", ["/tmp/does-not-exist/foo/*", "/tmp/does-not-exist/foo/bar/*"]);
    // both patterns match, but they belong to the same identity — the
    // longest naturally wins without needing the ambiguity fallback.
    const result = matchDirectory("/tmp/does-not-exist/foo/bar/baz", [a]);
    expect(result).toMatchObject({ identity: a });
  });
});
