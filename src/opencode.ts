import { OPENCODE_CONFIG } from "./identities/tool-configs.ts";
import { runWrapper } from "./shared/run-wrapper.ts";

await runWrapper(OPENCODE_CONFIG, "OpenCode");
