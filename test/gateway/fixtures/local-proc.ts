// A real `ais gateway local` process for the handoff test: same server and drain handlers, own port, loopback upstream allowed.
import { installDrainHandlers, startLocalGateway } from "../../../src/gateway/local.ts";

const running = await startLocalGateway({
  port: Number(process.env.TEST_PORT),
  remoteBase: process.env.TEST_REMOTE,
  allowLoopbackRemote: true,
  instance: process.env.TEST_INSTANCE,
  clientToken: async () => process.env.TEST_KEY,
  members: async () => [],
  log: () => {},
  bindRetryMs: 5_000,
});
installDrainHandlers(running);
console.log("listening");
await new Promise<void>(() => {});
