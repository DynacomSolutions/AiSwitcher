import { runWrapper } from "./shared/run-wrapper.ts";
import { KIMI_CONFIG } from "./identities/tool-configs.ts";
import { seedKimiPoolModelConfig } from "./identities/kimi-pool-config.ts";

// The callback also seeds a pool config.toml's non-credential model
// configuration (default_model, [secondary_model], missing models/providers)
// from the current active member once, while those are unset (see
// identities/kimi-pool-config.ts); ordinary identities are a no-op.
await runWrapper(KIMI_CONFIG, "Kimi", seedKimiPoolModelConfig);
