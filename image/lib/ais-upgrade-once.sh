#!/bin/bash

ais_upgrade_once() (
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
  "$@" || return $?
  /usr/bin/install -m 0600 /dev/null "$state_file"
)
