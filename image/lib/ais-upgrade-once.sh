#!/bin/bash

ais_upgrade_once() {
  local state_file=$1
  shift
  [[ "$#" -gt 0 ]] || return 2
  [[ -e "$state_file" ]] && return 0
  "$@" || return $?
  /usr/bin/install -d -m 0700 "${state_file%/*}"
  /usr/bin/install -m 0600 /dev/null "$state_file"
}
