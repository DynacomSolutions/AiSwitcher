# Tasks

Track product work, bugs and acceptance evidence. Routine Git operations are not tasks.

| ID | Workstream | Status | Owner | Evidence and acceptance gaps |
| --- | --- | --- | --- | --- |
| 1 | Preserve Grok's explicit memory control through the identity launcher | In progress | grok_memory_fix | Exact-key forwarding and four subprocess regression cases are implemented and source-reviewed. Candidate launcher compiled successfully; live inspection confirmed `GROK_MEMORY=0` in both launcher and real Grok child. Focused wrapper tests, typecheck, CI and installation remain pending. Other session markers and explicit child-environment precedence are retained. |
