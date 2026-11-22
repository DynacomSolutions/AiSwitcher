import { describe, expect, test } from "bun:test";
import { CHAT_PALETTE, nextChatColour } from "../src/shared/chat-palette.ts";

describe("chat palette", () => {
  test("nextChatColour returns the lowest free colour and reuses a closed chat's colour", () => {
    expect(CHAT_PALETTE).toHaveLength(6);
    expect(nextChatColour([])).toBe(CHAT_PALETTE[0]!.hex);
    expect(nextChatColour([CHAT_PALETTE[0]!.hex, CHAT_PALETTE[2]!.hex])).toBe(CHAT_PALETTE[1]!.hex);
    expect(nextChatColour([CHAT_PALETTE[0]!.hex, CHAT_PALETTE[1]!.hex, CHAT_PALETTE[2]!.hex].slice(1))).toBe(CHAT_PALETTE[0]!.hex);
  });
  test("nextChatColour returns undefined with six used", () => {
    expect(nextChatColour(CHAT_PALETTE.map(p => p.hex))).toBeUndefined();
  });
});
