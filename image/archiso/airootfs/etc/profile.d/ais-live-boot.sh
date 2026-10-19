# shellcheck shell=bash
if [[ "${USER:-}" == live && -t 0 && -t 1 ]]; then
  export HERDR_CONFIG_PATH=/etc/herdr/config.toml
  umask 077
  case "$(/usr/bin/tty 2>/dev/null)" in
    /dev/tty1) export AIS_LIVE_TTY1_BOOT=1; exec /usr/bin/ais herdr ;;
    /dev/ttyS*) exec /usr/local/lib/ais-live/ais-live-boot ;;
  esac
fi
