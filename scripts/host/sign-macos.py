"""Sign nested code, notarise, staple, then archive. Never log tool diagnostics."""
import base64
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import termios
import time

SECRET_NAMES = (
    "DYNACOM_APPLE_DEVELOPER_ID_P12_BASE64",
    "DYNACOM_APPLE_DEVELOPER_ID_P12_PASSWORD",
    "DYNACOM_APPLE_ASC_KEY_P8_BASE64",
    "DYNACOM_APPLE_ASC_KEY_ID",
    "DYNACOM_APPLE_ASC_ISSUER_ID",
)


class StepFailed(RuntimeError):
    """Carries only a fixed step name, never tool output or arguments."""


def call(args, *, data=None, timeout=120, step=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise StepFailed(step or Path(args[0]).name)
    return result.stdout


def security_command(*args):
    # security's interactive mode accepts commands on stdin, keeping passwords
    # out of argv. Its captured output is never forwarded to logs.
    def quote(value):
        if "\n" in value or "\r" in value or "\0" in value:
            raise RuntimeError("Unsupported keychain input.")
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    call(["security", "-i"], data=(" ".join(map(quote, args)) + "\n").encode(),
         step=f"security {args[0]}")


def store_notary_profile(key, keychain, env):
    # Interactive API credentials stay off argv. A PTY with echo disabled
    # prevents terminal echo; prompts and responses are never logged.
    master, slave = pty.openpty()
    settings = termios.tcgetattr(slave)
    settings[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, settings)
    child = subprocess.Popen(
        ["xcrun", "notarytool", "store-credentials", "ais-host-notary",
         "--keychain", str(keychain)],
        stdin=slave, stdout=slave, stderr=slave,
        env={**os.environ, "LC_ALL": "C"},
    )
    os.close(slave)
    pending = [
        (rb"(?i)path to .*private key\s*:", str(key)),
        (rb"(?i)(?:api\s+)?key\s+id\s*:", env["DYNACOM_APPLE_ASC_KEY_ID"]),
        (rb"(?i)(?:api\s+)?issuer(?:\s+id)?\s*:", env["DYNACOM_APPLE_ASC_ISSUER_ID"]),
    ]
    captured = b""
    deadline = time.monotonic() + 120
    try:
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 1)[0]:
                try:
                    captured = (captured + os.read(master, 4096))[-16384:]
                except OSError:
                    break
                if pending and re.search(pending[0][0], captured):
                    _, value = pending.pop(0)
                    if "\n" in value or "\r" in value:
                        raise RuntimeError("Invalid notary credential input.")
                    os.write(master, (value + "\n").encode())
                    captured = b""
        if pending or child.wait(timeout=5) != 0:
            raise StepFailed("notarytool store-credentials")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        os.close(master)


def main():
    env = os.environ
    output = Path(env["GITHUB_OUTPUT"])
    with output.open("a") as handle:
        handle.write("ready=false\n")
    if not all(env.get(name) for name in SECRET_NAMES):
        print("::notice::macOS signing and notarisation skipped: signing secrets are absent. No release will be published.")
        return
    if sys.platform != "darwin":
        raise RuntimeError("Signing requires a native macOS arm64 runner.")
    root = Path(env["HOST_SIGN_DIR"])
    root.mkdir(parents=True, exist_ok=True)
    archive = Path(env["HOST_UNSIGNED_ARCHIVE"]).resolve()
    destination = root / "signed"
    destination.mkdir()
    # Credential files and keychains live only in the runner's temporary area.
    with tempfile.TemporaryDirectory(prefix="host-sign-", dir=env["RUNNER_TEMP"]) as temporary:
        private = Path(temporary)
        os.chmod(private, 0o700)
        cert, api_key = private / "certificate.p12", private / "notary.p8"
        for path, name in [(cert, SECRET_NAMES[0]), (api_key, SECRET_NAMES[2])]:
            path.write_bytes(base64.b64decode(env[name], validate=True))
            os.chmod(path, 0o600)
        keychain = private / "signing.keychain-db"
        password = env[SECRET_NAMES[1]]
        try:
            security_command("create-keychain", "-p", password, str(keychain))
            security_command("set-keychain-settings", "-lut", "3600", str(keychain))
            security_command("unlock-keychain", "-p", password, str(keychain))
            security_command("import", str(cert), "-k", str(keychain), "-P", password,
                             "-T", "/usr/bin/codesign", "-T", "/usr/bin/security")
            # The .p12 holds only the leaf; codesign needs Apple's intermediate
            # in the keychain to build a valid chain.
            call(["security", "import", "apps/host/packaging/DeveloperIDG2CA.cer",
                  "-k", str(keychain)], step="import intermediate")
            security_command("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
                             "-s", "-k", password, str(keychain))
            identities = call(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)]).decode()
            fingerprints = re.findall(r'([A-F0-9]{40}) "Developer ID Application:', identities)
            if len(fingerprints) != 1:
                raise StepFailed(f"find-identity ({len(fingerprints)} valid identities)")
            fingerprint = fingerprints[0]
            unpacked = root / "unpacked"
            call(["ditto", "-x", "-k", str(archive), str(unpacked)])
            app = unpacked / "ais Host.app"
            binaries = app / "Contents" / "MacOS"
            expected = {"ais-host-app", "ais-host-helper", "ais-host-adapter", "ais-host-escrow-purge"}
            if {path.name for path in binaries.iterdir()} != expected:
                raise StepFailed("nested executable layout")
            options = ["codesign", "--force", "--timestamp", "--options", "runtime",
                       "--keychain", str(keychain), "--sign", fingerprint]
            for name in sorted(expected - {"ais-host-app"}):
                entitlements = (["--entitlements", "apps/host/packaging/adapter.entitlements.plist"]
                                if name == "ais-host-adapter" else [])
                call([*options, *entitlements, str(binaries / name)])
            call([*options, str(app)])
            call(["codesign", "--verify", "--deep", "--strict", str(app)])
            submission = private / "submission.zip"
            call(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(submission)])
            store_notary_profile(api_key, keychain, env)
            receipt = json.loads(call(
                ["xcrun", "notarytool", "submit", str(submission), "--keychain-profile",
                 "ais-host-notary", "--keychain", str(keychain), "--wait",
                 "--timeout", "30m", "--output-format", "json"], timeout=1900))
            if receipt.get("status") != "Accepted":
                raise StepFailed(f"notarisation status {receipt.get('status')!r}")
            call(["xcrun", "stapler", "staple", str(app)])
            call(["xcrun", "stapler", "validate", str(app)])
            call(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
            call(["spctl", "--assess", "--type", "execute", "--verbose=2", str(app)])
            final = destination / "ais-host-macos-arm64.zip"
            call(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(final)])
            shutil.copyfile(archive.parent / "THIRD-PARTY-NOTICES-macos-arm64.txt",
                            destination / "THIRD-PARTY-NOTICES-macos-arm64.txt")
            # No signing output, certificate names or notary account IDs are
            # retained as release metadata.
            with output.open("a") as handle:
                handle.write("ready=true\n")
        finally:
            if keychain.exists():
                call(["security", "delete-keychain", str(keychain)])
    print("macOS Developer ID signing, notarisation and stapling passed.")


if __name__ == "__main__":
    try:
        main()
    except StepFailed as failure:
        print(f"::error::macOS signing failed at step: {failure}. Credential material and tool output were not logged.")
        sys.exit(1)
    except Exception as failure:
        print(f"::error::macOS signing failed ({type(failure).__name__}); credential material and private diagnostics were not logged.")
        sys.exit(1)
