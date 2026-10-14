import { runCli } from "./cli/dispatch.ts";
import { TOOL_CONFIGS } from "./cli/identities/resolve-tool.ts";
import { runSessionSidecar, takeSidecarSpec } from "./shared/session-sidecar.ts";

// `ais resume` execs the real tool and re-enters this binary as the detached
// session sidecar (see shared/session-sidecar.ts); it is not a user command.
const sidecarSpec = takeSidecarSpec(process.argv, process.env);
if (sidecarSpec) {
  await runSessionSidecar(TOOL_CONFIGS[sidecarSpec.toolName], sidecarSpec).catch(() => {});
  process.exit(0);
}
await runCli(process.argv.slice(2));
