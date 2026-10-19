# shellcheck shell=bash
if [ "$(id -un 2>/dev/null)" = agent ]; then
  PATH=/usr/local/guard/bin:$PATH
  export PATH
fi
