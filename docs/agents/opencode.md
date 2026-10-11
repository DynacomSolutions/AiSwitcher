# OpenCode identity proxy

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3343-3362). Read before touching this area._

### OpenCode identity proxy (2026-08-27)

- `opencode` is a real eighth AIS-managed CLI, separate from the retired
  zai-via-OpenCode experiment above. `OPENCODE_CONFIG` points
  `OPENCODE_CONFIG_DIR` at the identity root and redirects `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, and `XDG_STATE_HOME` into `data`, `cache`, and `state`
  subdirectories. OpenCode adds its own `opencode/` suffix to the XDG roots.
- `run`, `acp`, and `serve` are non-interactive entrypoints. The wrapper must
  never prompt for an identity in those modes. `serve` remains loopback-only
  unless the caller explicitly supplies another hostname.
- Provider credentials remain OpenCode-owned. In particular, never reuse
  Claude Pro/Max OAuth: Anthropic supports third-party clients with an API
  key. OpenAI/xAI use OpenCode's OAuth flows; Kimi For Coding, Z.AI Coding
  Plan, and Alibaba Token Plan use their dedicated product credentials.
- OpenCode identities mirror the same account boundaries used by the other
  AIS wrappers. Never aggregate credentials from unrelated AIS identities
  into one catch-all OpenCode profile.
- OpenCode currently participates in identity management, backup, update,
  upgrade, and SSH profile sync. Usage, limits, doctor, and resume degrade to
  their existing honest unsupported result until native collectors are added.

