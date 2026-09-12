import { runWrapper } from "./shared/run-wrapper.ts";
import { PI_CONFIG } from "./identities/tool-configs.ts";
import { installPiExtension } from "./identities/pi-extension-install.ts";
import { reconcilePiConfigDirOnLaunch } from "./identities/oauth-reconcile.ts";

// Self-heal: make sure this identity's Pi configDir carries the current AIS
// identity extension (status line + /ais) and that its imported OAuth
// credential copies agree with the native stores (one credential per
// (identity, provider) - src/identities/oauth-reconcile.ts). Neither step
// throws or blocks the launch.
await runWrapper(PI_CONFIG, "Pi", async (configDir) => {
  await installPiExtension(configDir);
  await reconcilePiConfigDirOnLaunch(configDir);
});
