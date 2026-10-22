"""Synthetic signing orchestration tests; native assessment remains a CI gate."""
import base64
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "host_signing", Path(__file__).resolve().parents[2] / "scripts/host/sign-macos.py")
signing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(signing)


class SigningTests(unittest.TestCase):
    def test_each_missing_credential_skips_cleanly(self):
        for missing in signing.SECRET_NAMES:
            with tempfile.TemporaryDirectory(prefix="host-sign-SYNTHETIC_FIXTURE-") as temporary:
                env = {name: "SYNTHETIC_FIXTURE" for name in signing.SECRET_NAMES if name != missing}
                output = Path(temporary) / "outputs"
                env["GITHUB_OUTPUT"] = str(output)
                captured = io.StringIO()
                with patch.dict(os.environ, env, clear=True), patch.object(signing, "call") as call:
                    with contextlib.redirect_stdout(captured):
                        signing.main()
                call.assert_not_called()
                self.assertEqual(output.read_text(), "ready=false\n")
                self.assertIn("::notice::", captured.getvalue())
                self.assertNotIn("SYNTHETIC_FIXTURE", captured.getvalue())

    def exercise_signing(self, accepted=True, altered=False):
        with tempfile.TemporaryDirectory(prefix="host-sign-SYNTHETIC_FIXTURE-") as temporary:
            root = Path(temporary)
            env = {
                "GITHUB_OUTPUT": str(root / "outputs"),
                "HOST_SIGN_DIR": str(root / "work"),
                "HOST_UNSIGNED_ARCHIVE": str(root / "unsigned.zip"),
                "RUNNER_TEMP": str(root),
                signing.SECRET_NAMES[0]: base64.b64encode(b"SYNTHETIC_FIXTURE_CERTIFICATE").decode(),
                signing.SECRET_NAMES[1]: "SYNTHETIC_FIXTURE_PASSWORD",
                signing.SECRET_NAMES[2]: base64.b64encode(b"SYNTHETIC_FIXTURE_NOTARY_KEY").decode(),
                signing.SECRET_NAMES[3]: "SYNTHETIC_FIXTURE_KEY_ID",
                signing.SECRET_NAMES[4]: "SYNTHETIC_FIXTURE_ISSUER_ID",
            }
            (root / "THIRD-PARTY-NOTICES-macos-arm64.txt").write_text("SYNTHETIC_FIXTURE notices")
            calls = []
            stapled = False

            def fake_call(args, **_kwargs):
                nonlocal stapled
                calls.append(args)
                # Key ID and issuer are identifiers passed to notarytool; credentials never are.
                for secret in signing.SECRET_NAMES[:3]:
                    self.assertNotIn(env[secret], args)
                if args[:2] == ["security", "find-identity"]:
                    return (f'1) {"A" * 40} "Developer ID Application: SYNTHETIC_FIXTURE"\n').encode()
                if args[:3] == ["ditto", "-x", "-k"]:
                    binaries = Path(args[-1]) / "ais Host.app/Contents/MacOS"
                    binaries.mkdir(parents=True)
                    for name in ["ais-host-app", "ais-host-helper", "ais-host-adapter", "ais-host-escrow-purge"]:
                        (binaries / name).write_text("SYNTHETIC_FIXTURE executable")
                if args[:3] == ["xcrun", "notarytool", "submit"]:
                    return b'{"status":"Accepted"}' if accepted else b'{"status":"Invalid"}'
                if args[:3] == ["xcrun", "stapler", "staple"]:
                    stapled = True
                if args[:2] == ["codesign", "--verify"] and stapled and altered:
                    raise RuntimeError("SYNTHETIC_FIXTURE signature invalidated")
                if args[:3] == ["ditto", "-c", "-k"] or args[:2] == ["hdiutil", "create"]:
                    Path(args[-1]).write_text("SYNTHETIC_FIXTURE archive")
                return b""

            with patch.dict(os.environ, env, clear=True), patch.object(signing.sys, "platform", "darwin"):
                with patch.object(signing, "call", side_effect=fake_call):
                    with contextlib.redirect_stdout(io.StringIO()):
                        if accepted and not altered:
                            signing.main()
                        else:
                            with self.assertRaises(RuntimeError):
                                signing.main()
            published = root / "work/signed/ais-host-macos-arm64.dmg"
            self.assertEqual(published.exists(), accepted and not altered)
            self.assertEqual((root / "outputs").read_text(), "ready=false\nready=true\n" if accepted and not altered else "ready=false\n")
            self.assertEqual(list(root.glob("host-sign-*")), [])
            return calls

    def test_nested_signing_precedes_outer_and_final_archive_follows_stapling(self):
        calls = self.exercise_signing()
        signed = [args[-1] for args in calls if args[:2] == ["codesign", "--force"]]
        self.assertEqual([Path(path).name for path in signed], [
            "ais-host-adapter", "ais-host-escrow-purge", "ais-host-helper", "ais Host.app", "ais-host-macos-arm64.dmg"])
        image = next(i for i, args in enumerate(calls) if args[:2] == ["hdiutil", "create"])
        staples = [i for i, args in enumerate(calls) if args[:3] == ["xcrun", "stapler", "staple"]]
        assessment = next(i for i, args in enumerate(calls) if args[0] == "spctl")
        self.assertGreater(image, staples[0])
        self.assertGreater(image, assessment)
        # The DMG is signed, then notarised, then stapled, after it is built.
        dmg_sign = next(i for i, args in enumerate(calls) if args[:2] == ["codesign", "--force"] and args[-1].endswith(".dmg"))
        dmg_notary = [i for i, args in enumerate(calls) if args[:3] == ["xcrun", "notarytool", "submit"]][1]
        self.assertTrue(image < dmg_sign < dmg_notary < staples[1])
        self.assertTrue(calls[staples[1]][-1].endswith("/signed/ais-host-macos-arm64.dmg"))

    def test_rejected_notarisation_cannot_produce_release(self):
        self.exercise_signing(accepted=False)

    def test_alteration_after_notarisation_cannot_produce_release(self):
        self.exercise_signing(altered=True)

    def test_keychain_password_is_passed_only_on_stdin(self):
        password = "SYNTHETIC_FIXTURE_PASSWORD"
        with patch.object(signing, "call") as call:
            signing.security_command("create-keychain", "-p", password, "synthetic.keychain")
        self.assertEqual(call.call_args.args, (["security", "-i"],))
        self.assertIn(password.encode(), call.call_args.kwargs["data"])


if __name__ == "__main__":
    unittest.main()
