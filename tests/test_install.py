"""Offline installer regression checks with isolated files and mocked commands."""
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid


INSTALL_PATH = Path(__file__).resolve().parent.parent / "install.py"
spec = importlib.util.spec_from_file_location("album_installer", INSTALL_PATH)
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(__file__).resolve().parent / "scratch"
        self.scratch.mkdir(exist_ok=True)
        # Default mkdir permissions inherit the scratch ACL on Windows.
        self.temp = self.scratch / f"install-{uuid.uuid4().hex}"
        self.temp.mkdir()
        self.addCleanup(self.cleanup)
        self.base = self.temp / "相册 项目"
        self.base.mkdir()
        (self.base / "requirements.txt").write_text("Pillow>=10.0,<13\n", encoding="utf-8")
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()

    def cleanup(self):
        if self.temp.resolve().parent != self.scratch.resolve():
            raise AssertionError("Refusing cleanup outside installer test scratch")
        shutil.rmtree(self.temp)

    def invoke(self, base=None):
        with redirect_stdout(self.stdout), redirect_stderr(self.stderr):
            return installer.install(self.base if base is None else base)

    def make_existing_interpreter(self):
        interpreter = installer.environment_python(self.base)
        interpreter.parent.mkdir(parents=True)
        interpreter.write_bytes(b"synthetic interpreter placeholder; never executed")
        return interpreter

    def test_existing_environment_is_reused_and_pillow_is_verified(self):
        interpreter = self.make_existing_interpreter()
        with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(self.invoke(), 0)
            builder.assert_not_called()
            self.assertEqual(run.call_count, 4)
            self.assertIn("sys.version_info >= (3, 10)", run.call_args_list[0].args[0][2])
            self.assertIn("find_spec('pip')", run.call_args_list[1].args[0][2])
            self.assertEqual(run.call_args_list[2].args[0],
                             [str(interpreter), "-m", "pip", "install", "-r", str(self.base / "requirements.txt")])
            self.assertIn("from PIL import Image, ImageOps", run.call_args_list[3].args[0][2])
            for index, call in enumerate(run.call_args_list):
                self.assertEqual(call.kwargs, {"cwd": self.base.resolve(), "check": index != 1})
            self.assertIn("安装完成", self.stdout.getvalue())

    def test_other_cwd_and_unicode_spaces_keep_all_paths_in_project(self):
        elsewhere = self.temp / "unrelated working directory"
        elsewhere.mkdir()
        original_cwd = Path.cwd()
        try:
            os.chdir(elsewhere)
            with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
                # A relative path supplied by a caller is resolved before use.
                self.assertEqual(self.invoke(Path("..") / self.base.name), 0)
                builder.assert_called_once_with(with_pip=False)
                builder.return_value.create.assert_called_once_with(self.base / ".venv")
                for call in run.call_args_list:
                    self.assertEqual(call.kwargs["cwd"], self.base)
                    self.assertEqual(call.args[0][0], str(installer.environment_python(self.base)))
                self.assertEqual(run.call_args_list[2].args[0][-1], str(self.base / "requirements.txt"))
                self.assertFalse((elsewhere / ".venv").exists())
        finally:
            os.chdir(original_cwd)

    def test_unsupported_python_does_not_create_environment_or_run_pip(self):
        before = sorted(str(path.relative_to(self.base)) for path in self.base.rglob("*"))
        with patch.object(installer.sys, "version_info", (3, 9, 0)), patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run") as run:
            self.assertEqual(self.invoke(), 1)
            builder.assert_not_called()
            run.assert_not_called()
        self.assertEqual(sorted(str(path.relative_to(self.base)) for path in self.base.rglob("*")), before)
        self.assertFalse((self.base / ".venv").exists())
        self.assertIn("Python 3.10", self.stderr.getvalue())

    def test_missing_requirements_does_not_create_environment_or_run_pip(self):
        (self.base / "requirements.txt").unlink()
        with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run") as run:
            self.assertEqual(self.invoke(), 1)
            builder.assert_not_called()
            run.assert_not_called()
        self.assertFalse((self.base / ".venv").exists())
        self.assertIn("requirements.txt", self.stderr.getvalue())

    def test_environment_creation_failure_stops_before_pip(self):
        with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run") as run:
            builder.return_value.create.side_effect = OSError("synthetic environment creation failure")
            self.assertEqual(self.invoke(), 1)
            run.assert_not_called()
        self.assertIn("synthetic environment creation failure", self.stderr.getvalue())
        self.assertNotIn("安装完成。", self.stdout.getvalue())

    def test_failed_pip_does_not_report_success_or_delete_existing_environment(self):
        interpreter = self.make_existing_interpreter()
        marker = self.base / ".venv" / "keep.txt"
        marker.write_text("preserve for retry", encoding="utf-8")
        original_bytes = interpreter.read_bytes()
        failure = subprocess.CalledProcessError(2, [str(interpreter), "-m", "pip", "install"])
        with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run", side_effect=[None, subprocess.CompletedProcess([], 0), failure]) as run:
            self.assertEqual(self.invoke(), 1)
            builder.assert_not_called()
            self.assertEqual(run.call_count, 3)
        self.assertEqual(interpreter.read_bytes(), original_bytes)
        self.assertEqual(marker.read_text(encoding="utf-8"), "preserve for retry")
        self.assertIn("安装未完成", self.stderr.getvalue())
        self.assertIn("安装依赖", self.stderr.getvalue())
        self.assertNotIn("安装完成。", self.stdout.getvalue())

    def test_post_install_pillow_verification_failure_reports_failure(self):
        self.make_existing_interpreter()
        failure = subprocess.CalledProcessError(1, ["synthetic-python", "-c", "import PIL"])
        with patch.object(installer.venv, "EnvBuilder"), patch.object(installer.subprocess, "run", side_effect=[None, subprocess.CompletedProcess([], 0), None, failure]) as run:
            self.assertEqual(self.invoke(), 1)
            self.assertEqual(run.call_count, 4)
        self.assertIn("安装未完成", self.stderr.getvalue())
        self.assertIn("验证 Pillow", self.stderr.getvalue())
        self.assertNotIn("安装完成。", self.stdout.getvalue())

    def test_unsupported_existing_environment_stops_before_pip_and_is_preserved(self):
        interpreter = self.make_existing_interpreter()
        original_bytes = interpreter.read_bytes()
        failure = subprocess.CalledProcessError(1, [str(interpreter), "-c", "synthetic version check"])
        with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run", side_effect=failure) as run:
            self.assertEqual(self.invoke(), 1)
            builder.assert_not_called()
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][0], str(interpreter))
            self.assertIn("sys.version_info >= (3, 10)", run.call_args.args[0][2])
        self.assertEqual(interpreter.read_bytes(), original_bytes)
        self.assertIn("检查虚拟环境的 Python 版本", self.stderr.getvalue())
        self.assertIn("改名备份", self.stderr.getvalue())
        self.assertNotIn("安装依赖", self.stdout.getvalue())
        self.assertNotIn("安装完成。", self.stdout.getvalue())

    def test_missing_pip_is_bootstrapped_for_fresh_and_interrupted_environments(self):
        for existing in (False, True):
            with self.subTest(existing_environment=existing):
                interpreter = installer.environment_python(self.base)
                if existing:
                    interpreter = self.make_existing_interpreter()
                    original_bytes = interpreter.read_bytes()
                outcomes = [None, subprocess.CompletedProcess([], 1), None, None, None]
                with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run", side_effect=outcomes) as run:
                    self.assertEqual(self.invoke(), 0)
                    if existing:
                        builder.assert_not_called()
                    else:
                        builder.assert_called_once_with(with_pip=False)
                        builder.return_value.create.assert_called_once_with(self.base / ".venv")
                    self.assertEqual(run.call_count, 5)
                    self.assertEqual(run.call_args_list[2].args[0],
                                     [str(interpreter), "-m", "ensurepip", "--upgrade", "--default-pip"])
                    self.assertTrue(run.call_args_list[2].kwargs["check"])
                    self.assertEqual(run.call_args_list[3].args[0][1:4], ["-m", "pip", "install"])
                    self.assertIn("from PIL import Image, ImageOps", run.call_args_list[4].args[0][2])
                if existing:
                    self.assertEqual(interpreter.read_bytes(), original_bytes)
        self.assertIn("ensurepip", self.stdout.getvalue())
        self.assertIn("安装完成。", self.stdout.getvalue())

    def test_failed_ensurepip_stops_before_install_and_preserves_partial_environment(self):
        interpreter = self.make_existing_interpreter()
        original_bytes = interpreter.read_bytes()
        failure = subprocess.CalledProcessError(1, [str(interpreter), "-m", "ensurepip"])
        outcomes = [None, subprocess.CompletedProcess([], 1), failure]
        with patch.object(installer.venv, "EnvBuilder") as builder, patch.object(installer.subprocess, "run", side_effect=outcomes) as run:
            self.assertEqual(self.invoke(), 1)
            builder.assert_not_called()
            self.assertEqual(run.call_count, 3)
            self.assertFalse(any(call.args[0][1:4] == ["-m", "pip", "install"] for call in run.call_args_list))
        self.assertEqual(interpreter.read_bytes(), original_bytes)
        self.assertIn("初始化 pip", self.stderr.getvalue())
        self.assertNotIn("安装完成。", self.stdout.getvalue())

    def test_platform_environment_paths(self):
        with patch.object(installer.os, "name", "nt"):
            self.assertEqual(installer.environment_python(self.base), self.base / ".venv" / "Scripts" / "python.exe")
        with patch.object(installer.os, "name", "posix"):
            self.assertEqual(installer.environment_python(self.base), self.base / ".venv" / "bin" / "python")


if __name__ == "__main__":
    unittest.main(verbosity=2)
