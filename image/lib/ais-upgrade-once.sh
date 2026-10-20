#!/bin/bash

ais_upgrade_boot_id() {
  /usr/bin/cat /proc/sys/kernel/random/boot_id
}

ais_upgrade_once() (
  umask 077
  local state_file=$1
  shift
  [[ "$#" -gt 0 ]] || return 2
  local state_dir lock_file lock_fd
  state_dir=${state_file%/*}
  lock_file="$state_file.lock"
  /usr/bin/install -d -m 0700 "$state_dir" || return $?
  exec {lock_fd}>"$lock_file" || return $?
  /usr/bin/flock -x "$lock_fd" || return $?
  [[ -e "$state_file" ]] && return 0

  local boot_id previous_boot='' attempt_file="$state_file.attempt"
  boot_id=$(ais_upgrade_boot_id) || return $?
  [[ -n "$boot_id" ]] || return 1
  [[ ! -f "$attempt_file" ]] || read -r previous_boot <"$attempt_file" || true
  # tty1, serial and restarted consoles share one result for this boot. Record
  # the attempt before launch so a failed or interrupted install waits for reboot.
  [[ "$previous_boot" != "$boot_id" ]] || return 1
  printf '%s\n' "$boot_id" >"$attempt_file" || return $?
  "$@" || return $?
  /usr/bin/install -m 0600 /dev/null "$state_file"
)
