# Tasks

Track product work, bugs and acceptance evidence. Routine Git operations are not tasks.

| ID | Workstream | Status | Owner | Evidence and acceptance gaps |
| --- | --- | --- | --- | --- |
| 1 | Preserve Grok's explicit memory control through the identity launcher | Done | grok_memory_fix | Exact-key forwarding and four real-subprocess regressions are source-reviewed. Focused QA completed successfully; full CI on `97ae2de` passed typecheck and 609 tests across 76 files with zero failures ([run](https://github.com/DynacomSolutions/AiSwitcher/actions/runs/34216796298)). Compiled launcher inspected live: both launcher and real Grok child receive `GROK_MEMORY=0`. Installed binary matches the tested candidate byte-for-byte, with a rollback copy; other launchers and shared memory settings are unchanged. Other session markers and explicit child overrides remain intact. |
