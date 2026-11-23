import { describe, expect, test } from "bun:test";
import { MAX_CHAT_TEXT } from "../../../src/browser/chat-protocol.ts";
import { createComposer } from "../src/sidepanel/chat/composer.ts";
import { asDoc, fakeDoc, walk } from "./fake-dom.ts";
import type { FakeNode } from "./fake-dom.ts";

const setup = (accept = true) => {
  const doc = fakeDoc();
  const sent: string[] = [];
  let stops = 0;
  const c = createComposer(asDoc(doc), { onSend: async t => { sent.push(t); return accept; }, onStop: () => { stops++; } });
  const box = c.box as unknown as FakeNode;
  const send = c.send as unknown as FakeNode;
  const stop = c.stop as unknown as FakeNode;
  return { c, box, send, stop, sent, stops: () => stops, root: c.root as unknown as FakeNode, flush: () => new Promise(r => setTimeout(r, 0)) };
};

describe("composer", () => {
  test("one card: the message box on top, then a bottom row with the tools on the left and Send on the right", () => {
    const s = setup();
    const card = walk(s.root).find(n => n.className === "composer-card")!;
    expect(card.children.map(n => n.className)).toEqual(["composer-box", "composer-bar"]);
    expect(card.children[1]!.children.map(n => n.className)).toEqual(["composer-tools", "composer-send idle", "composer-stop"]);
    expect(s.box.maxLength).toBe(MAX_CHAT_TEXT);
  });
  test("Send is an icon button with a name; Stop is a pill with its text", () => {
    const s = setup();
    expect(s.send.attrs["aria-label"]).toBe("Send");
    expect(s.send.textContent).toBe("");
    expect(walk(s.send).some(n => n.tag === "svg")).toBe(true);
    expect(s.stop.textContent).toBe("Stop");
    expect(walk(s.stop).some(n => n.tag === "svg")).toBe(true);
  });
  test("a running turn shows Stop in place of Send", () => {
    const s = setup();
    s.c.update({ send: true, stop: false });
    expect([s.send.hidden, s.stop.hidden, s.send.disabled]).toEqual([false, true, false]);
    s.c.update({ send: false, stop: true });
    expect([s.send.hidden, s.stop.hidden]).toEqual([true, false]);
    s.stop.click();
    expect(s.stops()).toBe(1);
  });
  test("Send is disabled when the mode does not allow it, and dim while the box is empty", () => {
    const s = setup();
    s.c.update({ send: false, stop: false });
    expect(s.send.disabled).toBe(true);
    s.c.update({ send: true, stop: false });
    expect(s.send.className).toBe("composer-send idle");
    s.box.value = "hi";
    s.box.dispatch("input");
    expect(s.send.className).toBe("composer-send");
  });
  test("Enter and the Send button send the trimmed draft, Shift+Enter and an empty box do not", async () => {
    const s = setup();
    s.c.update({ send: true, stop: false });
    s.box.value = "  hello  ";
    s.box.dispatch("keydown", { key: "Enter", shiftKey: true });
    s.box.dispatch("keydown", { key: "Enter" });
    await s.flush();
    expect(s.sent).toEqual(["hello"]);
    expect(s.box.value).toBe("");
    expect(s.send.className).toBe("composer-send idle");
    s.send.click();
    await s.flush();
    expect(s.sent).toEqual(["hello"]);
    s.box.value = "again";
    s.send.click();
    await s.flush();
    expect(s.sent).toEqual(["hello", "again"]);
  });
  test("the draft stays when the send is refused, and when the mode forbids it", async () => {
    const s = setup(false);
    s.box.value = "keep me";
    s.box.dispatch("keydown", { key: "Enter" });
    await s.flush();
    expect(s.sent).toEqual([]);
    s.c.update({ send: true, stop: false });
    s.box.dispatch("keydown", { key: "Enter" });
    await s.flush();
    expect(s.sent).toEqual(["keep me"]);
    expect(s.box.value).toBe("keep me");
  });
  test("the hint shows only when there is one", () => {
    const s = setup();
    const hint = walk(s.root).find(n => n.className === "hint composer-hint")!;
    s.c.update({ send: true, stop: false, hint: "Paused" });
    expect([hint.textContent, hint.hidden]).toEqual(["Paused", false]);
    s.c.update({ send: true, stop: false });
    expect(hint.hidden).toBe(true);
  });
});
