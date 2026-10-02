"""Create a local virtual environment and install the album's dependencies."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import venv

BASE = Path(__file__).resolve().parent
MIN_PYTHON = (3, 10)


def environment_python(base: Path) -> Path:
    folder = "Scripts" if os.name == "nt" else "bin"
    name = "python.exe" if os.name == "nt" else "python"
    return base / ".venv" / folder / name


def install(base: Path = BASE) -> int:
    if sys.version_info[:2] < MIN_PYTHON:
        print("需要 Python 3.10 或更高版本，请从 https://www.python.org/ 安装。", file=sys.stderr)
        return 1
    base = base.resolve()
    requirements = base / "requirements.txt"
    if not requirements.is_file():
        print("找不到 requirements.txt，请完整下载并解压项目后重试。", file=sys.stderr)
        return 1
    interpreter = environment_python(base)
    phase = "创建虚拟环境"
    try:
        if not interpreter.is_file():
            print("创建项目虚拟环境 .venv …", flush=True)
            venv.EnvBuilder(with_pip=False).create(base / ".venv")
        phase = "检查虚拟环境的 Python 版本"
        subprocess.run(
            [str(interpreter), "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"],
            cwd=base, check=True,
        )
        phase = "检查 pip"
        pip_check = subprocess.run(
            [str(interpreter), "-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('pip') else 1)"],
            cwd=base, check=False,
        )
        if pip_check.returncode != 0:
            phase = "初始化 pip"
            print("使用 Python 自带的 ensurepip 补齐安装工具 …", flush=True)
            subprocess.run(
                [str(interpreter), "-m", "ensurepip", "--upgrade", "--default-pip"],
                cwd=base, check=True,
            )
        phase = "安装依赖"
        print("在项目虚拟环境中安装依赖（需要联网访问 Python 包索引）…", flush=True)
        subprocess.run(
            [str(interpreter), "-m", "pip", "install", "-r", str(requirements)],
            cwd=base, check=True,
        )
        phase = "验证 Pillow"
        subprocess.run(
            [str(interpreter), "-c", "from PIL import Image, ImageOps; print('Pillow OK')"],
            cwd=base, check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"安装未完成（{phase}）：{exc}", file=sys.stderr)
        if phase == "检查虚拟环境的 Python 版本":
            print("现有 .venv 需要 Python 3.10+ 且必须可运行；可先将 .venv 改名备份，再重新安装。", file=sys.stderr)
        print("请检查上方错误、Python 安装与网络连接，修复后重新运行 python install.py。", file=sys.stderr)
        return 1
    print("\n安装完成。", flush=True)
    if os.name == "nt":
        print("双击“打开相册.cmd”，首次整理结束后浏览器会打开相册。")
    else:
        print("启动：.venv/bin/python app.py --source \"/你的/VRChat照片目录\" --open-browser")
    print("相册运行期间保持启动窗口打开；使用说明见 README.md。")
    return 0


if __name__ == "__main__":
    raise SystemExit(install())

