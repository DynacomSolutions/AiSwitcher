import { runWrapper } from "./shared/run-wrapper.ts";
import { PI_CONFIG } from "./identities/tool-configs.ts";
import { installPiExtension } from "./identities/pi-extension-install.ts";
import { reconcileAllPiIdentitiesOnLaunch } from "./identities/oauth-reconcile.ts";

// SINGLE-INSTANCE MODE (2026-09-13): pi launches ONE shared instance
// (PI_CONFIG.singleInstanceDir, Pi's own default home) and never prompts for
// an AIS identity. The self-heal-installed extension below reads the whole
// pi registry and exposes every identity's credentials as namespaced
// providers with an in-app switcher (/ais); identity auth.json files are
// resolved live per request, and OAuth refreshes are written back into the
// SOURCE identity's store, so all identities are reconciled here - not just
// whichever one a per-identity launch used to pin. Neither step throws or
// blocks the launch.
await runWrapper(PI_CONFIG, "Pi", async (configDir) => {
  await installPiExtension(configDir);
  await reconcileAllPiIdentitiesOnLaunch();
});
