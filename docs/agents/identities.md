# Identities: retirement and directory-pattern matching

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 454-479). Read before touching this area._

- **Retirement keeps the identity, drops its credentials (`identities/retired.ts`,
  `retire-credentials.ts`).** `ais identities retire` sets `retired`/`retiredAt`
  and purges stored credentials; the registry entry stays so the name and aliases
  remain occupied and local usage history stays attributable. Retired identities
  are excluded from every selection and live-probe path (launch, resolution,
  limits, doctor, auth refresh, reconcile) but kept in usage reports from local
  data only. `unretire` records `unretiredAt` and does NOT restore credentials.
  Sync treats the three fields as one event stream: the side with the newest
  `retiredAt`/`unretiredAt` wins all three (absent fields on the winner are
  removed); with no events the old primary-wins merge applies. rsync never
  propagates deletes and the tree merge copies absent files in, so
  `mergeIncomingProfileTree`/`recoverProfileArchives` re-run the purge for every
  retired identity afterwards. macOS Keychain entries for Claude are not
  handled (no known service name); retire only prints a manual-removal warning.

- **Directory-pattern grammar is intentionally stricter than a standard glob
  dialect.** A `directories` entry with no wildcard matches only that exact
  directory (no implicit recursive/prefix matching). An entry must end in a
  literal `/*` to mean "this directory and everything beneath it, recursively."
  Libraries like picomatch/minimatch treat a bare trailing `*` as single-level
  only — adopting that as-is would have silently broken this project's
  matching semantics, so `src/identities/match.ts` hand-rolls the grammar
  instead. Tie-break when multiple identities' patterns match the same cwd:
  most-specific (longest) pattern wins; an exact match always outranks a
  recursive match anchored at the same directory; a true tie between two
  *different* identities falls through to the interactive prompt.

