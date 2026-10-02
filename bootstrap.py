"""Prepare the project's virtual environment, then start the local album."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

import install


BASE = Path(__file__).resolve().parent
MIN_PYTHON = (3, 10)
PROBE_CODE = r"""
import re
import sys
if sys.version_info[:2] < (3, 10):
    print('The project environment needs Python 3.10 or newer.')
    sys.exit(1)
try:
    import PIL
    from PIL import Image, ImageOps
except (ImportError, OSError) as exc:
    print('Pillow is unavailable: ' + str(exc))
    sys.exit(1)
version = getattr(PIL, '__version__', '')
match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(.*)', version)
if not match:
    print('Unrecognized Pillow version: ' + version)
    sys.exit(1)
major, minor, patch = (int(match.group(i)) for i in (1, 2, 3))
suffix = match.group(4)
pre_release = bool(re.match(r'(?:a|b|rc|\.dev)\d+', suffix))
if not (10 <= major < 13) or ((major, minor, patch) == (10, 0, 0) and pre_release):
    print('Pillow >=10.0,<13 is required; found ' + version)
    sys.exit(1)
print('Python and Pillow ' + version + ' are ready.')
"""


def probe_environment(base: Path) -> tuple[bool, str]:
    """Check the interpreter and real imports without changing the environment."""
    interpreter = install.environment_python(base)
    if not interpreter.is_file():
        return False, "尚未创建项目运行环境 .venv。"
    try:
        result = subprocess.run(
            [str(interpreter), "-I", "-c", PROBE_CODE], cwd=base,
            check=False, shell=False, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"项目运行环境无法正常运行：{exc}"
    details = result.stdout.strip()
    return result.returncode == 0, details or f"运行环境检查退出码：{result.returncode}"


def main(argv: list[str] | None = None, base: Path = BASE) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if sys.version_info[:2] < MIN_PYTHON:
        print("需要 Python 3.10 或更新版本，请从 https://www.python.org/downloads/ 安装后重试。", file=sys.stderr)
        return 1
    base = base.resolve()
    if not (base / "app.py").is_file() or not (base / "requirements.txt").is_file():
        print("缺少 app.py 或 requirements.txt。请完整解压相册，再双击“打开相册.cmd”。", file=sys.stderr)
        return 1
    try:
        ready, details = probe_environment(base)
        if not ready:
            print(details, flush=True)
            print("准备项目运行环境；首次安装依赖需要联网。安装过程会显示在此窗口。", flush=True)
            if install.install(base) != 0:
                print("准备未完成，相册尚未启动。请根据上方错误修复后再次双击“打开相册.cmd”。", file=sys.stderr)
                return 1
            ready, details = probe_environment(base)
            if not ready:
                print(f"安装后的运行环境仍不可用：{details}", file=sys.stderr)
                print("相册尚未启动。请保留窗口中的错误信息；不要删除 data 或原照片。", file=sys.stderr)
                return 1
        print("正在打开相册。请保持此窗口打开；需要停止时按 Ctrl+C。", flush=True)
        result = subprocess.run(
            [str(install.environment_python(base)), str(base / "app.py"), "--open-browser", *args],
            cwd=base, check=False, shell=False,
        )
        if result.returncode:
            print(f"相册已退出，退出码 {result.returncode}。请检查上方错误后重试。", file=sys.stderr)
        return result.returncode
    except KeyboardInterrupt:
        print("\n已取消。可再次双击“打开相册.cmd”继续。", file=sys.stderr)
        return 130
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"相册启动未完成：{exc}", file=sys.stderr)
        print("请检查上方错误、Python 安装和网络后重试。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
