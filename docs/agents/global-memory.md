# Global memory projection

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 480-503). Read before touching this area._

- **Global memory belongs to AIS, never a vendor identity or the AIS git
  repository.** `~/.ais/memory/GLOBAL.md` is the sole writable authority and
  is deliberately outside every SSH profile-sync root and git-managed backup
  group. `run-wrapper.ts` projects it at launch through the mandatory
  `ToolConfig.globalMemoryProjection`: Claude append-system-prompt file,
  Codex developer instructions, Grok rules, Kimi global AGENTS discovery, Pi
  append-system-prompt file, OpenCode runtime config content, or Crush global
  context paths. Any vendor file or config entry created for compatibility is
  a projection only. `ais memory add` is the cross-agent write API. Adding a
  tool without declaring a projection is a type error.
  When the memory file resolves into a git-base base checkout
  (`<root>/.worktrees/<org>/.base/<repo>`) with `git-base` on `PATH`, writes go
  through `git-base land` (`src/shared/memory-land.ts`) and never in place;
  failures propagate. `AIS_MEMORY_LAND=0` forces in-place;
  `AIS_GIT_BASE_BIN` overrides the executable.
  - **Pi management subcommands bypass the projection.** Pi routes
    `install`/`remove`/`uninstall`/`update`/`list`/`config`/`auth` only when
    the literal argv[0] names them, so the prepend must NOT happen for those:
    `pi update --extensions` otherwise became a chat launch that died with
    `Error: Unknown option: --extensions` (confirmed live 2026-09-16).
    `piBypassesMemoryProjection()` mirrors pi's own argv[0] test exactly -
    none of these subcommands starts an agent turn, so nothing needs the
    system prompt. Reproduced and fixed with a sandbox-HOME run through the
    compiled shim.

