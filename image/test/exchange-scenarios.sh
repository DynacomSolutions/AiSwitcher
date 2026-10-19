#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly MARKER_PREFIX='AIS-EXCHANGE-TEST:'
readonly STATE_REL='.ais/live/exchange-state.json'

fail() {
  printf '%s case=%s status=fail reason=%s\n' "$MARKER_PREFIX" "${CASE_NAME:-unknown}" "$1"
  exit 1
}

pass() {
  printf '%s case=%s status=pass\n' "$MARKER_PREFIX" "$CASE_NAME"
}

[[ $(</proc/cmdline) == *'ais.test=1'* ]] || { printf '%s\n' 'exchange scenarios require ais.test=1' >&2; exit 77; }
[[ $EUID -eq 0 ]] || { printf '%s\n' 'exchange scenarios require the test-only root unit' >&2; exit 77; }
(($# == 1)) || { printf '%s\n' 'usage: exchange-scenarios.sh <boot|replay|tamper|auth-deferred|auth-plausible|crafted|symlink|periodic|shutdown>' >&2; exit 64; }
CASE_NAME=$1
AGENT_HOME=$(getent passwd agent | cut -d: -f6)
[[ -n $AGENT_HOME && $AGENT_HOME == /* && -d $AGENT_HOME ]] || fail agent-home-unavailable
STATE_PATH=$AGENT_HOME/$STATE_REL

state_seq() {
  node - "$STATE_PATH" <<'JS'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.version !== 1 || !Number.isSafeInteger(value.lastInboxSeq) || value.lastInboxSeq < 0) process.exit(1);
process.stdout.write(`${value.lastInboxSeq}\n`);
JS
}

outbox_seq() {
  node - /mnt/aisx/outbox <<'JS'
const fs = require("node:fs");
let highest = 0;
for (const name of fs.readdirSync(process.argv[2])) {
  const match = /^bundle-([1-9][0-9]{0,17})\.age$/.exec(name);
  if (match && Number.isSafeInteger(Number(match[1]))) highest = Math.max(highest, Number(match[1]));
}
process.stdout.write(`${highest}\n`);
JS
}

start_inbox() {
  systemctl start ais-live-inbox.service || true
}

case $CASE_NAME in
  boot)
    [[ -f $AGENT_HOME/.claude/identities/SYNTHETIC_FIXTURE_exchange/settings.json ]] || fail config-fixture-not-applied
    grep -q 'SYNTHETIC_FIXTURE_exchange_config' "$AGENT_HOME/.claude/identities/SYNTHETIC_FIXTURE_exchange/settings.json" || fail config-fixture-content
    [[ $(state_seq) == 1 ]] || fail initial-sequence-not-recorded
    journalctl -b -u ais-live-inbox.service --no-pager | grep -q 'stage=inbox status=ok applied=' || fail inbox-success-marker-missing
    pass
    ;;
  replay)
    before=$(state_seq) || fail inbox-state-missing
    start_inbox
    after=$(state_seq) || fail inbox-state-missing-after-replay
    [[ $before == 1 && $after == 1 ]] || fail replay-changed-sequence
    journalctl -b -u ais-live-inbox.service --no-pager | grep -q 'stage=inbox status=ok applied=0 skipped=' || fail replay-skip-marker-missing
    pass
    ;;
  tamper)
    before=$(sha256sum "$STATE_PATH" | cut -d' ' -f1) || fail state-hash-before-missing
    start_inbox
    after=$(sha256sum "$STATE_PATH" | cut -d' ' -f1) || fail state-hash-after-missing
    [[ $before == "$after" ]] || fail tampered-bundle-mutated-state
    journalctl -b -u ais-live-inbox.service --no-pager | grep -q 'status=rejected reason=authentication' || fail tamper-rejection-marker-missing
    pass
    ;;
  auth-deferred)
    before=$(state_seq) || fail inbox-state-missing
    auth_path=$AGENT_HOME/.claude/.credentials.json
    auth_before=absent
    [[ ! -f $auth_path ]] || auth_before=$(sha256sum "$auth_path" | cut -d' ' -f1)
    start_inbox
    after=$(state_seq) || fail inbox-state-missing-after-defer
    [[ $before == "$after" ]] || fail implausible-clock-mutated-state
    auth_after=absent
    [[ ! -f $auth_path ]] || auth_after=$(sha256sum "$auth_path" | cut -d' ' -f1)
    [[ $auth_before == "$auth_after" ]] || fail implausible-clock-mutated-auth
    journalctl -b -u ais-live-inbox.service --no-pager | grep -q 'status=deferred' || fail deferred-marker-missing
    pass
    ;;
  auth-plausible)
    start_inbox
    [[ $(state_seq) == 4 ]] || fail plausible-clock-did-not-apply
    grep -q 'SYNTHETIC_FIXTURE_exchange_auth_token' "$AGENT_HOME/.claude/.credentials.json" || fail plausible-clock-auth-not-applied
    journalctl -b -u ais-live-inbox.service --no-pager | grep -q 'stage=inbox status=ok applied=' || fail plausible-clock-marker-missing
    pass
    ;;
  crafted)
    install -d -m 0755 /run/ais-exchange-test/outside
    printf '%s\n' 'SYNTHETIC_FIXTURE_external_sentinel' >/run/ais-exchange-test/outside/settings.json
    chmod 0644 /run/ais-exchange-test/outside/settings.json
    before=$(state_seq) || fail inbox-state-missing
    sentinel_before=$(sha256sum /run/ais-exchange-test/outside/settings.json | cut -d' ' -f1)
    start_inbox
    sentinel_after=$(sha256sum /run/ais-exchange-test/outside/settings.json | cut -d' ' -f1)
    [[ $sentinel_before == "$sentinel_after" ]] || fail crafted_link_modified_external_sentinel
    after=$(state_seq) || fail inbox-state-missing-after-crafted
    [[ $before == "$after" ]] || fail crafted_bundle_mutated_inbox_state
    pass
    ;;
  symlink)
    # The single-quoted program is evaluated by bash after runuser changes identity, so $HOME is the agent home.
    # shellcheck disable=SC2016
    runuser -u agent -- bash -c 'mkdir -p "$HOME/.ais/logs"; printf "%s\n" "SYNTHETIC_FIXTURE_exchange_log" >"$HOME/.ais/logs/exchange.log"; ln -sfn /etc/shadow "$HOME/.ais/logs/shadow-link"; ln -sfn /run/ais-exchange-test/outside "$HOME/.ais/logs/external-dir"'
    pass
    ;;
  periodic)
    before=$(outbox_seq)
    systemctl start ais-live-outbox.timer
    systemctl start ais-live-outbox.service
    after=$(outbox_seq)
    (( after > before )) || fail periodic-outbox-not-published
    pass
    ;;
  shutdown)
    systemctl is-active --quiet ais-live-outbox-shutdown.service || fail shutdown-writer-not-active
    before=$(outbox_seq)
    systemctl stop ais-live-outbox-shutdown.service
    after=$(outbox_seq)
    (( after > before )) || fail shutdown-outbox-not-published
    journalctl -b -u ais-live-outbox-shutdown.service --no-pager | grep -q 'stage=outbox status=written seq=' || fail shutdown-writer-not-invoked
    pass
    ;;
  *) printf '%s\n' 'unknown exchange case' >&2; exit 64 ;;
esac
