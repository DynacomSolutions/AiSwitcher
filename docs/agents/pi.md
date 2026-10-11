# pi identities extension and single instance

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 2662-2851). Read before touching this area._

### pi identities extension (2026-09-11): in-session visibility, provider switching, add-only sync

> **Superseded in part (2026-09-15):** the relaunch-only stance for
> whole-identity switching below no longer holds - see "pi single instance"
> next. The add-only sync, extension installer and honesty rules still stand.

The wrapped pi tool gained an in-session identity surface: a self-heal-installed
TypeScript extension (`src/pi-extension/ais-identity-extension.ts`) plus an
add-only credential sync (`ais auth sync --tool=pi <identity>`). Facts about
pi 0.85.1 (`@earendil-works/pi-coding-agent`) that the design rests on, all
verified from the installed package (docs/extensions.md, dist/core/auth-storage.js,
dist/core/model-registry.d.ts) rather than assumed:

- **Extensions are plain TypeScript loaded via jiti** - no bundling step.
  Pi auto-discovers `$PI_CODING_AGENT_DIR/extensions/*.ts`, which under the
  AIS wrapper IS the identity's own configDir, so per-identity installation
  is just a version-stamped file copy (`pi-extension-install.ts`, wired as
  the `pi` entrypoint's `beforeLaunch` hook; never throws, one stderr
  warning on failure). The embedded source travels inside the compiled
  binary via Bun's `with { type: "text" }` import attribute; beware a Bun
  quirk: in a process that ALSO imports the extension as a module (the unit
  tests do), the attribute import resolves to the module namespace instead
  of the text, so the installer falls back to reading the file from disk
  (only possible in dev/test, where the source tree exists).
- **pi re-reads auth.json per request.** `AuthStorage.readLatestData()`
  revalidates a `dev:ino:size:mtimeNs:ctimeNs` file revision on every read
  and re-reads on change; writes take a file lock. External atomic swaps of
  auth.json ARE picked up by a running pi - which makes in-session
  whole-identity swapping TEMPTING and is exactly why the honesty rule
  matters (next point).
- **Whole-identity switching is deliberately relaunch-only.** Not because
  pi can't re-read credentials (it can, proven above) but because a
  swapped-in copy of another identity's rotating OAuth tokens would refresh
  INTO the hosting identity's auth.json (pi writes token refreshes back to
  its own configDir), corrupting AIS's ONE-credential-per-(identity,
  provider) model - the kimi rotation failure mode kimi-store.ts exists to
  prevent, with the swapped copy now attributed to the WRONG identity for
  spend, limits and usage. `/ais identities` therefore lists every registry
  identity with its `ais pi --identity=<name>` launch command and says
  plainly that switching requires a relaunch. In-session provider/model
  switching, by contrast, is fully supported via pi's own
  `pi.setModel(model)` API (returns false when the provider has no
  authentication; emits `model_select`, which the extension mirrors into
  its status line and open widget) and never changes the defaults new
  sessions start with.
- **Visibility surfaces**: a persistent footer status
  (`ctx.ui.setStatus`: `ais <identity>: <provider>/<model>`) set on
  `session_start` and every `model_select`, plus `/ais` rendering a compact
  widget panel (pi caps widgets at 10 lines - `InteractiveMode
  .MAX_WIDGET_LINES`, so the current provider is sorted first and the panel
  is two header lines + table) showing each provider's credential type and
  catalogue model count from `ctx.modelRegistry.getAvailable()`, with
  honest gap notes (`no credential in auth.json`, `credential present but
  no models in Pi's catalogue`, and the Amazon Bedrock ambient-AWS-chain
  note). The identity name comes from the wrapper's
  `AI_PROFILE_SWITCHER_SESSION` env var; when absent the extension says
  "launched outside the ais wrapper" instead of guessing.
- **Sync is ADD-ONLY.** `ais auth sync --tool=pi` (planner
  `planPiCredentialSync` in pi-auth.ts) adds providers auth.json is
  MISSING and never overwrites present ones: the freshest copy of a
  rotating OAuth token may already live in auth.json because pi itself
  refreshed it (the same freshness law kimi-store.ts implements for
  kimi). Source resolution per tool registry: explicit `--<tool>=<name>`
  flag > same-named identity > a registry holding exactly one identity >
  an honest skip note (never a guess). alibaba-plan rides the same
  Crush-catalogue translation importPiCredentials uses. amazon-bedrock
  gets a permanent honest gap note: pi speaks it, but its auth rides the
  ambient AWS credential chain and AIS holds no Bedrock credential to
  sync (aws-profile.ts is reporting-only by design).

Live verification (2026-09-11, sanitized throwaway copy of an identity
configDir under a temp HOME, real pi 0.85.1 driven through the real wrapper
in tmux): the extension self-heal installed on launch and pi listed
`ais-identity.ts` under loaded extensions; the footer showed
`ais identity-a: anthropic/claude-opus-4-8`; `/ais` rendered the provider
table with credential types, model counts and gap notes; `/ais use
zai/glm-5.3` flipped pi's OWN footer to `(zai) glm-5.3 - high` and the AIS
status line to `ais identity-a: zai/glm-5.3` with no request sent (cost
footer stayed at $0.000); unknown providers error honestly. Watch out when
reproducing: a temp HOME hides `~/.ais/npm/bin`, and PATH then falls
through to `/usr/bin/pi` - the OLD pre-rebrand `@mariozechner/pi-coding-agent`
- and the old binary and the AIS shim will spawn each other in an infinite
`--append-system-prompt`-accumulating loop; symlink the managed bin dir
into the temp HOME first.

### pi single instance (2026-09-15): one pi exposes every AIS identity, switch in-app

Owner instruction (2026-09-13): "Pi should not be a proxy asking for AIS ID -
a single instance should expose all IDs and models and allow me to switch
inside the app between AIS ID", "/ais should show an interactive switcher",
the footer must show the identity's real LABEL ("Personal", not "personal"),
and pi must remember the last-used model across launches. Design:

- **Launch boundary**: `PI_CONFIG.singleInstanceDir` (~/.pi/agent, pi's own
  default home) makes `resolveIdentity` take `resolveSingleInstanceIdentity`:
  it NEVER prompts and never errors on no-match. `--identity=<name>` must
  still name a real registry entry (typos stay loud) but only SEEDS the
  in-app default; a preset `PI_CODING_AGENT_DIR` remains a power-user
  override of the whole instance (also the way to launch an OLD per-identity
  profile with its historical sessions). A dir-pattern match seeds the
  default identity; ambiguity demotes to "no seed" with one stderr note.
  When nothing matched, run-wrapper OMITS `AI_PROFILE_SWITCHER_SESSION`
  entirely - a basename pseudo-marker ("agent") would be inherited by nested
  `codex`/`claude` launches and fail there as UnknownIdentityError.
- **All identities' credentials, live**: the v2.0.0 extension (async factory;
  pi awaits it before startup, so registrations are in the catalogue before
  defaults resolve) reads ~/.pi/identities.json and each identity's
  auth.json + models.json, then registers one NAMESPACED provider per
  (identity, provider): `<provider>--<identity>` (ids never contain `--`;
  parse splits on the LAST separator). Built-ins are cloned from pi-ai's own
  `builtinProviders()` (the extension imports
  `@earendil-works/pi-ai/providers/all` and `/compat` - pi's jiti loader
  aliases BOTH to its bundled copy in every runtime mode, verified in
  dist/core/extensions/loader.js), with every model remapped to the
  namespaced id and stream/streamSimple delegated to the native
  implementation. Custom catalogues (alibaba-plan & co.) come from the
  identity's models.json, streamed through compat's generic
  `stream`/`streamSimple`.
- **The attribution law is what unlocked in-app switching.** The 2026-09-11
  relaunch-only stance existed because a swapped-in credential copy would
  refresh into the WRONG identity's store. v2 never copies: the namespaced
  provider's `auth.apiKey.resolve` reads the SOURCE identity's auth.json per
  request, refreshes expiring OAuth (<120s window) through the NATIVE
  provider's own `auth.oauth.refresh`, and writes the rotated credential
  back into the SOURCE identity's auth.json (read-modify-write, mode 0600,
  per-(identity, provider) in-process serialisation, re-read-under-lock so a
  concurrent refresher wins, re-read-once retry after a failed refresh).
  One credential per (identity, provider) still holds; the shared instance
  stores no identity credential at all. `api_key` credentials delegate to
  the native `apiKey.resolve` (provider quirks preserved); custom-catalogue
  keys honor `authHeader` and `$ENV`/`${ENV}` interpolation (`!command` is
  unsupported and honestly skipped).
- **`/ais` = interactive switcher, TYPE-TO-SEARCH** (v2.1.0): both steps
  run through `SearchableSelect`, a custom component via `ctx.ui.custom`
  (pi's extension loader aliases `@earendil-works/pi-tui`, so `matchesKey`/
  `Key`/`truncateToWidth` come from pi's own bundled copy - the installed
  file stays self-contained). Whitespace-separated tokens AND as
  case-insensitive substrings; arrows/page keys move within the FILTERED
  subset (12-row scrolling window), enter accepts the highlighted ORIGINAL
  option, esc cancels, the component is inert after completion, and
  unrecognised escape sequences are ignored rather than typed as garbage.
  Hosts without `ctx.ui.custom` fall back to `ctx.ui.select`, and non-UI
  modes to the identities widget. Identity step lists LABELS (current
  marked); model step floats last-used first; `pi.setModel(namespaced)`
  applies. A successful switch now persists ais-state.json IMMEDIATELY
  (the model_select handler still writes again - idempotent, and correct
  even if a host swallowed the event). `/ais show` = the context panel (active identity's providers,
  credential types, counts, gap notes); `/ais use [<identity> ]<provider>[/
  <model>]` = non-interactive, scoped active-identity-first, then a UNIQUE
  foreign-identity match (ambiguous -> honest disambiguation hint), then
  pi's native catalogue; `/ais identities` keeps the table (now saying
  "switch in-app", no relaunch needed).
- **Last-used model is remembered**: every `model_select` writes
  `defaultProvider`/`defaultModel` into the instance's settings.json - pi's
  OWN native startup-default mechanism (before this, pi only saved it via
  Ctrl+S in /model, so launches always fell back to catalogue defaults).
  A one-off `--model`/`-m` flag suppresses exactly ONE persist so it cannot
  clobber the remembered default. `ais-state.json` (instance dir) tracks
  activeIdentity + per-identity lastModel; `session_start` seeds the active
  identity (wrapper marker > persisted > cwd dir-match > first) and only
  intervenes on the model when NOTHING usable is configured (namespaced
  default checked against the registered catalogue; native default trusted
  via settings/instance auth.json because hasConfiguredAuth reads an
  availability snapshot that may not be computed yet at session_start -
  racing it would stomp the user's default). Footer status uses the registry
  LABEL and the BASE provider (`ais Personal: anthropic/claude-opus-5`).
- **Wrapper self-heal**: `pi.ts` installs the extension into the instance
  dir and now reconciles OAuth copies for ALL registered pi identities
  (`reconcileAllPiIdentitiesOnLaunch`) since the instance live-reads every
  identity's store.
- Verified live (sanitized): prototype namespaced clone
  `openai-codex--<identity>` completed a real PONG roundtrip through the
  identity's own OAuth credential (2026-09-13, pi 0.85.1); compiled wrapper
  in a sandbox HOME launched with NO prompt, self-installed extension
  2.0.0, dir-match seeded the identity, session_start's default restore
  routed a real request through `zai--<identity>` (401 on the synthetic
  key = full credential plumbing), ais-state.json written (2026-09-15).
  Gotchas: `pi --list-models` does NOT load extensions (namespaced providers
  only appear in real sessions); an anthropic OAuth roundtrip returned
  Anthropic's "third-party apps draw from extra usage" 400 identically for
  the NATIVE provider - account policy, not a clone defect. 74 extension
  unit tests (injected deps, synthetic fixtures) + 6 single-instance
  resolve tests. Searchable picker driven through a real pty (`script`)
  against the compiled wrapper: extension 2.1.0 self-installed, both
  dialogs rendered `Search:`, and typing `synth b` then `opus` ended in
  `switched to Synth B: anthropic/claude-opus-4-5` (2026-09-15).
- Known limits: old per-identity session histories stay in their dirs (launch
  with the env override to reach them); per-request auth adds one small
  auth.json read; `opencode`-style multi-var tools are unaffected - this is
  pi-only.

