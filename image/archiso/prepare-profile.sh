#!/usr/bin/env bash
# Runs in the copied profile, before mkarchiso sources profiledef.sh. These
# are image accounts, never a capture of the build host's account database.
set -euo pipefail
profile=${1:?usage: prepare-profile.sh profile-directory}
etc=$profile/airootfs/etc
mkdir -p "$etc" "$profile/airootfs/usr/local/bin"
for file in passwd group shadow gshadow; do
    [[ ! -e $etc/$file && ! -L $etc/$file ]] || { echo "prepare-profile: account input already exists: $file" >&2; exit 1; }
done
cat >"$etc/passwd" <<'ACCOUNTS'
root:x:0:0:root:/root:/usr/bin/bash
nobody:x:65534:65534:Kernel Overflow User:/:/usr/bin/nologin
live:x:1000:1000:Live session:/home/live:/usr/bin/bash
agent:x:1001:1001:Agent:/home/agent:/usr/bin/bash
ACCOUNTS
cat >"$etc/group" <<'GROUPS'
root:x:0:
nobody:x:65534:
live:x:1000:
agent:x:1001:
GROUPS
# All password logins start locked. Session launch policy belongs to boot flow.
umask 077
# Keep every password login locked without marking interactive live sessions
# as needing a password change. An empty last-change field disables ageing.
awk -F: '{print $1 ":!::0:99999:7:::"}' "$etc/passwd" >"$etc/shadow"
awk -F: '{print $1 ":!::"}' "$etc/group" >"$etc/gshadow"
