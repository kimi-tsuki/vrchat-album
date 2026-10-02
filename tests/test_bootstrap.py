"""Offline bootstrap checks; no dependency downloads or album server launches."""
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import ModuleType
import unittest
from unittest.mock import patch
import uuid


BASE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("album_bootstrap", BASE / "bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec)
with patch.object(sys, "path", [str(BASE), *sys.path]):
    spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(__file__).resolve().parent / "scratch"
        self.scratch.mkdir(exist_ok=True)
        self.base = self.scratch / f"bootstrap 相册 {uuid.uuid4().hex}"
        self.base.mkdir()
        (self.base / "app.py").write_text("# synthetic app; never started\n", encoding="utf-8")
        (self.base / "requirements.txt").write_text("Pillow>=10.0,<13\n", encoding="utf-8")
        self.addCleanup(self.cleanup)
        self.stdout, self.stderr = io.StringIO(), io.StringIO()

    def cleanup(self):
        if self.base.resolve().parent != self.scratch.resolve():
            raise AssertionError("Refusing cleanup outside bootstrap test scratch")
        shutil.rmtree(self.base)

    def invoke(self, args=None):
        with redirect_stdout(self.stdout), redirect_stderr(self.stderr):
            return bootstrap.main([] if args is None else args, self.base)

    def interpreter(self):
        path = bootstrap.install.environment_python(self.base)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"synthetic interpreter; never executed")
        return path

    def test_ready_environment_skips_install_and_forwards_arguments_without_shell(self):
        args = ["--source", "D:\\照片 with spaces & text", "--data", "D:\\Album Data", "--port", "18765"]
        with patch.object(bootstrap, "probe_environment", return_value=(True, "ready")), patch.object(bootstrap.install, "install") as install, patch.object(bootstrap.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(self.invoke(args), 0)
        install.assert_not_called()
        run.assert_called_once_with(
            [str(bootstrap.install.environment_python(self.base)), str(self.base / "app.py"), "--open-browser", *args],
            cwd=self.base, check=False, shell=False,
        )

    def test_first_run_installs_then_rechecks_before_launch(self):
        with patch.object(bootstrap, "probe_environment", side_effect=[(False, "missing"), (True, "ready")]) as probe, patch.object(bootstrap.install, "install", return_value=0) as install, patch.object(bootstrap.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(self.invoke(), 0)
        install.assert_called_once_with(self.base)
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(run.call_count, 1)

    def test_install_failure_does_not_launch_or_recheck_and_preserves_files(self):
        marker = self.base / "keep.txt"
        marker.write_text("user file", encoding="utf-8")
        with patch.object(bootstrap, "probe_environment", return_value=(False, "missing")) as probe, patch.object(bootstrap.install, "install", return_value=1), patch.object(bootstrap.subprocess, "run") as run:
            self.assertEqual(self.invoke(), 1)
        run.assert_not_called()
        self.assertEqual(probe.call_count, 1)
        self.assertIn("相册尚未启动", self.stderr.getvalue())
        self.assertEqual(marker.read_text(encoding="utf-8"), "user file")

    def test_failed_post_install_verification_never_launches_album(self):
        with patch.object(bootstrap, "probe_environment", side_effect=[(False, "missing"), (False, "Pillow 13 is incompatible")]), patch.object(bootstrap.install, "install", return_value=0), patch.object(bootstrap.subprocess, "run") as run:
            self.assertEqual(self.invoke(), 1)
        run.assert_not_called()
        self.assertIn("Pillow 13", self.stderr.getvalue())

    def test_probe_handles_missing_broken_and_timed_out_environment(self):
        ready, reason = bootstrap.probe_environment(self.base)
        self.assertFalse(ready)
        self.assertIn(".venv", reason)
        interpreter = self.interpreter()
        for failure in (OSError("broken interpreter"), subprocess.TimeoutExpired([str(interpreter)], 30)):
            with self.subTest(failure=type(failure).__name__), patch.object(bootstrap.subprocess, "run", side_effect=failure):
                ready, reason = bootstrap.probe_environment(self.base)
                self.assertFalse(ready)
                self.assertIn("无法正常运行", reason)

    def test_probe_keeps_install_imports_isolated_and_reports_import_error(self):
        interpreter = self.interpreter()
        with patch.object(bootstrap.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "Pillow is unavailable: missing binary")) as run:
            self.assertEqual(bootstrap.probe_environment(self.base), (False, "Pillow is unavailable: missing binary"))
        self.assertEqual(run.call_args.args[0][:3], [str(interpreter), "-I", "-c"])
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def test_real_probe_code_checks_pillow_version_boundaries(self):
        module = ModuleType("PIL")
        module.Image, module.ImageOps = object(), object()
        for version, good in (("9.5.0", False), ("10.0.0a1", False), ("10.0.0", True), ("12.1.0", True), ("13.0.0", False), ("unknown", False)):
            with self.subTest(version=version), patch.dict(sys.modules, {"PIL": module}), redirect_stdout(io.StringIO()):
                module.__version__ = version
                if good:
                    exec(bootstrap.PROBE_CODE, {})
                else:
                    with self.assertRaises(SystemExit) as raised:
                        exec(bootstrap.PROBE_CODE, {})
                    self.assertNotEqual(raised.exception.code, 0)

    def test_old_python_and_incomplete_archive_do_not_install_or_launch(self):
        with patch.object(bootstrap.sys, "version_info", (3, 9)), patch.object(bootstrap.install, "install") as install, patch.object(bootstrap.subprocess, "run") as run:
            self.assertEqual(self.invoke(), 1)
            install.assert_not_called()
            run.assert_not_called()
        (self.base / "app.py").unlink()
        with patch.object(bootstrap.install, "install") as install, patch.object(bootstrap.subprocess, "run") as run:
            self.assertEqual(self.invoke(), 1)
            install.assert_not_called()
            run.assert_not_called()

    def test_install_exception_and_cancellation_do_not_launch(self):
        for error, expected in ((OSError("denied"), 1), (KeyboardInterrupt(), 130)):
            with self.subTest(error=type(error).__name__), patch.object(bootstrap, "probe_environment", return_value=(False, "missing")), patch.object(bootstrap.install, "install", side_effect=error), patch.object(bootstrap.subprocess, "run") as run:
                self.assertEqual(self.invoke(), expected)
                run.assert_not_called()

    def test_app_exit_failure_and_control_c_are_reported(self):
        with patch.object(bootstrap, "probe_environment", return_value=(True, "ready")), patch.object(bootstrap.subprocess, "run", return_value=subprocess.CompletedProcess([], 7)):
            self.assertEqual(self.invoke(), 7)
        self.assertIn("退出码 7", self.stderr.getvalue())
        with patch.object(bootstrap, "probe_environment", return_value=(True, "ready")), patch.object(bootstrap.subprocess, "run", side_effect=KeyboardInterrupt()):
            self.assertEqual(self.invoke(), 130)

    @unittest.skipUnless(os.name == "nt", "Windows command-file integration")
    def test_windows_cmd_forwards_quoted_paths_and_preserves_exit_code(self):
        launcher = self.base / "打开相册.cmd"
        launcher.write_bytes((BASE / "打开相册.cmd").read_bytes())
        # The real launcher reaches only this synthetic bootstrap, never app.py or pip.
        (self.base / "bootstrap.py").write_text(
            "import json, os, pathlib, sys\n"
            "pathlib.Path(__file__).with_name('received.json').write_text("
            "json.dumps(sys.argv[1:]), encoding='utf-8')\n"
            "raise SystemExit(int(os.environ.get('ALBUM_TEST_EXIT_CODE', '0')))\n",
            encoding="utf-8",
        )
        source = "D:\\照片 test & album (1)"
        for code in (0, 7):
            with self.subTest(exit_code=code):
                result = subprocess.run(
                    [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", launcher.name,
                     "--source", source, "--port", "18765"],
                    cwd=self.base, env={**os.environ, "ALBUM_TEST_EXIT_CODE": str(code)},
                    shell=False, input="\n", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace", timeout=30,
                )
                self.assertEqual(result.returncode, code, result.stdout)
                self.assertEqual(json.loads((self.base / "received.json").read_text(encoding="utf-8")),
                                 ["--source", source, "--port", "18765"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
