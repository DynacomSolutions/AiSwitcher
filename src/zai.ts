import { runWrapper } from "./shared/run-wrapper.ts";
import { ZAI_CONFIG } from "./identities/tool-configs.ts";

await runWrapper(ZAI_CONFIG, "Crush");
