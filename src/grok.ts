import { runWrapper } from "./shared/run-wrapper.ts";
import { GROK_CONFIG } from "./identities/tool-configs.ts";

await runWrapper(GROK_CONFIG, "Grok");
