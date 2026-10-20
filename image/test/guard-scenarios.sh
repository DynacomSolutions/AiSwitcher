#!/usr/bin/env bash
set -Eeuo pipefail

readonly SELF=${BASH_SOURCE[0]}
readonly TEST_ROOT=/run/ais-guard-test
readonly REQUESTS=/run/ais-guard/requests
readonly WAIT_BUDGET=${AIS_GUARD_SCENARIO_WAIT:-30}

refuse() { printf 'guard-scenarios: refused: %s\n' "$1" >&2; return 1; }

preflight() {
  [[ $WAIT_BUDGET =~ ^[0-9]+$ ]] && (( WAIT_BUDGET >= 1 && WAIT_BUDGET <= 120 )) || refuse 'scenario wait budget must be 1..120 seconds' || return
  [[ $EUID -eq 0 ]] || refuse 'must run as root from the test unit' || return
  grep -Eq '(^| )ais\.test=1( |$)' /proc/cmdline || refuse 'kernel test flag absent' || return
  [[ -b /dev/vdb && -b /dev/vdc ]] || refuse 'both scratch disks are required' || return
  for disk in /dev/vdb /dev/vdc; do
    [[ $(lsblk -dnro TYPE "$disk") == disk ]] || refuse 'scratch path is not a whole disk' || return
    ! lsblk -nrpo MOUNTPOINT "$disk" | grep -q . || refuse 'scratch disk is mounted' || return
  done
}

run_as_agent() {
  local agent_home
  agent_home=$(getent passwd agent | cut -d: -f6)
  [[ -n $agent_home ]] || refuse 'agent account is absent' || return
  runuser -u agent -- env -i HOME="$agent_home" USER=agent LOGNAME=agent PATH=/usr/local/guard/bin:/usr/local/bin:/usr/bin:/bin "$@"
}

guard_diag() { journalctl -b -u ais-guardd.service --no-pager -o cat 2>/dev/null | tail -n 8 | sed 's/^/AIS-GUARD-DIAG: /'; }
mark() { printf 'AIS-GUARD-TEST: case=%s status=%s\n' "$1" "$2"; }
reset_guard() { systemctl restart ais-guardd.service; }

wait_for_popup_text() {
  local socket_path=$1 deadline=$((SECONDS + WAIT_BUDGET)) snapshot pane_ids pane_id
  while (( SECONDS < deadline )); do
    snapshot=$(runuser -u live -- env HERDR_SOCKET_PATH="$socket_path" herdr api snapshot 2>/dev/null) || { sleep 0.1; continue; }
    # herdr 0.9.3 snapshots carry no plugin pane title, so find the popup by its own banner.
    pane_ids=$(python3 -B -c 'import json,sys; d=json.load(sys.stdin); todo=[d]; out=[]
while todo:
 x=todo.pop()
 if isinstance(x,dict):
  if isinstance(x.get("pane_id"),str): out.append(x["pane_id"])
  todo.extend(x.values())
 elif isinstance(x,list): todo.extend(x)
print(chr(10).join(dict.fromkeys(out)))' <<<"$snapshot") || return 1
    while IFS= read -r pane_id; do
      [[ -n $pane_id ]] || continue
      runuser -u live -- env HERDR_SOCKET_PATH="$socket_path" herdr pane read --source recent --lines 80 --format text "$pane_id" 2>/dev/null | grep -Fq 'AIS DISK APPROVAL' || continue
      if runuser -u live -- env HERDR_SOCKET_PATH="$socket_path" herdr pane wait-output --match 'Type exactly:' --source recent --timeout 900 "$pane_id" >/dev/null 2>&1; then
        GUARD_POPUP_PANE=$pane_id
        return 0
      fi
    done <<<"$pane_ids"
    sleep 0.1
  done
  return 1
}

read_popup_reply() {
  local socket_path=$1 pane_id=$2 snapshot reply
  # The popup deliberately flushes input for one second after displaying the
  # prompt. Read the rendered prompt only after that window has elapsed.
  sleep 1.1
  snapshot=$(runuser -u live -- env HERDR_SOCKET_PATH="$socket_path" herdr pane read --source recent --lines 80 --format text "$pane_id") || return 1
  reply=$(python3 -B -c 'import re,sys
lines=[line for line in sys.stdin.read().splitlines() if "Type exactly: " in line]
if not lines: raise SystemExit(1)
reply=lines[-1].split("Type exactly: ",1)[1]
if not reply or len(reply)>160 or re.fullmatch(r"[A-Za-z0-9 /._-]+",reply) is None: raise SystemExit(1)
print(reply)' <<<"$snapshot") || return 1
  GUARD_POPUP_REPLY=$reply
}

wait_popup() {
  local case_name=$1 deadline=$((SECONDS + WAIT_BUDGET))
  while (( SECONDS < deadline )); do
    if compgen -G "$REQUESTS/*.json" >/dev/null; then
      mark "$case_name" popup
      return 0
    fi
    sleep 0.1
  done
  mark "$case_name" missing-popup
  return 1
}

start_guarded() {
  local case_name=$1 request deadline before="$TEST_ROOT/requests-before"
  shift
  : >"$before"
  if [[ -d $REQUESTS ]]; then find "$REQUESTS" -maxdepth 1 -type f -name '*.json' -printf '%f\n' | sort >"$before"; fi
  run_as_agent "$@" >/dev/null 2>&1 &
  GUARDED_PID=$!
  deadline=$((SECONDS + WAIT_BUDGET))
  while (( SECONDS < deadline )); do
    request=''
    if [[ -d $REQUESTS ]]; then
      while IFS= read -r candidate; do
        if ! grep -Fxq "${candidate##*/}" "$before"; then request=$candidate; break; fi
      done < <(find "$REQUESTS" -maxdepth 1 -type f -name '*.json' -print)
    fi
    if [[ -n $request ]]; then
      if ! wait_for_popup_text "${GUARD_HERDR_SOCKET:?}"; then mark "$case_name" popup-pane-not-found; guard_diag; return 1; fi
      if ! read_popup_reply "${GUARD_HERDR_SOCKET:?}" "$GUARD_POPUP_PANE"; then mark "$case_name" popup-reply-unreadable; return 1; fi
      GUARDED_REQUEST=$request
      mark "$case_name" popup
      printf 'AIS-GUARD-TEST: case=%s status=prompt reply=%s\n' "$case_name" "$GUARD_POPUP_REPLY"
      return 0
    fi
    if ! kill -0 "$GUARDED_PID" 2>/dev/null; then mark "$case_name" exited-before-request; guard_diag; wait "$GUARDED_PID" || return 2; return 2; fi
    sleep 0.1
  done
  mark "$case_name" no-request
  guard_diag
  return 1
}

herdr_socket_path() {
  local live_uid runtime
  live_uid=$(id -u live) || return 1
  runtime="/run/user/$live_uid"
  [[ -d $runtime ]] || return 1
  python3 -B - "$runtime" <<'PY'
import os, stat, sys
paths=[]
for base, dirs, files in os.walk(sys.argv[1]):
    if 'herdr.sock' in files:
        path=os.path.join(base,'herdr.sock')
        try:
            info=os.stat(path)
            if stat.S_ISSOCK(info.st_mode) and info.st_uid == int(os.environ['LIVE_UID']): paths.append(path)
        except OSError: pass
if len(paths) != 1: raise SystemExit(1)
print(paths[0])
PY
}

assert_herdr_denied() {
  local socket_path=$1 operation=$2 pane=$3 output
  if output=$(run_as_agent env HERDR_SOCKET_PATH="$socket_path" herdr pane "$operation" "$pane" x 2>&1); then
    printf 'guard-scenarios: Herdr pane %s unexpectedly succeeded\n' "$operation" >&2
    return 1
  fi
  if [[ $output == *'Permission denied'* || $output == *'permission denied'* || $output == *'EACCES'* ]]; then
    return 0
  fi
  printf 'guard-scenarios: Herdr pane %s failed without a permission-denial response: %s\n' \
    "$operation" "${output:0:240}" >&2
  return 1
}

test_tiocsti_denied() {
  [[ $(cat /proc/sys/dev/tty/legacy_tiocsti) == 0 ]] || return 1
  local request_id
  request_id=${GUARDED_REQUEST##*/}; request_id=${request_id%.json}
  [[ $request_id =~ ^[0-9a-f]{32}$ ]] || return 1
  python3 -B - "$request_id" <<'PYCODE'
import errno, fcntl, os, pwd, sys, termios
rid=sys.argv[1]; live=pwd.getpwnam('live'); agent=pwd.getpwnam('agent'); matches=[]
for entry in os.scandir('/proc'):
    if not entry.name.isdigit(): continue
    try:
        if os.stat(entry.path).st_uid != live.pw_uid: continue
        raw=open(entry.path+'/environ','rb').read().split(b'\0')
        if b'AIS_GUARD_REQ='+rid.encode() not in raw: continue
        args=open(entry.path+'/cmdline','rb').read().split(b'\0')
        if not any(b'ais-guard-popup' in arg for arg in args): continue
        matches.append(int(entry.name))
    except OSError: pass
if len(matches)!=1: raise SystemExit('expected one live approval popup process')
fd=os.open(f'/proc/{matches[0]}/fd/0',os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
if not os.isatty(fd): raise SystemExit('approval popup stdin is not a tty')
pid=os.fork()
if pid==0:
    os.setgroups([]); os.setgid(agent.pw_gid); os.setuid(agent.pw_uid)
    try: fcntl.ioctl(fd,termios.TIOCSTI,b'x')
    except OSError as exc: os._exit(0 if exc.errno in (errno.EPERM,errno.EIO) else 2)
    os._exit(1)
_,status=os.waitpid(pid,0); os.close(fd); raise SystemExit(os.waitstatus_to_exitcode(status))
PYCODE
}

check_pattern() {
  local disk=$1 expected=$2 actual="$TEST_ROOT/actual" want="$TEST_ROOT/expected"
  printf '%s' "$expected" >"$want"
  dd if="$disk" of="$actual" bs=1 skip=4096 count="${#expected}" status=none
  cmp -s "$actual" "$want"
}

run_scenarios() {
  preflight
  mkdir -p "$TEST_ROOT"
  chmod 0700 "$TEST_ROOT"
  install -d -m 0700 "$TEST_ROOT/patterns"
  printf 'AIS_GUARD_VDB_PATTERN_SYNTHETIC_FIXTURE' | dd of=/dev/vdb bs=1 seek=4096 conv=notrunc status=none
  printf 'AIS_GUARD_VDC_PATTERN_SYNTHETIC_FIXTURE' | dd of=/dev/vdc bs=1 seek=4096 conv=notrunc status=none
  printf 'label: dos\nlabel-id: 0x41495346\n' | sfdisk /dev/vdb >/dev/null
  printf 'AIS_GUARD_VDB_PATTERN_SYNTHETIC_FIXTURE' | dd of=/dev/vdb bs=1 seek=4096 conv=notrunc status=none

  local pattern_vdb=AIS_GUARD_VDB_PATTERN_SYNTHETIC_FIXTURE
  local pattern_vdc=AIS_GUARD_VDC_PATTERN_SYNTHETIC_FIXTURE
  mark preconditions ok

  local herdr_socket pane
  LIVE_UID=$(id -u live); export LIVE_UID
  herdr_socket=$(herdr_socket_path) || refuse 'live herdr socket absent' || return
  GUARD_HERDR_SOCKET=$herdr_socket; export GUARD_HERDR_SOCKET
  pane=w1:p1
  assert_herdr_denied "$herdr_socket" send-keys "$pane" || return 1
  assert_herdr_denied "$herdr_socket" send-text "$pane" || return 1
  if output=$(run_as_agent env HERDR_SOCKET_PATH="$herdr_socket" herdr api snapshot 2>&1); then
    printf 'guard-scenarios: Herdr API snapshot unexpectedly succeeded\n' >&2
    return 1
  fi
  if [[ $output != *'Permission denied'* && $output != *'permission denied'* && $output != *'EACCES'* ]]; then
    printf 'guard-scenarios: Herdr API snapshot failed without a permission-denial response: %s\n' \
      "${output:0:240}" >&2
    return 1
  fi
  mark pane-api-denial ok
  run_as_agent python3 -B - "$herdr_socket" <<'PY'
import errno, socket, sys
sock=socket.socket(socket.AF_UNIX)
try: sock.connect(sys.argv[1])
except OSError as exc: raise SystemExit(0 if exc.errno == errno.EACCES else 2)
raise SystemExit(1)
PY
  mark herdr-socket-denial ok

  reset_guard || return 1
  start_guarded unanswered-dd dd if=/dev/zero of=/dev/vdb bs=1 seek=4096 count=16 status=none || return 1
  test_tiocsti_denied || return 1
  mark tiocsti-denial ok
  if wait "$GUARDED_PID"; then return 1; fi
  check_pattern /dev/vdb "$pattern_vdb" || return 1
  check_pattern /dev/vdc "$pattern_vdc" || return 1
  mark unanswered-dd-refusal ok

  reset_guard || return 1
  start_guarded wrong-target dd if=/dev/zero of=/dev/vdb bs=1 seek=4096 count=16 status=none || return 1
  if wait "$GUARDED_PID"; then return 1; fi
  check_pattern /dev/vdb "$pattern_vdb" || return 1
  reset_guard || return 1
  start_guarded right-target dd if=/dev/zero of=/dev/vdb bs=1 seek=4096 count=16 status=none || return 1
  if ! wait "$GUARDED_PID"; then
    mark right-target refused
    guard_diag
    runuser -u live -- env HERDR_SOCKET_PATH="$GUARD_HERDR_SOCKET" herdr pane read --source recent --lines 20 --format text "$GUARD_POPUP_PANE" 2>&1 | sed 's/^/AIS-GUARD-DIAG: pane: /'
    return 1
  fi
  dd if=/dev/vdb of="$TEST_ROOT/actual" bs=1 skip=4096 count=16 status=none
  dd if=/dev/zero of="$TEST_ROOT/expected" bs=1 count=16 status=none
  cmp -s "$TEST_ROOT/actual" "$TEST_ROOT/expected" || return 1
  mark typed-target-write ok
  printf '%s' "$pattern_vdb" | dd of=/dev/vdb bs=1 seek=4096 conv=notrunc status=none

  if run_as_agent /usr/bin/dd if=/dev/zero of=/dev/vdb bs=1 seek=4096 count=8 status=none >/dev/null 2>&1; then return 1; fi
  check_pattern /dev/vdb "$pattern_vdb" || return 1
  mark absolute-path-denial ok

  for spec in 'mkfs.ext4 /dev/vdb' 'wipefs --all /dev/vdb' 'sgdisk --zap-all /dev/vdb' 'cryptsetup luksFormat /dev/vdb'; do
    read -r -a argv <<<"$spec"
    reset_guard || return 1
    start_guarded destructive-tool "${argv[@]}" || return 1
    if wait "$GUARDED_PID"; then return 1; fi
    check_pattern /dev/vdb "$pattern_vdb" || return 1
  done
  check_pattern /dev/vdb "$pattern_vdb" || return 1
  mark destructive-tools-refuse ok

  run_as_agent lsblk >/dev/null || return 1
  run_as_agent parted /dev/vdb print >/dev/null || return 1
  mark read-only-commands ok

  if run_as_agent sudo -n true >/dev/null 2>&1; then return 1; else mark sudo-refusal ok; fi

  local fixture_dir=${AIS_GUARD_FIXTURE_DIR:-/var/tmp/ais-guard-test/fixtures}
  local agent_home agent_cache
  agent_home=$(getent passwd agent | cut -d: -f6)
  [[ -n $agent_home ]] || refuse 'agent account is absent' || return
  agent_cache=$agent_home/.cache
  [[ -d $fixture_dir ]] || refuse 'synthetic package fixtures are required' || return
  if [[ -d $fixture_dir ]]; then
    printf 'y\n' | run_as_agent env PARU_CONF="$fixture_dir/paru.conf" pacman -S synthetic-repo-probe >/dev/null 2>&1 || return 1
    mark pacman-repository-install ok
    reset_guard || return 1
    before_aur="$TEST_ROOT/aur-before"
    run_as_agent mkdir -p "$agent_cache"
    find "$agent_cache" -type f -name '*.pkg.tar.*' -printf '%p\n' | sort >"$before_aur"
    start_guarded aur-install env PARU_CONF="$fixture_dir/paru.conf" paru -S synthetic-fixture || return 1
    new_archive=$(find "$agent_cache" -type f -name '*.pkg.tar.*' -print | while IFS= read -r path; do grep -Fxq "$path" "$before_aur" || { printf '%s\n' "$path"; break; }; done)
    [[ -n $new_archive ]] || return 1
    printf 'SYNTHETIC_FIXTURE replacement payload\n' >"$new_archive"
    mark aur-install reply
    wait "$GUARDED_PID" || return 1
    /usr/bin/pacman -Q synthetic-fixture >/dev/null || return 1
    mark pacman-and-aur-gate ok
  fi

  reset_guard || return 1
  start_guarded raw-read-refusal dd if=/dev/vdb of="$TEST_ROOT/raw-read" bs=512 count=1 status=none || return 1
  if wait "$GUARDED_PID"; then return 1; fi
  check_pattern /dev/vdb "$pattern_vdb" || return 1
  check_pattern /dev/vdc "$pattern_vdc" || return 1
  mark raw-read-refusal ok

  for args in '--config /dev/null' '--hookdir /var/tmp' '--gpgdir /var/tmp' '--dbpath /var/tmp' '--root /var/tmp' '--cachedir /var/tmp' '-S ./x.pkg.tar.zst' '-S file:///var/tmp/pkg'; do
    read -r -a argv <<<"$args"
    if run_as_agent pacman "${argv[@]}" >/dev/null 2>&1; then return 1; fi
  done
  mark pacman-dangerous-flags ok

  ln -sfn /dev/vdb /dev/ais-guard-test-target
  reset_guard || return 1
  start_guarded symlink-swap dd if=/dev/zero of=/dev/ais-guard-test-target bs=1 seek=4096 count=16 status=none || return 1
  ln -sfn /dev/vdc /dev/ais-guard-test-target
  mark symlink-swap-target-flipped ok
  wait "$GUARDED_PID" || return 1
  rm /dev/ais-guard-test-target
  check_pattern /dev/vdc "$pattern_vdc" || return 1
  dd if=/dev/vdb of="$TEST_ROOT/actual" bs=1 skip=4096 count=16 status=none
  dd if=/dev/zero of="$TEST_ROOT/expected" bs=1 count=16 status=none
  cmp -s "$TEST_ROOT/actual" "$TEST_ROOT/expected" || return 1
  mark symlink-swap canonical-target-preserved
  mark all complete
}

# Sandbox probe (review item 8). Each approved write run must succeed inside the
# per-tool sandbox: mdadm needs writable sysfs, cryptsetup needs
# /dev/mapper/control and /run/cryptsetup. A failure means the guard fails closed
# but is too tight. Needs a booted image with the scratch disks; the host driver
# must type each popup reply when it sees "AIS-GUARD-TEST: case=... status=reply".
probe_approved() {
  local case_name=$1
  shift
  reset_guard || return 1
  start_guarded "$case_name" "$@" || return 1
  mark "$case_name" reply
  wait "$GUARDED_PID" || { mark "$case_name" failed; return 1; }
  mark "$case_name" ok
}

sandbox_probe() {
  preflight || return
  mkdir -p "$TEST_ROOT"
  local loop_b loop_c
  loop_b=$(losetup --find --show /dev/vdb) || return 1
  loop_c=$(losetup --find --show /dev/vdc) || return 1
  # shellcheck disable=SC2064
  trap "mdadm --stop /dev/md/aisprobe >/dev/null 2>&1; losetup -d '$loop_b' '$loop_c' >/dev/null 2>&1" RETURN
  GUARD_HERDR_SOCKET=$(LIVE_UID=$(id -u live) herdr_socket_path) || refuse 'live herdr socket absent' || return
  export GUARD_HERDR_SOCKET
  probe_approved mdadm-create mdadm --create /dev/md/aisprobe --run --level=1 --raid-devices=2 --metadata=1.2 "$loop_b" "$loop_c" || return 1
  probe_approved mdadm-stop mdadm --stop /dev/md/aisprobe || return 1
  # cryptsetup reads the key from stdin through the passed descriptor.
  probe_approved luks-format bash -c "printf '%s' aisprobe-key | cryptsetup luksFormat --batch-mode --type luks2 --pbkdf pbkdf2 /dev/vdb -" || return 1
  probe_approved luks-open bash -c "printf '%s' aisprobe-key | cryptsetup open /dev/vdb aisprobe -" || return 1
  [[ -b /dev/mapper/aisprobe ]] || return 1
  probe_approved luks-close cryptsetup close aisprobe || return 1
  # TODO(coordinator): lvm pvcreate/vgcreate on /dev/vdc and dmsetup ls once the
  # host driver can answer two popups in sequence; confirm /run/lock/lvm is enough.
  mark sandbox-probe complete
}

case "${1:-}" in
  --preflight-only) preflight ;;
  --sandbox-probe) sandbox_probe ;;
  --run) run_scenarios ;;
  *) printf 'usage: %s --preflight-only|--run\n' "$SELF" >&2; exit 2 ;;
esac
