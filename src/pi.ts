import { runWrapper } from "./shared/run-wrapper.ts";
import { PI_CONFIG } from "./identities/tool-configs.ts";

await runWrapper(PI_CONFIG, "Pi");
