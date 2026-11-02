#!/usr/bin/env bash
# Runs one gateway e2e script from a throwaway pod in a namespace other than dev,
# against the in-cluster gateway Service. The pod is removed afterwards (--rm plus
# an explicit delete on exit). Nothing is built: the pod uses a stock bun image and
# installs the pinned SDK versions from package.json at start.
#
#   test/gateway-e2e/run-in-cluster.sh <script> [app]
#
#   <script>  claude | codex | kimi | grok | zai | ali | opencode | claude-long-stream
#   [app]     gateway app name, default e2e-<script> (claude-long-stream uses e2e-claude)
#
# The app's Secret ais-gateway-<app> must exist in the namespace (ais gateway app add
# creates it). The pod gets AIS_GATEWAY_TOKEN from it; AIS_GATEWAY_URL is replaced by
# the in-cluster Service URL. Environment: AIS_E2E_NAMESPACE (default ais-gateway-e2e),
# AIS_E2E_IMAGE (default oven/bun:1.3), AIS_E2E_MODEL (optional model override),
# AIS_E2E_GATEWAY_SERVICE (default http://ais-gateway.dev.svc.cluster.local:47130).
set -euo pipefail

script="${1:?usage: run-in-cluster.sh <script> [app]}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
[[ -f "$here/$script.ts" ]] || { echo "no such script: $script" >&2; exit 2; }

default_app="e2e-${script%-long-stream}"
app="${2:-$default_app}"
ns="${AIS_E2E_NAMESPACE:-ais-gateway-e2e}"
image="${AIS_E2E_IMAGE:-oven/bun:1.3}"
service="${AIS_E2E_GATEWAY_SERVICE:-http://ais-gateway.dev.svc.cluster.local:47130}"
if [[ "$ns" == "dev" ]]; then echo "refusing to run in the gateway's own namespace (dev)" >&2; exit 2; fi
pod="gw-e2e-${script}-$(date +%s)"

# Pinned SDK versions come from the repo's dev dependencies, so they are stated once.
deps="$(bun -e '
  const p = await Bun.file(process.argv[1]).json();
  const pick = (n) => [n, p.devDependencies[n]];
  console.log(JSON.stringify({ name: "gw-e2e", private: true, type: "module", dependencies: Object.fromEntries([pick("@anthropic-ai/sdk"), pick("openai")]) }));
' "$root/package.json")"

overrides="$(APP="$app" SERVICE="$service" MODEL="${AIS_E2E_MODEL:-}" bun -e '
  const env = [{ name: "AIS_GATEWAY_URL", value: `${process.env.SERVICE}/${process.env.APP}` }];
  if (process.env.MODEL) env.push({ name: "AIS_E2E_MODEL", value: process.env.MODEL });
  console.log(JSON.stringify({ spec: { containers: [{
    name: process.argv[1], image: process.argv[2], stdin: true, stdinOnce: true,
    envFrom: [{ secretRef: { name: `ais-gateway-${process.env.APP}` } }],
    env,
    command: ["sh", "-c", "mkdir -p /tmp/w && cd /tmp/w && tar x && bun install --silent && bun " + process.argv[3] + ".ts"],
  }] } }));
' "$pod" "$image" "$script")"

cleanup() { kubectl -n "$ns" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Tar on stdin: the script, its helper and a package.json holding only the pinned deps.
work="$(mktemp -d)"
trap 'rm -rf "$work"; cleanup' EXIT
cp "$here/common.ts" "$here/$script.ts" "$work/"
printf '%s\n' "$deps" >"$work/package.json"
tar -C "$work" -cf - . | kubectl -n "$ns" run "$pod" --rm -i --restart=Never --quiet \
  --image="$image" --overrides="$overrides" --
