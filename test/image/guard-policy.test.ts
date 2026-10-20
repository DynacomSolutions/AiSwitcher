import { expect, test } from "bun:test";

const policyProbe = String.raw`
import os, stat, sys, tempfile, types
sys.path.insert(0, 'image/lib')
import ais_guard_policy as p

assert p.readonly('lsblk', [])
assert p.readonly('lsblk', ['-J', '-o', 'NAME,SIZE,TYPE'])
assert not p.readonly('lsblk', ['--output', 'NAME'])
assert not p.readonly('lsblk', ['-o', 'NAME', '/dev/sda'])
assert p.readonly('blkid', [])
assert p.readonly('blkid', ['-o', 'value'])
assert not p.readonly('blkid', ['-o', 'value', '/dev/sda'])
assert p.readonly('findmnt', ['-o', 'SOURCE,TARGET', '-t', 'ext4,btrfs'])
assert not p.readonly('findmnt', ['--source', '/dev/sda'])
assert not p.readonly('findmnt', ['-o', 'SOURCE', '-o', 'TARGET'])
assert p.readonly('parted', ['/dev/sda', 'print'])
assert p.readonly('parted', ['-s', '/dev/sda', 'print'])
assert not p.readonly('parted', ['-s', '/dev/sda', 'print', 'rm', '1'])
assert p.readonly('sfdisk', ['-l', '/dev/sda'])
assert not p.readonly('sfdisk', ['--list', '/dev/sda'])
assert p.readonly('btrfs', ['filesystem', 'show', '/dev/sda1'])
assert not p.readonly('btrfs', ['filesystem', 'show', '--all-devices'])
assert p.readonly('cryptsetup', ['luksDump', '/dev/sda1'])
assert not p.readonly('cryptsetup', ['luksDump', '--dump-volume-key', '/dev/sda1'])

assert p.unsafe_options('dmsetup', ['--exec=/bin/sh'])
assert p.unsafe_options('mdadm', ['--monitor', '--program=/tmp/x', '/dev/md0'])
assert p.unsafe_options('mdadm', ['--monitor', '--alert', '/tmp/x'])
assert p.unsafe_options('mdadm', ['-c', '/tmp/mdadm.conf', '--assemble', '/dev/md0'])
assert p.unsafe_options('lvcreate', ['--config', 'global{}', '/dev/vg'])
assert p.unsafe_options('lvm', ['--configdir=/tmp/x', 'lvs'])
assert not p.unsafe_options('mdadm', ['--detail', '/dev/md0'])
assert p.unsafe_options('mdadm', ['-vc', '/tmp/x.conf', '/dev/md0'])
assert p.unsafe_options('mdadm', ['-c/tmp/x.conf', '/dev/md0'])
assert p.unsafe_options('cryptsetup', ['-vd', '/tmp/k', 'open', '/dev/sda', 'x'])
assert p.unsafe_options('sgdisk', ['-vb/tmp/g', '/dev/sda'])
assert p.unsafe_options('sfdisk', ['-fO', '/tmp/b', '/dev/sda'])
assert p.unsafe_options('e2fsck', ['-pz', '/tmp/u', '/dev/sda'])
assert p.unsafe_options('e2fsck', ['-fE', 'journal_only', '/dev/sda'])
assert p.unsafe_options('badblocks', ['-vo', '/tmp/o', '/dev/sda'])
assert p.unsafe_options('mkfs.ext4', ['-qd', '/root', '/dev/sda'])
assert p.unsafe_options('fdisk', ['-vc', '/dev/sda'])
assert not p.unsafe_options('e2fsck', ['-fp', '/dev/sda'])
assert p.unsafe_options('mdadm', ['-p', '/usr/bin/sh', '--monitor', '/dev/md0'])
assert p.unsafe_options('mdadm', ['--prog=/usr/bin/sh', '--monitor'])
assert p.unsafe_options('mdadm', ['--ale', '/usr/bin/sh'])
assert p.unsafe_options('lvchange', ['--conf', 'x', '/dev/vg/lv'])
assert p.unsafe_options('lvchange', ['--configd=/tmp/x', '/dev/vg/lv'])
assert p.unsafe_options('cryptsetup', ['--key-f=/tmp/k', 'open', '/dev/sda', 'x'])
assert p.unsafe_options('dmsetup', ['--ex=/bin/sh'])
assert not p.unsafe_options('lvchange', ['--activate', 'y', '/dev/vg/lv'])
assert p.unsafe_options('cryptsetup', ['luksOpen', '--key-file=/secret', '/dev/sda', 'x'])
assert p.unsafe_options('cryptsetup', ['luksHeaderBackup', '/dev/sda', '--header-backup-file', '/tmp/h'])
assert p.unsafe_options('cryptsetup', ['luksHeaderBackup', '/dev/sda', '--header-backup-file=/tmp/h'])
assert p.unsafe_options('sfdisk', ['--backup-file=/tmp/x', '/dev/sda'])
assert p.unsafe_options('sgdisk', ['--backup', '/tmp/gpt.bin', '/dev/sda'])
assert p.unsafe_options('sgdisk64', ['-b/tmp/gpt.bin', '/dev/sda'])
assert p.unsafe_options('mkfs.ext4', ['-E', 'root_owner=0', '/dev/sda'])
assert p.unsafe_options('mkfs.ext4', ['-d', '/root', '/dev/sda'])
assert p.unsafe_options('mke2fs', ['-E', 'root_owner=0', '/dev/sda'])
assert p.unsafe_options('mke2fs', ['-d', '/root', '/dev/sda'])
assert p.unsafe_options('mkfs.f2fs', ['-E', '/root', '/dev/sda'])
assert p.unsafe_options('e2fsck', ['-E', 'journal_only', '/dev/sda'])
assert p.unsafe_options('e2fsck', ['--log-file=/tmp/log', '/dev/sda'])
assert p.unsafe_options('badblocks', ['-o', '/tmp/out', '/dev/sda'])
assert p.unsafe_options('resize2fs', ['--output=/tmp/out', '/dev/sda'])
assert p.unsafe_options('tune2fs', ['--log-file', '/tmp/log', '/dev/sda'])
assert not p.unsafe_options('dumpe2fs', ['-o', 'superblock=1', '/dev/sda'])
assert p.unsafe_options('hdparm', ['--Istdin', '/dev/sda'])
assert not p.unsafe_options('hdparm', ['--security-erase', 'password', '/dev/sda'])
assert p.unsafe_options('fdisk', ['!', '/dev/sda'])
assert not p.unsafe_options('dd', ['if=/dev/zero', 'of=./file'])

assert p.pacman_args(['-S', 'vim']) == ('repository', ['-S', 'vim'])
assert p.pacman_args(['-Sy', 'vim']) == ('repository', ['-Sy', 'vim'])
assert p.pacman_args(['-Syu', 'vim']) == ('repository', ['-Syu', 'vim'])
for operation in ('-S', '-Sy', '-Syu', '-Ss', '-Si', '-R', '-Rs', '-Rns'):
    assert p.pacman_args([operation, 'vim']) == ('repository', [operation, 'vim'])
assert p.pacman_args(['-Q', 'vim']) == ('query', ['-Q', 'vim'])
for operation in ('-Q', '-Qq', '-Qi', '-Qs', '-Ql', '-Qe', '-Qd', '-Qqe', '-Qdt', '-Qm', '-Qn'):
    assert p.pacman_args([operation, 'vim']) == ('query', [operation, 'vim'])
assert p.pacman_args(['-U', 'pkg-1-1-x86_64.pkg.tar.zst']) == ('files', ['-U', 'pkg-1-1-x86_64.pkg.tar.zst'])
for flag in ('--config', '--hookdir', '--gpgdir', '--dbpath', '--root', '--cachedir', '--sysroot', '--logfile', '--overwrite'):
    args = ['-S', flag, 'value']
    try: p.pacman_args(args)
    except ValueError: pass
    else: raise AssertionError('pacman accepted forbidden C3 flag: %r' % (args,))
for args in (['--config', '/tmp/pacman.conf'], ['-S', './x.pkg.tar.zst'], ['-S', 'https://example.invalid/x'], ['-U', 'https://example.invalid/x.pkg.tar.zst'], ['-S', '--unknown']):
    try: p.pacman_args(args)
    except ValueError: pass
    else: raise AssertionError('pacman accepted unsafe argv: %r' % (args,))

assert p.timeout_for(['ais.test=1']) == 10
assert p.timeout_for(['ais.test=1', 'ais.guard_timeout=999']) == 120
assert p.timeout_for(['ais.test=1', 'ais.guard_timeout=0']) == 1
assert p.timeout_for(['ais.guard_timeout=1']) == 120
assert p.escape_display('x\x1b\n\u202e') == r'x\x1b\x0a\u202e'

old_path, old_stat = p.os.path, p.os.stat
class FakePath:
    @staticmethod
    def realpath(path):
        return {
            '/work/link': '/dev/mockblk',
            '/work/relative-link': '/dev/mockblk',
            '/dev/escape': '/outside/file',
            '/dev/mapper/vault': '/dev/mockblk2',
        }.get(path, path)
    @staticmethod
    def join(*paths): return old_path.join(*paths)
    @staticmethod
    def isabs(path): return old_path.isabs(path)
    @staticmethod
    def commonpath(paths): return old_path.commonpath(paths)
    @staticmethod
    def abspath(path): return old_path.abspath(path)

def fake_stat(path):
    if path == '/dev/mockblk': return types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=77)
    if path == '/dev/mockblk2': return types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=78)
    if path == '/dev/partition1': return types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=91)
    if path == '/dev/partition2': return types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=92)
    if path == '/dev/zero': return types.SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=5)
    if path == '/outside/block': return types.SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=88)
    raise FileNotFoundError(path)
p.os.path, p.os.stat = FakePath, fake_stat
try:
    argv, devices = p.resolve_devices('dd', ['if=/dev/zero', 'of=/work/link'], '/work')
    assert argv == ['if=/dev/zero', 'of=/dev/mockblk']
    assert devices == [('/work/link', '/dev/mockblk', 77)]
    argv, devices = p.resolve_devices('dd', ['if=/dev/zero', 'of=relative-link'], '/work')
    assert argv == ['if=/dev/zero', 'of=/dev/mockblk']
    assert devices == [('relative-link', '/dev/mockblk', 77)]
    argv, devices = p.resolve_devices('hdparm', ['-s', '/dev/mockblk'], '/work')
    assert argv == ['-s', '/dev/mockblk']
    assert devices == [('/dev/mockblk', '/dev/mockblk', 77)]
    argv, devices = p.resolve_devices('mdadm', ['--create', '/dev/md/new', '--level=1', '/dev/mockblk', '/dev/mockblk2'], '/work')
    assert argv == ['--create', '/dev/md/new', '--level=1', '/dev/mockblk', '/dev/mockblk2']
    assert devices == [('/dev/mockblk', '/dev/mockblk', 77), ('/dev/mockblk2', '/dev/mockblk2', 78)]
    for bad in (['--stop', '/dev/md/missing'], ['--create', '/dev/md/new', '/dev/missing'], ['--create', '/dev/sdz', '/dev/mockblk']):
        try:
            p.resolve_devices('mdadm', bad, '/work')
            raise AssertionError(bad)
        except ValueError as e:
            assert str(e) == 'device path does not resolve', (bad, e)
    argv, devices = p.resolve_devices('cryptsetup', ['close', 'vault'], '/work')
    assert argv == ['close', 'vault'] and devices == [('vault', '/dev/mockblk2', 78)]
    for bad, why in ((['close', 'gone'], 'device path does not resolve'), (['luksClose', '../x'], 'invalid mapping name')):
        try:
            p.resolve_devices('cryptsetup', bad, '/work')
            raise AssertionError(bad)
        except ValueError as e:
            assert str(e) == why, (bad, e)
    argv, devices = p.resolve_devices('cat', ['/dev/mockblk', '/dev/mockblk2'], '/work')
    assert argv == ['/dev/mockblk', '/dev/mockblk2']
    assert devices == [('/dev/mockblk', '/dev/mockblk', 77), ('/dev/mockblk2', '/dev/mockblk2', 78)]
    argv, devices = p.resolve_devices('cat', ['/dev/partition1', '/dev/partition2'], '/work')
    assert argv == ['/dev/partition1', '/dev/partition2']
    assert devices == [('/dev/partition1', '/dev/partition1', 91), ('/dev/partition2', '/dev/partition2', 92)]
    argv, devices = p.resolve_devices('nvme', ['--device=/dev/mockblk'], '/work')
    assert argv == ['--device=/dev/mockblk']
    assert devices == [('/dev/mockblk', '/dev/mockblk', 77)]
    argv, devices = p.resolve_devices('cat', ['/dev/mockblk', '/dev/mockblk'], '/work')
    assert len(devices) == 1 and argv == ['/dev/mockblk', '/dev/mockblk']
    try: p.resolve_devices('cat', ['/dev/escape'], '/work')
    except ValueError: pass
    else: raise AssertionError('accepted /dev symlink escaping /dev')
    try: p.resolve_devices('cat', ['/outside/block'], '/work')
    except ValueError: pass
    else: raise AssertionError('accepted block device outside /dev')
finally:
    p.os.path, p.os.stat = old_path, old_stat

assert p.COMMANDS == p.load_commands('image/lib/ais-guard-table')
assert {'partclone.apfs', 'partclone.ocfs2', 'mkfs.f2fs', 'mkfs.udf', 'mke2fs', 'lsblk'} <= p.COMMANDS
`;

test("guard policy refuses unsafe argv and resolves only canonical /dev targets", () => {
  const result = Bun.spawnSync(["python3", "-B", "-c", policyProbe], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
});
