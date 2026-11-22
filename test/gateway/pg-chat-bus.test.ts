import { expect, test } from "bun:test";
import { SQL } from "bun";
import { CHAT_CHANNEL, MAX_BUS_PAYLOAD, PgChatBus, parseBusMsg, type ChatBusMsg } from "../../src/gateway/chat/bus.ts";
import { bunListenConn, SharedListener } from "../../src/gateway/pg-listen.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

test("parseBusMsg accepts the four message kinds and refuses anything else", () => {
  expect(parseBusMsg('{"t":"event","chatId":"c","seq":3}')).toEqual({ t: "event", chatId: "c", seq: 3 });
  expect(parseBusMsg('{"t":"cmd","to":"r","chatId":"c","cmd":"prompt","seq":2}')).toEqual({ t: "cmd", to: "r", chatId: "c", cmd: "prompt", seq: 2 });
  expect(parseBusMsg('{"t":"cmd","to":"r","chatId":"c","cmd":"rm -rf"}')).toBeUndefined();
  expect(parseBusMsg('{"t":"event","chatId":"c"}')).toBeUndefined();
  expect(parseBusMsg("not json")).toBeUndefined();
});

if (!url && process.env.CI && !optOut) {
  test("pg chat bus tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("pg chat bus tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  test("pg_notify payload for an event stays under 7 KB and delivers across two connections", async () => {
    const quiet = (): void => undefined;
    const sender = new SQL(url, { max: 1 });
    const listener = new SharedListener(bunListenConn(url), quiet);
    try {
      const bus = new PgChatBus(sender, listener);
      const got: ChatBusMsg[] = [];
      const off = await bus.subscribe((m) => got.push(m));
      const event: ChatBusMsg = { t: "event", chatId: crypto.randomUUID(), seq: 41 };
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(MAX_BUS_PAYLOAD);
      await bus.publish(event);
      await bus.publish({ t: "cmd", to: "replica-b", chatId: event.chatId, cmd: "prompt", seq: 42 });
      for (let i = 0; i < 100 && got.length < 2; i += 1) await Bun.sleep(50);
      expect(got).toEqual([event, { t: "cmd", to: "replica-b", chatId: event.chatId, cmd: "prompt", seq: 42 }]);
      await expect(bus.publish({ t: "cmd", to: "r", chatId: "c", cmd: "configure", args: { name: "x".repeat(MAX_BUS_PAYLOAD) } })).rejects.toThrow("too large");
      await off();
      expect(CHAT_CHANNEL).toBe("ais_gateway_chat");
    } finally {
      await listener.close();
      await sender.close();
    }
  });
}
