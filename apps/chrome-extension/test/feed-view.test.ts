import { describe, expect, test } from "bun:test";
import type { FeedItem } from "../src/sidepanel/chat/feed.ts";
import { parseCached } from "../src/sidepanel/chat/feed-view.ts";
import { renderFeed } from "../src/sidepanel/chat/feed-view.ts";
import { asDoc, asEl, fakeDoc, walk, type FakeNode } from "./fake-dom.ts";

const setup = () => {
  const doc = fakeDoc();
  const root = doc.createElement("div");
  const calls: Array<[string, string | undefined]> = [];
  const opts = { expanded: new Set<string>(), onPermission: (r: string, o?: string) => void calls.push([r, o]) };
  const render = (feed: FeedItem[]): void => renderFeed(asDoc(doc), asEl(root), feed, opts);
  return { doc, root, opts, render, calls };
};
const perm = (resolved?: { optionId?: string; cancelled?: boolean }): FeedItem => ({ kind: "permission", seq: 2, requestId: "r", title: "Run it?", options: [{ id: "a", name: "Allow", kind: "allow_once" }, { id: "d", name: "Deny", kind: "reject_once" }], ...(resolved ? { resolved } : {}) });
const tool = (result: string, status: "running" | "done" = "done"): FeedItem => ({ kind: "tool", seq: 1, toolCallId: "t", title: "Read", status, result });
const find = (root: FakeNode, tag: string, text: string): FakeNode => walk(root).find((n) => n.tag === tag && n.textContent === text)!;

describe("renderFeed", () => {
  test("the feed container is a polite log that announces additions only", () => {
    const s = setup();
    s.render([]);
    expect(s.root.attrs).toMatchObject({ role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  });
  test("a streaming message is aria-busy until it ends", () => {
    const s = setup();
    s.render([{ kind: "assistant", seq: 1, text: "a", streaming: true }]);
    const node = s.root.children[0]!;
    expect(node.attrs["aria-busy"]).toBe("true");
    s.render([{ kind: "assistant", seq: 1, text: "ab", streaming: false }]);
    expect(s.root.children[0]).toBe(node);
    expect(node.attrs["aria-busy"]).toBeUndefined();
    expect(node.textContent).toBe("ab");
  });
  test("a focused Show more button stays the active element across an update", () => {
    const s = setup();
    const long = "x".repeat(1000);
    s.render([tool(long, "running")]);
    const more = find(s.root, "button", "Show more");
    more.focus();
    more.click();
    expect(s.doc.activeElement).toBe(more);
    expect(find(s.root, "button", "Show less")).toBe(more);
    s.render([tool(long, "done")]);
    expect(s.doc.activeElement).toBe(more);
    expect(more.parent).toBeDefined();
    expect(s.root.children).toHaveLength(1);
  });
  test("a focused permission button stays while other items are added", () => {
    const s = setup();
    s.render([perm()]);
    const allow = find(s.root, "button", "Allow");
    allow.focus();
    s.render([{ kind: "user", seq: 0, text: "hi" }, perm(), { kind: "notice", seq: 3, text: "n" }]);
    expect(s.doc.activeElement).toBe(allow);
    expect(s.root.children.map((c) => c.attrs && c.className)).toEqual(["msg user", "msg permission", "msg notice"]);
    allow.click();
    expect(s.calls).toEqual([["r", "a"]]);
    expect(allow.className).toBe("primary");
    expect(find(s.root, "button", "Deny").className).toBe("secondary");
  });
  test("a resolved permission shows the chosen option and removes the buttons", () => {
    const s = setup();
    s.render([perm()]);
    s.render([perm({ optionId: "d" })]);
    expect(walk(s.root).some((n) => n.tag === "button")).toBe(false);
    expect(s.root.textContent).toContain("Deny");
  });
  test("removed items leave the feed", () => {
    const s = setup();
    s.render([{ kind: "notice", seq: 1, text: "a" }, { kind: "notice", seq: 2, text: "b" }]);
    s.render([{ kind: "notice", seq: 2, text: "b" }]);
    expect(s.root.children).toHaveLength(1);
  });
  test("parseCached returns the same blocks for the same text", () => {
    expect(parseCached("hello **x**")).toBe(parseCached("hello **x**"));
  });
  test("hostile tool, permission and error text becomes text nodes only", () => {
    const s = setup();
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>[x](javascript:alert(1))';
    s.render([
      { kind: "tool", seq: 1, toolCallId: "t", title: evil, status: "done", args: evil, result: evil },
      { kind: "permission", seq: 2, requestId: "r", title: evil, options: [{ id: "a", name: evil, kind: "allow_once" }] },
      { kind: "error", seq: 3, code: "acp", message: evil },
      { kind: "notice", seq: 4, text: evil },
      { kind: "user", seq: 5, text: evil },
      { kind: "assistant", seq: 6, text: evil, streaming: false },
    ]);
    const tags = new Set(walk(s.root).map((n) => n.tag));
    for (const bad of ["script", "img", "a", "iframe"]) expect(tags.has(bad)).toBe(false);
    expect(walk(s.root).some((n) => "href" in n.attrs || "src" in n.attrs || Object.keys(n.attrs).some((k) => k.startsWith("on")))).toBe(false);
  });
});
