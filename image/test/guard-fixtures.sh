#!/usr/bin/env bash
set -Eeuo pipefail

readonly FIXTURES=${AIS_GUARD_FIXTURE_DIR:-/var/tmp/ais-guard-test/fixtures}
SOURCES=$(cd "$(dirname "${BASH_SOURCE[0]}")/fixtures" && pwd)
readonly SOURCES
readonly REPO=/var/tmp/ais-guard-test/repo

refuse() { printf 'guard-fixtures: refused: %s\n' "$1" >&2; exit 1; }
[[ $EUID -eq 0 ]] || refuse 'must run in the root test unit'
grep -Eq '(^| )ais\.test=1( |$)' /proc/cmdline || refuse 'kernel test flag absent'
[[ ${1:-} == setup ]] || refuse "usage: $0 setup"

install -d -m 0755 /run/ais-guard-test
mkdir -p "$FIXTURES/aur-src" "$FIXTURES/build" "$REPO"
chmod 0755 /var/tmp/ais-guard-test "$FIXTURES" "$FIXTURES/aur-src"
if [[ ! -d $FIXTURES/build/synthetic-repo-probe ]]; then cp -R "$SOURCES/guard-repo/synthetic-repo-probe" "$FIXTURES/build/"; fi
chown -R agent:agent "$FIXTURES/build"
# shellcheck disable=SC2016
runuser -u agent -- /usr/bin/bash -c 'cd "$1" && /usr/bin/makepkg --nodeps --noconfirm --force --clean >/dev/null' _ "$FIXTURES/build/synthetic-repo-probe"
repo_package=$(find "$FIXTURES/build/synthetic-repo-probe" -maxdepth 1 -type f -name 'synthetic-repo-probe-*.pkg.tar.*' -print -quit)
[[ -n $repo_package ]] || refuse 'synthetic repository package build failed'
install -m 0644 "$repo_package" "$REPO/"
repo-add "$REPO/ais-guard-synthetic.db.tar.gz" "$REPO"/*.pkg.tar.* >/dev/null
if ! grep -q '^\[ais-guard-synthetic\]$' /etc/pacman.conf; then
  printf '\n[ais-guard-synthetic]\nSigLevel = Optional TrustAll\nServer = file://%s\n' "$REPO" >>/etc/pacman.conf
fi
cat >/run/ais-guard-test/pacman-synthetic.conf <<PACMAN
[options]
DBPath = /var/lib/pacman/
Architecture = auto
[ais-guard-synthetic]
SigLevel = Optional TrustAll
Server = file://$REPO
PACMAN
/usr/bin/pacman --config /run/ais-guard-test/pacman-synthetic.conf -Sy --noconfirm
# The scenario runs offline: give the image's own repositories empty sync
# databases so pacman can resolve the synthetic package without a mirror.
for repo in $(/usr/bin/pacman-conf --repo-list); do
  [[ -e /var/lib/pacman/sync/$repo.db ]] || bsdtar -czf "/var/lib/pacman/sync/$repo.db" --files-from /dev/null
done

cp -R "$SOURCES/guard-aur/synthetic-fixture" "$FIXTURES/aur-src/"
chown -R agent:agent "$FIXTURES/aur-src"
if [[ ! -d $FIXTURES/aur-src/synthetic-fixture/.git ]]; then runuser -u agent -- /usr/bin/git -C "$FIXTURES/aur-src/synthetic-fixture" init -q; fi
runuser -u agent -- /usr/bin/git -C "$FIXTURES/aur-src/synthetic-fixture" add PKGBUILD
if ! runuser -u agent -- /usr/bin/git -C "$FIXTURES/aur-src/synthetic-fixture" rev-parse -q --verify HEAD >/dev/null; then runuser -u agent -- /usr/bin/git -C "$FIXTURES/aur-src/synthetic-fixture" -c user.name=SYNTHETIC_FIXTURE -c user.email=SYNTHETIC_FIXTURE@example.invalid commit -qm 'synthetic fixture'; fi
if [[ ! -d $FIXTURES/aur-src/synthetic-fixture.git ]]; then runuser -u agent -- /usr/bin/git clone --bare -q "$FIXTURES/aur-src/synthetic-fixture" "$FIXTURES/aur-src/synthetic-fixture.git"; fi
cat >"$FIXTURES/paru.conf" <<PARU
[options]
AurUrl = file://$FIXTURES/aur-src
PARU
chmod 0644 "$FIXTURES/paru.conf"
chmod -R a+rX "$FIXTURES"
printf 'AIS-GUARD-TEST: case=fixtures status=complete\n'
