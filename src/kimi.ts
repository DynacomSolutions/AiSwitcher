import { runWrapper } from "./shared/run-wrapper.ts";
import { KIMI_CONFIG } from "./identities/tool-configs.ts";

await runWrapper(KIMI_CONFIG, "Kimi");
