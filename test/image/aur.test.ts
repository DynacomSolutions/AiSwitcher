import { describe, expect, test } from "bun:test";

const script = "image/lib/ais-aur";

function runPython(source: string) {
  const result = Bun.spawnSync(["python3", "-B", "-c", source], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("ais-aur", () => {
  test("accepts package installs and keeps --noconfirm from skipping approval", () => {
    const result = runPython(`
import runpy
module = runpy.run_path(${JSON.stringify(script)})
parse = module["parse_args"]
assert parse(["-S", "synthetic-fixture"]) == ["synthetic-fixture"]
assert parse(["-S", "foo", "bar", "--noconfirm"]) == ["foo", "bar"]
assert parse(["-G", "synthetic-fixture"]) is None
assert parse(["-S", "foo", "--config=/tmp/x"]) is None
assert parse(["-S", "../foo"]) is None
assert parse(["-S", "foo", "foo"]) is None
`);
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("builds as the caller and requests separate typed approvals for every archive", () => {
    const result = runPython(`
import runpy
from types import SimpleNamespace
from unittest.mock import patch
module = runpy.run_path(${JSON.stringify(script)})
events = []
def fake_run(argv, **kwargs):
    events.append((argv, kwargs))
    if argv[:2] == [module["MAKEPKG"], "--printsrcinfo"]:
        return SimpleNamespace(returncode=0, stdout="pkgbase = synthetic-fixture\\npkgname = synthetic-fixture\\nsource = SYNTHETIC_FIXTURE_SOURCE.tar\\n")
    if argv[:2] == [module["MAKEPKG"], "--packagelist"]:
        return SimpleNamespace(returncode=0, stdout="synthetic-fixture.pkg.tar.zst\\nsynthetic-fixture-extra.pkg.tar.zst\\n")
    if argv[:2] == [module["PACMAN"], "-Qp"]:
        name = "synthetic-fixture-extra" if "extra" in argv[-1] else "synthetic-fixture"
        return SimpleNamespace(returncode=0, stdout=name + " 1.0-1\\n")
    return SimpleNamespace(returncode=0, stdout="")
with patch.dict(module["main"].__globals__, {"run": fake_run}), \\
     patch.object(module["os"], "geteuid", return_value=1000), \\
     patch.object(module["pwd"], "getpwnam", return_value=SimpleNamespace(pw_uid=1000)), \\
     patch.object(module["pwd"], "getpwuid", return_value=SimpleNamespace(pw_dir="/agent")), \\
     patch.object(module["os"], "makedirs"), \\
     patch.object(module["tempfile"], "mkdtemp", return_value="/agent/build-unique"), \\
     patch.object(module["os"].path, "lexists", return_value=False), \\
     patch.object(module["os"].path, "islink", return_value=False), \\
     patch.object(module["os"].path, "isdir", return_value=True), \\
     patch.object(module["os"].path, "isfile", return_value=True), \\
     patch.object(module["os"].path, "realpath", side_effect=lambda path: path), \\
     patch.object(module["os"].path, "isabs", return_value=False):
    result = module["main"](["-S", "synthetic-fixture", "--noconfirm"])
    assert result == 0, (result, events)
guards = [event for event in events if event[0][:2] == [module["GUARD"], "ais-aur"]]
assert len(guards) == 2
assert guards[0][0][2:] == ["install", "synthetic-fixture", "/agent/build-unique/synthetic-fixture/synthetic-fixture.pkg.tar.zst"]
assert guards[1][0][2:] == ["install", "synthetic-fixture-extra", "/agent/build-unique/synthetic-fixture/synthetic-fixture-extra.pkg.tar.zst"]
assert any(event[0] == [module["MAKEPKG"], "--nodeps", "--noconfirm"] for event in events)
assert not any("--syncdeps" in event[0] for event in events)
assert all(event[1].get("cwd") != "/" for event in events)
`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain('"sources":["SYNTHETIC_FIXTURE_SOURCE.tar"]');
  });

  test("approves missing AUR dependencies before building their dependants", () => {
    const result = runPython(`
import runpy
from types import SimpleNamespace
from unittest.mock import patch
module = runpy.run_path(${JSON.stringify(script)})
events = []
installed = set()
def fake_run(argv, **kwargs):
    cwd = kwargs.get("cwd", "")
    events.append((argv, cwd))
    if argv[:2] == [module["PARU"], "-G"]:
        return SimpleNamespace(returncode=0, stdout="")
    if argv[:2] == [module["MAKEPKG"], "--printsrcinfo"]:
        if cwd.endswith("synthetic-app"):
            output = "pkgbase = synthetic-app\\npkgname = synthetic-app\\ndepends = synthetic-leaf\\n"
            output += "depends = synthetic-repo\\n"
        else:
            output = "pkgbase = synthetic-leaf\\npkgname = synthetic-leaf\\n"
        return SimpleNamespace(returncode=0, stdout=output)
    if argv[:2] == [module["PACMAN"], "-T"]:
        return SimpleNamespace(returncode=0 if argv[2] in installed else 127, stdout="")
    if argv[:2] == [module["PACMAN"], "-Si"]:
        return SimpleNamespace(returncode=0 if argv[2] == "synthetic-repo" else 1, stdout="")
    if argv[0] == module["PACMAN_WRAPPER"]:
        assert argv == [module["PACMAN_WRAPPER"], "-S", "synthetic-repo"]
        installed.add("synthetic-repo")
        return SimpleNamespace(returncode=0, stdout="")
    if argv[:2] == [module["MAKEPKG"], "--packagelist"]:
        name = cwd.rsplit("/", 1)[-1]
        return SimpleNamespace(returncode=0, stdout=name + ".pkg.tar.zst\\n")
    if argv[:2] == [module["PACMAN"], "-Qp"]:
        name = argv[-1].rsplit("/", 1)[-1].removesuffix(".pkg.tar.zst")
        return SimpleNamespace(returncode=0, stdout=name + " 1.0-1\\n")
    if argv[:2] == [module["GUARD"], "ais-aur"]:
        installed.add(argv[3])
        return SimpleNamespace(returncode=0, stdout="")
    return SimpleNamespace(returncode=0, stdout="")
with patch.dict(module["main"].__globals__, {"run": fake_run}), \\
     patch.object(module["os"], "geteuid", return_value=1000), \\
     patch.object(module["pwd"], "getpwnam", return_value=SimpleNamespace(pw_uid=1000)), \\
     patch.object(module["pwd"], "getpwuid", return_value=SimpleNamespace(pw_dir="/agent")), \\
     patch.object(module["os"], "makedirs"), \\
     patch.object(module["tempfile"], "mkdtemp", return_value="/agent/build-unique"), \\
     patch.object(module["os"].path, "lexists", return_value=False), \\
     patch.object(module["os"].path, "islink", return_value=False), \\
     patch.object(module["os"].path, "isdir", return_value=True), \\
     patch.object(module["os"].path, "isfile", return_value=True), \\
     patch.object(module["os"].path, "realpath", side_effect=lambda path: path), \\
     patch.object(module["os"].path, "isabs", return_value=False):
    assert module["main"](["-S", "synthetic-app"]) == 0, events
leaf_approval = next(i for i, event in enumerate(events) if event[0][:4] == [module["GUARD"], "ais-aur", "install", "synthetic-leaf"])
app_build = next(i for i, event in enumerate(events) if event[0] == [module["MAKEPKG"], "--nodeps", "--noconfirm"] and event[1].endswith("synthetic-app"))
assert leaf_approval < app_build
assert "synthetic-leaf" in installed
assert "synthetic-repo" in installed
`);
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("refuses to run the package builder as root", () => {
    const result = runPython(`
import runpy
from types import SimpleNamespace
from unittest.mock import patch
module = runpy.run_path(${JSON.stringify(script)})
with patch.object(module["os"], "geteuid", return_value=0), \\
     patch.object(module["pwd"], "getpwnam", return_value=SimpleNamespace(pw_uid=1000)):
    assert module["main"](["-S", "synthetic-fixture"]) == 126
`);
    expect(result.exitCode, result.stderr).toBe(0);
  });
});
