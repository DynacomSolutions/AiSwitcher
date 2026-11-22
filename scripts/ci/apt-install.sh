#!/usr/bin/env bash
# Installs Ubuntu packages on a CI runner: apt-install.sh [apt-get install flags] <packages...>
#
# GitHub-hosted runners have had stretches where every Ubuntu archive host
# fails DNS ("Temporary failure resolving") while every other host resolves.
# apt-get update only warns on a failed fetch, so the install then fails on
# missing indexes. When the default mirrors cannot be fetched, this points apt
# at a public mirror outside the Ubuntu archive domain and tries again.
#
# A stalled apt-get once hung a job for 90 minutes. Every apt-get call has
# fetch retries, network timeouts and an overall time limit, so a stall fails
# the attempt instead of the job.
set -euo pipefail

FALLBACK_MIRROR="${APT_FALLBACK_MIRROR:-https://mirrors.edge.kernel.org/ubuntu/}"
APT_UPDATE_LIMIT="${APT_UPDATE_LIMIT:-300}"
APT_INSTALL_LIMIT="${APT_INSTALL_LIMIT:-900}"
APT_OPTIONS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

update() {
  local log
  log="$(mktemp)"
  # A stall or other failure (timeout exits 124) fails this attempt.
  if ! sudo timeout -k 30 "$APT_UPDATE_LIMIT" apt-get "${APT_OPTIONS[@]}" update 2>&1 | tee "$log"; then
    echo "::warning::apt-get update failed or exceeded ${APT_UPDATE_LIMIT} s"
    rm -f "$log"
    return 1
  fi
  # A partial update exits 0 with "W: Failed to fetch"; treat it as a failure.
  if grep -qE '^(W|E): (Failed to fetch|Some index files failed)' "$log"; then
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

use_fallback_mirror() {
  echo "::warning::Ubuntu mirrors unreachable; switching apt to ${FALLBACK_MIRROR}"
  # mirror+file lists (the runner default) and plain URIs/deb lines, both
  # deb822 (.sources) and one-line (.list) formats.
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    echo "${FALLBACK_MIRROR}" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
  fi
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$file" ] || continue
    sudo sed -E -i \
      -e "s#mirror\+file:/etc/apt/apt-mirrors\.txt#${FALLBACK_MIRROR}#g" \
      -e "s#https?://([a-z0-9-]+\.)*(archive|security)\.ubuntu\.com/ubuntu/?( |$)#${FALLBACK_MIRROR}\3#g" \
      "$file"
  done
}

attempt=1
until update; do
  if [ "$attempt" -eq 1 ]; then
    use_fallback_mirror
  elif [ "$attempt" -ge 3 ]; then
    echo "::error::apt-get update failed on the default and fallback mirrors"
    exit 1
  else
    sleep 10
  fi
  attempt=$((attempt + 1))
done

sudo timeout -k 30 "$APT_INSTALL_LIMIT" apt-get "${APT_OPTIONS[@]}" install -y "$@"
