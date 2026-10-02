"""A visible native folder dialog in its own main-thread Python process."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initial", default="")
    args = parser.parse_args()
    root = None
    try:
        import tkinter as tk
        from tkinter import filedialog

        initial = Path(args.initial)
        if not initial.is_dir():
            initial = Path.home() / "Pictures"
        if not initial.is_dir():
            initial = Path.home()
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update_idletasks()
        selected = filedialog.askdirectory(
            parent=root, title="选择你的 VRChat 照片文件夹", initialdir=str(initial), mustexist=True,
        )
        print(json.dumps({"path": str(Path(selected).resolve()) if selected else None}))
        return 0
    except Exception:
        print(json.dumps({"error": "文件夹窗口不可用，请在网页手动填写路径。"}))
        return 1
    finally:
        if root is not None:
            root.destroy()


if __name__ == "__main__":
    raise SystemExit(main())
