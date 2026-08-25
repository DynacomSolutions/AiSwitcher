import { runWrapper } from "./shared/run-wrapper.ts";
import { CODEX_CONFIG } from "./identities/tool-configs.ts";
import { recoverOrphanedCodexBackfill } from "./shared/codex-backfill.ts";

await runWrapper(CODEX_CONFIG, "Codex", recoverOrphanedCodexBackfill);
