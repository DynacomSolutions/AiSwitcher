# AIS Console (web)

Local control panel for AiProfileSwitcher: identities, live processes, limits, usage, sessions, auth health and config files, built strictly against `docs/API.md`.

- Install: `pnpm install`
- Develop: `pnpm dev` (proxies `/api` to `127.0.0.1:47129`)
- Build: `pnpm build` (emits `dist/`)
- The console server serves this `dist/` directory at its root.
