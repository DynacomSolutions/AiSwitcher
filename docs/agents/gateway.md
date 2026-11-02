# AI Gateway: giving an app AI access

_Read before wiring a cluster app to a provider, or before touching `src/cli/gateway/`._

## When to use it

Use the gateway when a cluster app needs to call a provider that AIS already holds a
subscription login for (Claude, Codex, Kimi, Grok, Z.AI, Alibaba, OpenCode Go). The
app keeps the provider's real SDK and changes only its base URL and API key. AIS
swaps in the live login and refreshes it, so one refresh in AIS fixes every app, and
every request is recorded against the app that made it. Do not copy provider
credentials into an app.

## The one command

Run it from a host that has `kubectl` access to the app's namespace. The admin
endpoint and token are read from `~/.secrets` (`AIS_GATEWAY_ADMIN_URL`,
`AIS_GATEWAY_ADMIN_TOKEN`, plus `AIS_GATEWAY_PROXY_URL`, the public proxy base).

```sh
ais gateway app add billing --namespace=shop --provider=claude --pool
```

Flags use the `--flag=value` form.

`add` registers the app with the admin API, mints its token, applies Secret
`ais-gateway-<app>` into `--namespace` (keys `AIS_GATEWAY_URL`,
`AIS_GATEWAY_USERNAME`, `AIS_GATEWAY_TOKEN`) with your kube context, and stores the
token in `~/.secrets` as `AIS_GATEWAY_APP_<NAME_UPPER_SNAKE>_TOKEN` (after a
`~/.secrets.bak.<epoch>` backup, mode 0600). The token is printed once and is never
passed to `kubectl` on the command line (the manifest goes through stdin). The
Secret is created out of band, not through GitOps; mount it in the app's manifests
with `envFrom` / `secretKeyRef`.

Other commands:

```sh
ais gateway app list | show <name> | update <name> [flags] | rotate <name> | revoke <name>
ais gateway usage [--app=billing] [--provider=claude] [--days=7] [--json]
```

## Pinned or pool

- `--identity=<id>` pins the app to one AIS identity. Use it when the app needs one
  specific account.
- `--pool` lets the gateway pick among the provider's identities by headroom;
  `--identities=a,b` limits the pool to those. Prefer the pool unless there is a
  reason to pin.
- The two are mutually exclusive, and one of them is required.
- `--style=anthropic|openai` is required for `kimi` and `zai`, which offer both API
  styles. Other providers have one style and it is filled in for you.

## Caps and reserve

- `--daily-tokens=N` caps the app's tokens per day.
- `--reserve=80` (1 to 100) is the share of an identity's limit that apps may use,
  keeping the rest for people working in AIS directly.
- `--models=glob,glob` restricts which models the app may request.

The admin API owns validation; its reason is shown when a value is refused.

## Rotate and revoke

`rotate` mints a new token and rewrites the Secret and `~/.secrets`. Earlier tokens
keep working for an overlap window (24 hours by default) so pods can restart onto
the new Secret. `revoke` is immediate and final for the app. If `kubectl` fails
during `add` or `rotate`, the token is still saved to `~/.secrets`; fix access and
run `rotate`.

## What the app sets

| Setting | Value |
| --- | --- |
| Base URL | `AIS_GATEWAY_URL` (`<proxy base>/<app>`) |
| API key | `AIS_GATEWAY_TOKEN` |

```python
# Anthropic SDK
import os, anthropic
client = anthropic.Anthropic(base_url=os.environ["AIS_GATEWAY_URL"], api_key=os.environ["AIS_GATEWAY_TOKEN"])

# OpenAI SDK
import os, openai
client = openai.OpenAI(base_url=os.environ["AIS_GATEWAY_URL"], api_key=os.environ["AIS_GATEWAY_TOKEN"])
```

The gateway changes credential headers only. It does not rewrite bodies.

## Usage recording

Chat Completions streams report no usage unless the request sets
`stream_options={"include_usage": true}`. Without it the stream works but its tokens
are not recorded. Anthropic Messages and the Responses API report usage by default.

## Per-provider notes

Subscription endpoints can insist on the request shape of their own CLI. The gateway
is transparent, so an app that does not meet the shape gets the provider's own error
back; meeting it is the app's job.

- **claude** (anthropic style): the Claude OAuth login expects Claude Code's identity
  system prompt as the first system block (`You are Claude Code, Anthropic's official
  CLI for Claude.`). Add it to the app's system prompt. The gateway adds the
  `anthropic-beta: oauth-2025-04-20` header and merges the app's own betas.
- **codex** (openai style): a ChatGPT login reaches only the Codex backend, so the
  OpenAI SDK works through the Responses API, not Chat Completions. Expect to send
  `instructions`, `store: false` and `stream: true` as the Codex CLI does. These
  expectations are unproven against the live backend until the real-SDK smoke check.
- **kimi** (anthropic or openai): the Kimi Coding endpoint; choose the style that
  matches your SDK.
- **grok** (openai style): Chat Completions.
- **zai** (anthropic or openai): choose the style that matches your SDK.
- **ali** (anthropic style only): Alibaba Token Plan.
- **opencode** (openai style only): OpenCode Go.
