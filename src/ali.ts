import { runWrapper } from "./shared/run-wrapper.ts";
import { ALI_CONFIG } from "./identities/tool-configs.ts";

await runWrapper(ALI_CONFIG, "Crush");
