import { runWrapper } from "./shared/run-wrapper.ts";
import { PI_CONFIG } from "./identities/tool-configs.ts";
import { installPiExtension } from "./identities/pi-extension-install.ts";

// Self-heal: make sure this identity's Pi configDir carries the current AIS
// identity extension (status line + /ais) before the real binary starts.
// Never throws and never blocks the launch (see pi-extension-install.ts).
await runWrapper(PI_CONFIG, "Pi", (configDir) => installPiExtension(configDir));
