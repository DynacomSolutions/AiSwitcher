"""Validate every model before it can be exposed through the read-only bind."""

import hashlib
import json
import os
import pathlib
import shutil
import stat


def validate(source, home, home_uid, cache_uid, use_cache=True):
    flags_dir = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags_file = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK

    def checked_file(directory_fd, name):
        fd = os.open(name, flags_file, dir_fd=directory_fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(fd)
            raise ValueError("not a regular file")
        return fd, info

    source_fd = os.open(source, flags_dir)
    manifest_fd, manifest_info = checked_file(source_fd, "manifest.json")
    if manifest_info.st_size > 1024 * 1024:
        raise ValueError("manifest too large")
    with os.fdopen(manifest_fd, "rb") as stream:
        manifest_bytes = stream.read(1024 * 1024 + 1)
    manifest = json.loads(manifest_bytes)
    entries = manifest.get("files") if isinstance(manifest, dict) else None
    if entries is None and isinstance(manifest, dict):
        entries = [manifest]
    if not isinstance(entries, list) or not entries:
        raise ValueError("manifest has no files")

    expected_names = {"manifest.json"}
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid manifest entry")
        name, expected, size = entry["file"], entry["sha256"], entry["size"]
        if (not isinstance(name, str) or pathlib.PurePosixPath(name).name != name
                or name in ("", ".", "..") or name in expected_names):
            raise ValueError("invalid or duplicate model filename")
        if (not isinstance(expected, str) or len(expected) != 64
                or any(c not in "0123456789abcdef" for c in expected)):
            raise ValueError("invalid model digest")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError("invalid model size")
        expected_names.add(name)
        normalized.append((name, expected, size))
    if set(os.listdir(source_fd)) != expected_names:
        raise ValueError("unlisted exchange files are not exposed")

    home_fd = os.open(home, flags_dir)
    if os.fstat(home_fd).st_uid != home_uid:
        raise ValueError("unexpected agent home owner")
    try:
        os.mkdir(".ais-live-model-cache", 0o700, dir_fd=home_fd)
    except FileExistsError:
        pass
    cache_fd = os.open(".ais-live-model-cache", flags_dir, dir_fd=home_fd)
    cache_info = os.fstat(cache_fd)
    if cache_info.st_uid != cache_uid or cache_info.st_mode & 0o077:
        os.close(cache_fd)
        raise ValueError("untrusted cache directory")

    cached = None
    try:
        cache_file_fd, cache_info = checked_file(cache_fd, "manifest.json")
        if cache_info.st_uid == cache_uid and not cache_info.st_mode & 0o077 and cache_info.st_size <= 1024 * 1024:
            with os.fdopen(cache_file_fd, "r", encoding="utf-8") as stream:
                cached = json.load(stream)
        else:
            os.close(cache_file_fd)
    except FileNotFoundError:
        pass
    manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
    cached_by_name = {}
    if use_cache and isinstance(cached, dict) and cached.get("manifestSha256") == manifest_digest:
        cached_by_name = {row.get("file"): row for row in cached.get("files", []) if isinstance(row, dict)}

    records = []
    for name, expected, size in normalized:
        fd, info = checked_file(source_fd, name)
        before = (info.st_size, info.st_mtime_ns)
        if info.st_size != size:
            os.close(fd)
            raise ValueError("model size mismatch")
        record = {"file": name, "sha256": expected, "size": info.st_size, "mtime_ns": info.st_mtime_ns}
        if cached_by_name.get(name) != record:
            digest = hashlib.sha256()
            with os.fdopen(fd, "rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
                after = os.fstat(stream.fileno())
            if (after.st_size, after.st_mtime_ns) != before or digest.hexdigest() != expected:
                raise ValueError("model digest mismatch or concurrent change")
        else:
            os.close(fd)
        records.append(record)

    payload = json.dumps({"manifestSha256": manifest_digest, "files": records}, separators=(",", ":")).encode() + b"\n"
    temporary = ".manifest." + str(os.getpid()) + ".tmp"
    out_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=cache_fd)
    with os.fdopen(out_fd, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, "manifest.json", src_dir_fd=cache_fd, dst_dir_fd=cache_fd)
    os.fsync(cache_fd)
    os.close(cache_fd)
    os.close(home_fd)
    os.close(source_fd)


def stage_verified(source, destination, validation_home, home_uid, cache_uid, owner_uid=None, owner_gid=None):
    """Copy privately, validate copied bytes without cache, then publish modes."""
    owner_uid = os.getuid() if owner_uid is None else owner_uid
    owner_gid = os.getgid() if owner_gid is None else owner_gid
    if os.path.lexists(destination):
        if os.path.islink(destination) or not os.path.isdir(destination):
            raise ValueError("unsafe staging destination")
        shutil.rmtree(destination)
    os.mkdir(destination, 0o700)
    try:
        shutil.copytree(source, destination, dirs_exist_ok=True, symlinks=True)
        os.chmod(destination, 0o700, follow_symlinks=False)
        validate(destination, validation_home, home_uid, cache_uid, use_cache=False)
        for root, directories, files in os.walk(destination, topdown=True, followlinks=False):
            os.chown(root, owner_uid, owner_gid, follow_symlinks=False)
            os.chmod(root, 0o755, follow_symlinks=False)
            for name in directories:
                path = os.path.join(root, name)
                if os.path.islink(path):
                    continue
                os.chown(path, owner_uid, owner_gid, follow_symlinks=False)
                os.chmod(path, 0o755, follow_symlinks=False)
            for name in files:
                path = os.path.join(root, name)
                if os.path.islink(path):
                    continue
                os.chown(path, owner_uid, owner_gid, follow_symlinks=False)
                os.chmod(path, 0o644, follow_symlinks=False)
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise
