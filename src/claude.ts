import { runWrapper } from "./shared/run-wrapper.ts";
import { CLAUDE_CONFIG } from "./identities/tool-configs.ts";

await runWrapper(CLAUDE_CONFIG, "Claude");
