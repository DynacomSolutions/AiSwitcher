#!/usr/bin/python3
"""Pure argument policy shared by ais-guardd and its deterministic tests."""

import os
import re
import stat
import unicodedata
from pathlib import Path


_TABLE = Path(__file__).with_name('ais-guard-table')
_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._+-]*$')
_PACKAGE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9@._+-]*$')
_COLUMN_LIST = re.compile(r'^[A-Za-z0-9_,]+$')
_FILESYSTEM_TYPES = re.compile(r'^[A-Za-z0-9_,.-]+$')
_LONG_DEVICE_OPTIONS = {
    '--device', '--disk', '--drive', '--partition', '--target', '--input', '--output',
}
_DEVICE_VALUE_OPTIONS = {'-s', '--device', '--disk', '--drive', '--partition', '--target'}
_PACKAGE_SUFFIXES = ('.pkg.tar', '.pkg.tar.zst', '.pkg.tar.xz', '.pkg.tar.gz', '.pkg.tar.lz4')
_FILE_OUTPUT_OPTIONS = {
    '--output', '--output-file', '--outfile', '--log-file', '--output-log',
    '--backup-file', '--header-backup-file', '--dump-volume-key', '--volume-key-file',
}


def load_commands(tablepath):
    """Read command names from the table, rejecting malformed or duplicate rows."""
    commands = set()
    with open(tablepath, encoding='utf-8') as table:
        for number, line in enumerate(table, 1):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            fields = line.split()
            if len(fields) != 3:
                raise ValueError('invalid guard table row %d' % number)
            name, classification, target_rule = fields
            if not _NAME.fullmatch(name) or name in commands:
                raise ValueError('invalid or duplicate command on guard table row %d' % number)
            if classification != 'destructive' and not classification.startswith('readonly-subcommands:'):
                raise ValueError('invalid classification on guard table row %d' % number)
            if target_rule not in {
                'device-args', 'device-of-equals', 'device-last', 'none',
            }:
                raise ValueError('invalid target rule on guard table row %d' % number)
            if classification.startswith('readonly-subcommands:') and not re.fullmatch(
                r'readonly-subcommands:[A-Za-z0-9_-]+', classification
            ):
                raise ValueError('invalid readonly grammar on guard table row %d' % number)
            commands.add(name)
    return commands


COMMANDS = frozenset(load_commands(_TABLE))


def readonly(name, args):
    """Return true only for the exact popup-free read-only argv grammars."""
    if not isinstance(args, (list, tuple)) or any(not isinstance(x, str) for x in args):
        return False
    a = list(args)
    if name == 'lsblk':
        i = 0
        seen = set()
        switches = {'-a', '-f', '-J', '-l', '-p', '-b', '-n'}
        while i < len(a):
            item = a[i]
            if item in switches and item not in seen:
                seen.add(item)
                i += 1
            elif item == '-o' and '-o' not in seen and i + 1 < len(a) and _COLUMN_LIST.fullmatch(a[i + 1]):
                seen.add('-o')
                i += 2
            else:
                return False
        return True
    if name == 'blkid':
        return not a or len(a) == 2 and a[0] == '-o' and a[1] in {
            'full', 'value', 'device', 'export', 'list', 'udev', 'superblocks', 'default',
        }
    if name == 'findmnt':
        i = 0
        seen = set()
        switches = {'-J', '-l', '-n', '-r'}
        valued = {'-o', '-t', '-S', '-T'}
        while i < len(a):
            item = a[i]
            if item in switches and item not in seen:
                seen.add(item)
                i += 1
                continue
            if item in valued and item not in seen and i + 1 < len(a):
                value = a[i + 1]
                if not value or value.startswith('-') or '\x00' in value:
                    return False
                if item == '-o' and not _COLUMN_LIST.fullmatch(value):
                    return False
                if item == '-t' and not _FILESYSTEM_TYPES.fullmatch(value):
                    return False
                seen.add(item)
                i += 2
                continue
            return False
        return True
    if name == 'parted':
        return (len(a) == 2 and _is_dev_path(a[0]) and a[1] == 'print') or (
            len(a) == 3 and a[0] == '-s' and _is_dev_path(a[1]) and a[2] == 'print'
        )
    if name == 'sfdisk':
        return a == ['-l'] or len(a) == 2 and a[0] == '-l' and _is_dev_path(a[1])
    if name == 'btrfs':
        return len(a) in (2, 3) and a[:2] == ['filesystem', 'show'] and (
            len(a) == 2 or _is_dev_path(a[2])
        )
    if name == 'cryptsetup':
        return len(a) == 2 and a[0] == 'luksDump' and _is_dev_path(a[1])
    return False


def _is_dev_path(path):
    return isinstance(path, str) and path.startswith('/dev/') and '\x00' not in path


_MDADM_ARRAY = re.compile(r'/dev/(md[0-9]+|md/[A-Za-z0-9_.-]+)')


def _mdadm_new_array_index(args):
    """Index of the array operand that follows --create or --build, or None."""
    for i, token in enumerate(args):
        if token in ('--create', '-C', '--build', '-B'):
            for j in range(i + 1, len(args)):
                if not args[j].startswith('-'):
                    return j
            return None
    return None


_MAPPING_NAME = re.compile(r'[A-Za-z0-9_.-]+')


def _cryptsetup_close_mapping(args):
    """Mapping name for cryptsetup close, luksClose or remove, or None."""
    positional = [a for a in args if not a.startswith('-')]
    if len(positional) >= 2 and positional[0] in ('close', 'luksClose', 'remove'):
        name = positional[1]
        if name.startswith('/dev/mapper/'):
            return None
        if not _MAPPING_NAME.fullmatch(name) or name in ('.', '..'):
            raise ValueError('invalid mapping name')
        return name
    return None


_DM_TOOLS = ('cryptsetup', 'dmsetup', 'lvm', 'lvmdevices')
_LV_NAME = re.compile(r'[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+')


def _named_mapping(name, operand):
    """/dev path for a bare device-mapper or LVM name given to a dm tool, or None."""
    if name not in _DM_TOOLS and not name.startswith(('lv', 'pv', 'vg')):
        return None
    if operand in ('.', '..'):
        return None
    if _MAPPING_NAME.fullmatch(operand):
        return '/dev/mapper/' + operand
    if _LV_NAME.fullmatch(operand) and '..' not in operand.split('/'):
        return '/dev/' + operand
    return None


def _candidate_refs(name, args):
    """Yield (index, prefix, path) only for syntactically plausible device operands."""
    refs = []
    i = 0
    while i < len(args):
        token = args[i]
        if name == 'dd' and (token.startswith('if=') or token.startswith('of=')):
            refs.append((i, token[:token.index('=') + 1], token.split('=', 1)[1]))
            i += 1
            continue
        if token.startswith('--') and '=' in token:
            key, value = token.split('=', 1)
            if key in _LONG_DEVICE_OPTIONS and value:
                refs.append((i, key + '=', value))
            i += 1
            continue
        if token in _DEVICE_VALUE_OPTIONS and i + 1 < len(args):
            value = args[i + 1]
            if value and not value.startswith('-'):
                refs.append((i + 1, '', value))
            i += 2
            continue
        if not token.startswith('-') and token not in {'', '.'}:
            # Bare paths are valid device operands too, including a cwd-relative symlink.
            refs.append((i, '', token))
        i += 1
    return refs


def resolve_devices(name, args, cwd):
    """Canonicalise explicit device operands and rewrite only the matched argv tokens.

    Returns (rewritten_args, [(original_path, canonical_path, st_rdev), ...]).
    Character devices such as /dev/null and /dev/zero are intentionally ignored.
    """
    if not isinstance(args, (list, tuple)) or any(not isinstance(x, str) for x in args):
        raise ValueError('invalid argv')
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        raise ValueError('cwd must be absolute')
    rewritten = list(args)
    devices = []
    seen_rdev = set()
    new_array = _mdadm_new_array_index(rewritten) if name == 'mdadm' else None
    mapping = _cryptsetup_close_mapping(rewritten) if name == 'cryptsetup' else None
    for index, prefix, original in _candidate_refs(name, rewritten):
        if not original or '\x00' in original:
            continue
        joined = original if os.path.isabs(original) else os.path.join(cwd, original)
        canonical = os.path.realpath(joined)
        spelled_in_dev = os.path.commonpath(('/dev', os.path.abspath(joined))) == '/dev'
        canonical_in_dev = os.path.isabs(canonical) and os.path.commonpath(('/dev', canonical)) == '/dev'
        if spelled_in_dev and not canonical_in_dev:
            raise ValueError('device symlink escapes /dev')
        # A candidate is a device only when its resolved location is inside /dev.
        try:
            info = os.stat(canonical)
        except OSError:
            # A spelled /dev target that is missing or inaccessible must not fall back
            # to an unprivileged execution path as if it were an ordinary file.
            # mdadm --create and --build name an array that does not exist yet; its members are the approved targets.
            if index == new_array and _MDADM_ARRAY.fullmatch(canonical):
                continue
            if spelled_in_dev:
                raise ValueError('device path does not resolve')
            # dm tools act on mappings by name through /dev/mapper/control, so a
            # bare name must still show its device in the approval.
            mapped = _named_mapping(name, original) if not os.path.isabs(original) else None
            if mapped is None:
                continue
            canonical = os.path.realpath(mapped)
            try:
                info = os.stat(canonical)
            except OSError:
                continue
            if not stat.S_ISBLK(info.st_mode) or os.path.commonpath(('/dev', canonical)) != '/dev':
                raise ValueError('device path does not resolve')
            if int(info.st_rdev) not in seen_rdev:
                devices.append((original, canonical, int(info.st_rdev)))
                seen_rdev.add(int(info.st_rdev))
            continue
        if stat.S_ISBLK(info.st_mode) and not canonical_in_dev:
            raise ValueError('block device outside /dev')
        if not canonical_in_dev or canonical == '/dev':
            continue
        if stat.S_ISCHR(info.st_mode):
            continue
        if not stat.S_ISBLK(info.st_mode):
            continue
        rdev = int(info.st_rdev)
        if index < 0 or index >= len(rewritten):
            raise ValueError('invalid device operand')
        rewritten[index] = prefix + canonical
        if rdev not in seen_rdev:
            devices.append((original, canonical, rdev))
            seen_rdev.add(rdev)
    if mapping is not None:
        # close/luksClose/remove name a mapping, not a path; approve the mapped device without rewriting argv.
        canonical = os.path.realpath('/dev/mapper/' + mapping)
        try:
            info = os.stat(canonical)
        except OSError:
            raise ValueError('device path does not resolve')
        if not stat.S_ISBLK(info.st_mode) or os.path.commonpath(('/dev', canonical)) != '/dev':
            raise ValueError('device path does not resolve')
        if int(info.st_rdev) not in seen_rdev:
            devices.append((mapping, canonical, int(info.st_rdev)))
    return rewritten, devices


def _short(a, letters):
    """True when any single-dash argument bundles a refused letter (-vc, -cfile); over-refuses on purpose."""
    return any(x.startswith('-') and not x.startswith('--') and any(ch in letters for ch in x[1:]) for x in a)


def _long(a, names):
    """True when any --option, or any prefix of one (getopt_long abbreviation), names a refused option."""
    for x in a:
        if x.startswith('--') and len(x) > 2:
            key = x.split('=', 1)[0]
            if any(n.startswith(key) for n in names):
                return True
    return False


def unsafe_options(name, args):
    """Reject root-execution options that write files or expose an escape hatch."""
    if not isinstance(args, (list, tuple)) or any(not isinstance(x, str) for x in args):
        return True
    a = list(args)
    if any('\x00' in x for x in a):
        return True
    longs = {'--config', '--configdir', '--program', '--alert'} | _FILE_OUTPUT_OPTIONS
    shorts = ''
    if name == 'mdadm':
        shorts += 'cp'
    if name in {'fdisk', 'gdisk', 'gdisk64', 'cgdisk', 'cgdisk64', 'parted', 'sfdisk'}:
        shorts += 'c'
        longs |= {'--command'}
        if '!' in a:
            return True
    if name == 'dmsetup':
        longs |= {'--exec'}
    if name == 'cryptsetup':
        shorts += 'd'
        longs |= {'--header', '--key-file', '--keyfile', '--new-keyfile', '--master-key-file',
                  '--dump-volume-key', '--volume-key-file', '--header-backup-file'}
        if a and a[0] == 'luksHeaderBackup':
            return True
    if name == 'mkfs' or name.startswith('mkfs.') or name == 'mke2fs':
        shorts += 'Ed'
    if name in {'sgdisk', 'sgdisk64'}:
        shorts += 'b'
        longs |= {'--backup'}
    if name == 'sfdisk':
        shorts += 'O'
        longs |= {'--backup', '--backup-file'}
    if name == 'e2fsck':
        shorts += 'Ez'
        longs |= {'--output', '--output-log', '--log-file', '--logfile'}
    if name == 'badblocks':
        shorts += 'o'
    if name == 'hdparm':
        longs |= {'--Istdin'}
    return (bool(shorts) and _short(a, shorts)) or _long(a, longs) or 'luksHeaderBackup' in a and name == 'cryptsetup'


def pacman_args(args):
    """Validate pacman argv, returning (route, original pacman argv) or raising ValueError."""
    if not isinstance(args, (list, tuple)) or not args or any(not isinstance(x, str) or '\x00' in x for x in args):
        raise ValueError('invalid pacman argv')
    a = list(args)
    operation = a[0]
    query_operations = {'-Q', '-Qq', '-Qi', '-Qs', '-Ql', '-Qe', '-Qd', '-Qqe', '-Qdt', '-Qm', '-Qn'}
    repository_operations = {'-S', '-Sy', '-Syu', '-Ss', '-Si', '-R', '-Rs', '-Rns'}
    if operation in query_operations:
        if any(not _PACKAGE.fullmatch(x) for x in a[1:]):
            raise ValueError('invalid package query argument')
        return 'query', a
    if operation in repository_operations:
        if any(not _PACKAGE.fullmatch(x) for x in a[1:]):
            raise ValueError('invalid repository package argument')
        return 'repository', a
    if operation == '-U':
        files = a[1:]
        if not files or any(not _is_package_file(x) for x in files):
            raise ValueError('invalid package file argument')
        return 'files', a
    raise ValueError('pacman operation refused')


def _is_package_file(value):
    if not value or value.startswith('-') or '://' in value or '\x00' in value:
        return False
    return any(value.endswith(suffix) for suffix in _PACKAGE_SUFFIXES)


def timeout_for(cmdline):
    """Return 120 s normally; only ais.test=1 can select a bounded test timeout."""
    if isinstance(cmdline, str):
        tokens = cmdline.split()
    elif isinstance(cmdline, (list, tuple)) and all(isinstance(x, str) for x in cmdline):
        tokens = list(cmdline)
    else:
        return 120
    if 'ais.test=1' not in tokens:
        return 120
    configured = 10
    for token in tokens:
        if token.startswith('ais.guard_timeout='):
            value = token.split('=', 1)[1]
            if re.fullmatch(r'[0-9]{1,9}', value):
                configured = int(value)
    return max(1, min(120, configured))


def escape_display(value):
    """Make arguments safe for a terminal popup, including bidi and ANSI controls."""
    result = []
    for char in str(value):
        code = ord(char)
        category = unicodedata.category(char)
        if category in {'Cc', 'Cf', 'Cs', 'Zl', 'Zp'}:
            if code <= 0xff:
                result.append('\\x%02x' % code)
            elif code <= 0xffff:
                result.append('\\u%04x' % code)
            else:
                result.append('\\U%08x' % code)
        else:
            result.append(char)
    return ''.join(result)
