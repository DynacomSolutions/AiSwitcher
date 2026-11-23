# CI change selection

Pull request CI and push CI run only the jobs and tests that the change set
can affect. A push reads the diff from the event base to the head, as a pull
request does. The full suite runs only per release, before publish
(`release.yml`). The selector is `scripts/ci/affected.ts`;
the host app uses the same engine through `scripts/host/affected.ts`, and the
live image uses `image/build/affected.ts` with the `bun run build` metafile.

The live image build is not part of pull request or `main` CI. It is a manual
release job: `live-image.yml` runs on `workflow_dispatch`, and
`release-live-image.yml` calls it for `live-v*` tags. The rows below that name
the live image describe what that manual run selects. The image script tests in
`test/image` still run in `ci.yml` on every pull request.

## How the selection works

The repository is one bun package plus standalone apps, so the dependency
graph is the relative import graph of the sources. The selector walks every
`test/**/*.test.ts` and `apps/chrome-extension/test/**/*.test.ts` import
closure and runs each test whose closure contains a changed file. A changed
test file always runs itself.

Areas and their jobs:

| Change area | Jobs that run |
| --- | --- |
| `src/gateway/` and other gateway-only code | selected root tests and the live image (the `ais` binary bundles the gateway); no host native builds, no test-macos, no extension, no web |
| `src/host/`, `apps/host/`, `scripts/host/`, `test/host/`, `image/contract/`, the adapter import graph | host-app checks, native macOS and Linux builds, Windows cross-build and Windows test |
| `apps/chrome-extension/`, `src/browser/` | extension build, plus the extension and browser tests in the root suite |
| `apps/web/` | web build and mobile-layout e2e, plus `test/web` when a changed module sits in its closure; no live image |
| shim, execve and session-sidecar sources | test-macos, the live image, plus the selected root tests |
| `apps/tui/`, `image/` | live-image build and boot tests |

The host adapter sidecar bundles `src/host/adapter.ts` and its whole import
graph, so a change deep in `src/identities/` or `src/sync/` can still run the
host native builds when the adapter imports it. The Rust core also embeds
`src/live/path-classes.json`.

## Shared inputs run everything

A change to any of these runs every job and the full suite:

- root `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `.bun-version`, `.gitleaks.toml`
- `.github/workflows/`, `scripts/ci/`, `scripts/build.ts`, `scripts/source-hash.ts`
- the scan tools and allowlist (`scripts/identifier-scan.ts`, `scripts/secret-scan.ts`, `scripts/privacy-check.ts`, `scripts/identifier-allowlist.ts`, `scripts/identifier-tlds.ts`)
- shared test helpers: `test/setup-env.ts`, `test/fixtures/`

Exception: a version-only bump of the root `package.json` is not a shared
input. The version string is embedded in the binaries but changes no
behaviour; release builds carry the new version. Any dependency, script or
toolchain change in `package.json` still runs everything.

## Fail open

Any doubt runs everything:

- an unknown path (a new top-level directory or root file)
- a deleted file (it may still be referenced)
- a changed `src/` or `scripts/` file that no test imports and no area consumes (it may run through a subprocess, like the shim entrypoints and the live-image boot scripts)
- an unreadable diff or metafile

## Skipped jobs still report

The aggregate gates always run: `ci-gate` in `ci.yml`, `gate` in
`host-app.yml` and `live-image.yml` (the last one only on a manual or release run). They fail when a needed job failed or
was cancelled, and pass when the selection deliberately skipped it. Required
checks therefore keep reporting on every PR.

## Pushes and the full suite

Pushes to `main` select like pull requests. The `changes` job passes the
push `before` and `after` commits as the base and head. A zero base (new
branch), an unreadable base (force-push) or a deleted file fails open to
everything. The `test` job runs the privacy, identifier and secret scans, the
mod validation and the typecheck on every event, then the selected tests.

The full suite runs only per release, before publish.

## Local checks

```sh
bun scripts/ci/affected.ts src/gateway/serve.ts   # print the selection for a change set
bun test test/ci test/host/affected.test.ts test/image/affected.test.ts
actionlint .github/workflows/*.yml
```
