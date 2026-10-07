"""A local, read-only photo index for VRChat. Originals are never modified."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import importlib.util
import json
import logging
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

if sys.version_info < (3, 10):
    raise SystemExit("需要 Python 3.10 或更高版本。请更新 Python 后运行 python install.py。")

try:
    from PIL import Image, ImageOps
except ModuleNotFoundError as exc:
    if exc.name != "PIL":
        raise
    print("缺少 Pillow。首次使用请先运行 python install.py（Windows 也可用 py -3 install.py），安装完成后再启动相册。", file=sys.stderr)
    raise SystemExit(1)

APP_ID = "vrchat-local-album-v1"
DEFAULT_SOURCE = Path.home() / "Pictures" / "VRChat"
BASE = Path(__file__).resolve().parent
APP_VERSION = (BASE / "VERSION").read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", APP_VERSION):
    raise ValueError("VERSION 文件中的版本号无效。")
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SHOT_DATE = re.compile(r"VRChat_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:\.(\d+))?", re.I)
PHOTO_ID = re.compile(r"^[a-f0-9]{64}$")
PICKER_LOCK = threading.Lock()


def source_key(source: Path) -> str:
    return os.path.normcase(str(source.resolve()))


def read_saved_source(data: Path) -> Path | None:
    database = data / "album.sqlite3"
    if not database.is_file():
        return None
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").fetchone():
            return None
        row = connection.execute("SELECT value FROM settings WHERE key='source'").fetchone()
        if not row:
            return None
        path = Path(row[0])
        if not path.is_absolute():
            raise ValueError("保存的照片目录无效，请在网页重新选择。")
        return path
    finally:
        connection.close()


def has_legacy_index(data: Path) -> bool:
    database = data / "album.sqlite3"
    if not database.is_file():
        return False
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(files)")}
        return bool(columns and "source" not in columns and connection.execute("SELECT 1 FROM files LIMIT 1").fetchone())
    finally:
        connection.close()


class PickerBusy(RuntimeError):
    pass


def picker_available() -> bool:
    return importlib.util.find_spec("tkinter") is not None


def pick_folder(initial: Path) -> str | None:
    if not PICKER_LOCK.acquire(blocking=False):
        raise PickerBusy("文件夹选择窗口已经打开，请在那个窗口完成选择或取消。")
    try:
        if not picker_available():
            raise RuntimeError("这个 Python 没有文件夹选择组件，请在网页粘贴照片文件夹的完整路径。")
        result = subprocess.run(
            [sys.executable, str(BASE / "folder_picker.py"), "--initial", str(initial)],
            capture_output=True, text=True, encoding="utf-8", timeout=180,
        )
        if result.returncode:
            raise RuntimeError("无法打开系统文件夹窗口，请在网页粘贴照片文件夹的完整路径。")
        value = json.loads(result.stdout)
        path = value.get("path")
        if path is not None and (not isinstance(path, str) or not path or len(path) > 32768):
            raise ValueError("文件夹选择结果无效。")
        return path
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("文件夹窗口未能完成选择，请重试或在网页手动填写路径。") from exc
    finally:
        PICKER_LOCK.release()


def world_metadata(metadata: dict) -> tuple[str, str]:
    """VRChat embeds world metadata in PNG XMP; older photos can lack a name."""
    raw = metadata.get("XML:com.adobe.xmp", metadata.get("xmp", ""))
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if not isinstance(raw, str) or not raw:
        return "", ""
    try:
        root = ET.fromstring(raw.replace("\x00", ""))
    except ET.ParseError:
        return "", ""
    namespace = "{http://ns.vrchat.com/vrc/1.0/}"
    name, world_id = "", ""
    for node in root.iter():
        attrs = dict(node.attrib)
        if node.tag.startswith(namespace):
            attrs[node.tag] = "".join(node.itertext())
        for key, value in attrs.items():
            if key == namespace + "WorldDisplayName":
                name = value.strip()[:200]
            elif key in (namespace + "WorldID", namespace + "World"):
                world_id = value.strip()[:200]
    return name, world_id


def photo_time(path: Path, metadata: dict, mtime: float) -> tuple[str, int]:
    match = SHOT_DATE.search(path.name)
    if match:
        try:
            value = datetime.fromisoformat(f"{match[1]}T{match[2]}:{match[3]}:{match[4]}")
            return value.isoformat(timespec="seconds"), 3
        except ValueError:
            pass
    for key in ("DateTimeOriginal", "DateTime", "Creation Time", "CreationTime", "date:create"):
        raw = metadata.get(key)
        if isinstance(raw, str):
            for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return datetime.strptime(raw[:19], fmt).isoformat(timespec="seconds"), 2
                except ValueError:
                    continue
    return datetime.fromtimestamp(mtime).isoformat(timespec="seconds"), 1


from library_features import LibraryFeatures, annotation_values, CatalogChanged


class Album(LibraryFeatures):
    def __init__(self, source: Path, data: Path, configured: bool = True):
        self.source = source.resolve()
        self.data = data.resolve()
        if self.data == self.source or self.source in self.data.parents:
            raise ValueError("相册数据目录必须放在原照片目录之外。")
        self.data.mkdir(parents=True, exist_ok=True)
        self.thumbs = self.data / "thumbs"
        self.thumbs.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.scan_lock = threading.Lock()
        self.db = sqlite3.connect(self.data / "album.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL,
                world TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                note TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0,
                world_id TEXT NOT NULL DEFAULT '', world_custom INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        file_columns = {row[1] for row in self.db.execute("PRAGMA table_info(files)")}
        file_schema = """CREATE TABLE files (
            source TEXT NOT NULL, path TEXT NOT NULL, id TEXT NOT NULL, size INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL, captured_at TEXT NOT NULL, date_quality INTEGER NOT NULL,
            PRIMARY KEY(source, path)
        )"""
        if file_columns and "source" not in file_columns:
            # Legacy relative paths did not record their root. Re-read their
            # contents once on upgrade instead of trusting a potentially wrong root.
            try:
                self.db.execute("BEGIN IMMEDIATE")
                self.db.execute("ALTER TABLE files RENAME TO legacy_files")
                self.db.execute("DROP INDEX IF EXISTS file_photo")
                self.db.execute(file_schema)
                # An old relative-path index does not identify its original
                # directory. Keep it outside every real source until a user has
                # explicitly supplied a source; no normal scan may prune it.
                legacy_source = source_key(self.source) if configured else ""
                self.db.execute("""INSERT INTO files(source,path,id,size,mtime_ns,captured_at,date_quality)
                    SELECT ?,path,id,size,-1,captured_at,date_quality FROM legacy_files""", (legacy_source,))
                self.db.execute("DROP TABLE legacy_files")
                self.db.commit()
            except Exception:
                self.db.rollback()
                self.db.close()
                raise
        elif not file_columns:
            self.db.execute(file_schema)
        self.db.execute("CREATE INDEX IF NOT EXISTS file_photo ON files(source,id)")
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(photos)")}
        for column in ("world_id", "world_custom"):
            if column not in columns:
                declaration = "TEXT NOT NULL DEFAULT ''" if column == "world_id" else "INTEGER NOT NULL DEFAULT 0"
                self.db.execute(f"ALTER TABLE photos ADD COLUMN {column} {declaration}")
        if configured:
            self.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('source',?)", (str(self.source),))
        self.initialize_library()
        self.db.commit()
        self.configured = configured
        self.source_revision = 0
        self.scan_phase = "idle"
        self.ready = False
        self.scanning = False
        self.error = None
        self.scan_errors = []
        self.last_scan = None
        self.processed = 0
        self.discovered = 0
        self.revision = 0
        self.scan_event = threading.Event()
        self.stop_event = threading.Event()

    def settings(self) -> dict:
        with self.lock:
            return {"configured": self.configured, "source": str(self.source),
                    "source_exists": self.source.is_dir(), "default_source": str(DEFAULT_SOURCE),
                    "picker_available": picker_available(), "source_revision": self.source_revision}

    def configure_source(self, value: str) -> int:
        if not isinstance(value, str) or not value.strip() or len(value) > 32768 or "\0" in value:
            raise ValueError("请选择照片文件夹，或填写它的完整路径。")
        candidate = Path(value.strip()).expanduser()
        if not candidate.is_absolute():
            raise ValueError("请填写完整的文件夹路径，例如 D:\\VRChatPhotos。")
        candidate = candidate.resolve()
        if self.data == candidate or candidate in self.data.parents:
            raise ValueError("照片目录不能包含相册的数据目录，请选择原照片文件夹。")
        if not candidate.is_dir():
            raise ValueError("找不到这个照片文件夹，请检查路径或重新选择。")
        try:
            with os.scandir(candidate):
                pass
        except OSError as exc:
            raise ValueError("无法读取这个文件夹，请选择当前用户有权读取的照片目录。") from exc
        with self.lock:
            if self.configured and candidate == self.source:
                return self.source_revision
            try:
                self.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('source',?)", (str(candidate),))
                self.db.commit()
            except sqlite3.Error:
                self.db.rollback()
                raise
            self.source = candidate
            self.configured = True
            self.source_revision += 1
            self.revision += 1
            self.ready = False
            self.scanning = False
            self.scan_phase = "idle"
            self.error = None
            self.scan_errors = []
            self.last_scan = None
            self.processed = self.discovered = 0
            self.scan_event.set()
            return self.source_revision

    def _read_photo(self, path: Path, stat) -> dict:
        # Read with normal read-only handles; a producer can still finish another photo.
        hasher = hashlib.sha256()
        with path.open("rb") as source:
            while block := source.read(1024 * 1024):
                hasher.update(block)
        digest = hasher.hexdigest()
        with Image.open(path) as photo:
            metadata = dict(photo.info)
            exif = photo.getexif()
            metadata["DateTime"] = exif.get(306, metadata.get("DateTime"))
            metadata["DateTimeOriginal"] = exif.get(36867, metadata.get("DateTimeOriginal"))
            try:
                metadata["DateTimeOriginal"] = exif.get_ifd(34665).get(36867, metadata.get("DateTimeOriginal"))
            except (KeyError, TypeError):
                pass
            picture = ImageOps.exif_transpose(photo)
            width, height = picture.size
            thumb_path = self.thumbs / f"{digest}.jpg"
            if not thumb_path.is_file():
                picture.thumbnail((720, 720), Image.Resampling.LANCZOS)
                if picture.mode in ("RGBA", "LA") or "transparency" in picture.info:
                    rgba = picture.convert("RGBA")
                    bg = Image.new("RGB", picture.size, (24, 24, 24))
                    bg.paste(rgba, mask=rgba.getchannel("A"))
                    picture = bg
                else:
                    picture = picture.convert("RGB")
                temp = thumb_path.with_suffix(".tmp")
                picture.save(temp, "JPEG", quality=84, optimize=True)
                os.replace(temp, thumb_path)
        new_stat = path.stat()
        if new_stat.st_size != stat.st_size or new_stat.st_mtime_ns != stat.st_mtime_ns:
            raise OSError("照片仍在写入，下一轮会自动重试。")
        captured_at, quality = photo_time(path, metadata, stat.st_mtime)
        world, world_id = world_metadata(metadata)
        return {"id": digest, "width": width, "height": height,
                "captured_at": captured_at, "date_quality": quality,
                "world": world, "world_id": world_id}

    def scan(self):
        if not self.scan_lock.acquire(blocking=False):
            return
        with self.lock:
            if not self.configured:
                self.scan_lock.release()
                return
            source = self.source
            generation = self.source_revision
            key = source_key(source)
            self.scanning = True
            self.scan_phase = "discovering"
            self.processed = 0
            self.discovered = 0
            self.scan_errors = []
        def cancelled():
            with self.lock:
                return self.source_revision != generation or self.stop_event.is_set()
        try:
            if not source.is_dir():
                raise FileNotFoundError(f"找不到照片目录：{source}。已有索引已保留，请检查目录。")
            paths = []
            walk_errors = []
            for folder, dirs, names in os.walk(source, followlinks=False,
                                               onerror=lambda err: walk_errors.append(err)):
                if cancelled():
                    return
                dirs[:] = [name for name in dirs if not (Path(folder) / name).is_symlink()]
                for name in names:
                    path = Path(folder) / name
                    if path.suffix.lower() in EXTENSIONS and not path.is_symlink():
                        paths.append(path)
                with self.lock:
                    if self.source_revision == generation:
                        self.discovered = len(paths)
            with self.lock:
                if self.source_revision != generation:
                    return
                self.discovered = len(paths)
                self.scan_phase = "processing"
                cache = {row["path"]: dict(row) for row in self.db.execute("SELECT * FROM files WHERE source=?", (key,))}
            seen = set()
            errors = []
            changed = False
            for path in sorted(paths):
                if cancelled():
                    return
                rel = str(path.relative_to(source))
                seen.add(rel)
                try:
                    stat = path.stat()
                    previous = cache.get(rel)
                    thumb_ok = previous and (self.thumbs / f"{previous['id']}.jpg").is_file()
                    if previous and previous["size"] == stat.st_size and previous["mtime_ns"] == stat.st_mtime_ns and thumb_ok:
                        continue
                    if time.time() - stat.st_mtime < 2:
                        continue
                    item = self._read_photo(path, stat)
                    with self.lock:
                        if self.source_revision != generation or self.stop_event.is_set():
                            return
                        self.db.execute("INSERT OR IGNORE INTO photos(id, width, height,world,world_id) VALUES (?, ?, ?,?,?)",
                                        (item["id"], item["width"], item["height"], item["world"], item["world_id"]))
                        self.db.execute("UPDATE photos SET world=? WHERE id=? AND world='' AND world_custom=0",
                                        (item["world"], item["id"]))
                        self.db.execute("UPDATE photos SET world_id=? WHERE id=? AND world_id=''",
                                        (item["world_id"], item["id"]))
                        self.db.execute("INSERT OR REPLACE INTO files(source,path,id,size,mtime_ns,captured_at,date_quality) VALUES(?,?,?,?,?,?,?)",
                                        (key, rel, item["id"], stat.st_size, stat.st_mtime_ns,
                                         item["captured_at"], item["date_quality"]))
                        self.db.commit()
                        self.revision += 1
                        changed = True
                except (OSError, ValueError, Image.DecompressionBombError) as exc:
                    errors.append({"file": rel, "message": str(exc)})
                    logging.warning("Cannot index %s: %s", rel, exc)
                finally:
                    with self.lock:
                        if self.source_revision == generation:
                            self.processed += 1
            with self.lock:
                if self.source_revision != generation or self.stop_event.is_set():
                    return
                # A failed traversal may temporarily hide a whole folder; preserve its index.
                if not walk_errors:
                    missing = set(cache) - seen
                    self.db.executemany("DELETE FROM files WHERE source=? AND path=?", ((key, path) for path in missing))
                    if missing:
                        changed = True
                    self.db.commit()
                self.scan_errors = errors[:50]
                self.error = str(walk_errors[0]) if walk_errors else None
                self.last_scan = datetime.now().isoformat(timespec="seconds")
                self.ready = True
                if changed:
                    self.revision += 1
        except Exception as exc:
            logging.exception("Scan failed")
            with self.lock:
                if self.source_revision == generation:
                    self.error = str(exc)
                    self.ready = True
        finally:
            with self.lock:
                if self.source_revision == generation:
                    self.scanning = False
                    self.scan_phase = "idle"
            self.scan_lock.release()

    def _state(self) -> dict:
        counts = self.db.execute("SELECT count(*),count(DISTINCT id) FROM files WHERE source=?", (source_key(self.source),)).fetchone()
        return {"app": APP_ID, "version": APP_VERSION, "source": str(self.source),
                "data": str(self.data),
                "configured": self.configured, "source_revision": self.source_revision,
                "ready": self.ready, "scanning": self.scanning, "scan_phase": self.scan_phase,
                "error": self.error, "scan_errors": list(self.scan_errors),
                "last_scan": self.last_scan, "processed": self.processed,
                "discovered": self.discovered, "revision": self.revision,
                "total_files": counts[0], "duplicates": counts[0] - counts[1]}

    def status(self) -> dict:
        with self.lock:
            return self._state()

    def catalog(self) -> dict:
        with self.lock:
            key = source_key(self.source)
            files = [dict(row) for row in self.db.execute("SELECT * FROM files WHERE source=? ORDER BY date_quality DESC, path ASC", (key,))]
            records = {row["id"]: dict(row) for row in self.db.execute("SELECT * FROM photos WHERE id IN (SELECT id FROM files WHERE source=?)", (key,))}
            state = self._state()
            state["custom_collections"] = self.collection_list()
            state["collection_displays"] = self.collection_displays()
        photos = {}
        for file in files:
            digest = file["id"]
            if digest in photos:
                photos[digest]["copies"] += 1
                continue
            record = records[digest]
            photos[digest] = {
                "id": digest, "filename": Path(file["path"]).name,
                "captured_at": file["captured_at"], "date": file["captured_at"][:10],
                "month": file["captured_at"][:7], "width": record["width"], "height": record["height"],
                "world": record["world"], "world_id": record["world_id"],
                "tags": json.loads(record["tags"]), "note": record["note"],
                "favorite": bool(record["favorite"]), "copies": 1,
                "date_source": {3: "filename", 2: "metadata", 1: "modified"}[file["date_quality"]],
                "thumb_url": f"/api/photo/{digest}/thumb", "original_url": f"/api/photo/{digest}/original",
            }
        ordered = sorted(photos.values(), key=lambda row: (row["captured_at"], row["id"]))
        session_start = None
        previous_time = None
        for photo in ordered:
            when = datetime.fromisoformat(photo["captured_at"])
            if previous_time is None or when - previous_time > timedelta(minutes=90):
                session_start = when
            photo["session_id"] = session_start.isoformat(timespec="seconds")
            photo["session_label"] = session_start.strftime("%Y-%m-%d %H:%M")
            previous_time = when
        state.update({"photos": list(reversed(ordered)), "total_files": len(files),
                      "duplicates": len(files) - len(ordered)})
        return state

    def edit(self, ids: list[str], changes: dict):
        if not isinstance(ids, list) or not ids or len(ids) > 2000 or any(not isinstance(i, str) or not PHOTO_ID.fullmatch(i) for i in ids):
            raise ValueError("请选择有效的照片。")
        normalized = annotation_values(changes)
        fields = [f"{key}=?" for key in normalized]
        values = list(normalized.values())
        with self.lock, self.db:
            placeholders = ",".join("?" for _ in ids)
            found = self.db.execute(f"SELECT count(*) FROM photos WHERE id IN ({placeholders}) AND id IN (SELECT id FROM files WHERE source=?)", ids + [source_key(self.source)]).fetchone()[0]
            if found != len(set(ids)):
                raise ValueError("部分照片不在相册索引中。")
            before = self.annotation_snapshot(ids)
            self.db.execute(f"UPDATE photos SET {','.join(fields)} WHERE id IN ({placeholders})", values + ids)
            if "world" in changes:
                self.db.execute(f"UPDATE photos SET world_custom=1 WHERE id IN ({placeholders})", ids)
            self.record_edit(before, self.annotation_snapshot(ids), "批量整理" if len(set(ids)) > 1 else "照片标注或星标")
            self.revision += 1

    def original(self, digest: str) -> Path | None:
        if not PHOTO_ID.fullmatch(digest):
            return None
        with self.lock:
            source = self.source
            rows = self.db.execute("SELECT path FROM files WHERE source=? AND id=? ORDER BY date_quality DESC,path", (source_key(source), digest)).fetchall()
        for row in rows:
            candidate = (source / row["path"]).resolve()
            if source in candidate.parents and candidate.is_file():
                return candidate
        return None

    def contains(self, digest: str) -> bool:
        with self.lock:
            return bool(self.db.execute("SELECT 1 FROM files WHERE source=? AND id=? LIMIT 1", (source_key(self.source), digest)).fetchone())

    def watch(self, interval: int):
        while not self.stop_event.is_set():
            self.scan_event.clear()
            self.scan()
            self.scan_event.wait(interval)

    def close(self):
        with self.lock:
            self.db.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        if args and str(args[1] if len(args) > 1 else "") not in ("200", "202"):
            logging.info(format, *args)

    @property
    def album(self):
        return self.server.album

    def _valid_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def respond(self, code, value):
        content = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_file(self, path, mime=None):
        try:
            with path.open("rb") as file:
                self.send_response(200)
                self.send_header("Content-Type", mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(os.fstat(file.fileno()).st_size))
                self.send_header("X-Content-Type-Options", "nosniff")
                cache_control = "no-cache" if path.suffix == ".html" else "private, max-age=86400"
                asset_root = (BASE / "web" / "dist" / "assets").resolve()
                if path.suffix != ".html" and asset_root in path.resolve().parents and re.search(r"-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$", path.name):
                    cache_control = "private, max-age=31536000, immutable"
                self.send_header("Cache-Control", cache_control)
                if path.suffix == ".html":
                    self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
                self.end_headers()
                while chunk := file.read(128 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except FileNotFoundError:
            self.respond(404, {"error": "照片暂时不可用，正在等待下一次扫描。"})

    def send_frontend(self):
        entry = BASE / "web" / "dist" / "index.html"
        if not entry.is_file():
            self.respond(503, {"error": "缺少相册界面文件。请下载并解压完整的项目 ZIP；开发者请在 frontend 目录运行 npm ci 和 npm run build，再刷新页面。"})
            return
        self.send_file(entry, "text/html; charset=utf-8")

    def do_GET(self):
        if not self._valid_host():
            self.respond(403, {"error": "只允许在本机打开相册。"})
            return
        route = urlparse(self.path).path
        if route == "/api/catalog/page":
            try:
                query = parse_qs(urlparse(self.path).query)
                self.respond(200, self.album.catalog_page(int(query.get('offset',['0'])[0]), int(query.get('limit',['256'])[0]), query.get('snapshot',[None])[0]))
            except CatalogChanged as exc:
                self.respond(409, {"error":str(exc)})
            except ValueError as exc:
                self.respond(400, {"error":str(exc)})
        elif route in ("/api/catalog", "/api/status"):
            state = self.album.status() if route == "/api/status" else self.album.catalog()
            self.respond(200, state)
        elif route == "/api/history":
            self.respond(200, self.album.history())
        elif route == "/api/similar":
            try:
                self.respond(200, self.album.similar_groups())
            except ValueError as exc:
                self.respond(400, {"error": str(exc)})
        elif route == "/api/collections/cover":
            try:
                query = parse_qs(urlparse(self.path).query)
                content = self.album.collection_cover(query.get('id', [''])[0], int(query.get('revision', ['-1'])[0]), int(query.get('source_revision', ['-1'])[0]))
            except ValueError:
                content = None
            if content:
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(content)
            else:
                self.respond(404, {"error": "封面不可用，请刷新合集。"})
        elif route == "/api/settings":
            self.respond(200, self.album.settings())
        elif route == "/api/export":
            content = json.dumps(self.album.export_annotations(), ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="vrchat-album.json"')
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif match := re.fullmatch(r"/api/photo/([a-f0-9]{64})/(thumb|original)", route):
            digest, kind = match.groups()
            path = None
            if self.album.contains(digest):
                path = self.album.thumbs / f"{digest}.jpg" if kind == "thumb" else self.album.original(digest)
            if path and path.is_file():
                self.send_file(path)
            else:
                self.respond(404, {"error": "照片不存在。"})
        elif route in ("/", "/index.html", "/guide", "/web/guide.html"):
            self.send_frontend()
        elif route == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif route.startswith("/web/"):
            path = (BASE / route.lstrip("/")).resolve()
            if (BASE / "web").resolve() in path.parents and path.is_file():
                self.send_file(path)
            else:
                self.respond(404, {"error": "页面文件不存在。"})
        else:
            self.respond(404, {"error": "没有这个地址。"})

    def do_POST(self):
        expected_origin = f"http://127.0.0.1:{self.server.server_port}"
        origin = self.headers.get("Origin")
        if not self._valid_host() or (origin and origin != expected_origin) or self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.respond(403, {"error": "请求来源不正确。"})
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self.respond(415, {"error": "请使用相册界面操作。"})
            return
        try:
            route = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= (16 * 1024 * 1024 if route in ("/api/import/preview", "/api/import/apply", "/api/collections/display") else 1024 * 1024):
                raise ValueError("请求太大。")
            body = json.loads(self.rfile.read(length) or b"{}")
            route = urlparse(self.path).path
            if route == "/api/settings/source":
                if not isinstance(body, dict) or set(body) != {"source"}:
                    raise ValueError("请选择照片目录。")
                revision = self.album.configure_source(body["source"])
                self.respond(200, {"ok": True, "source": str(self.album.source), "source_revision": revision})
            elif route == "/api/pick-folder":
                if not isinstance(body, dict) or body:
                    raise ValueError("文件夹选择请求无效。")
                path = pick_folder(self.album.source)
                self.respond(200, {"path": path, "cancelled": path is None})
            elif route == "/api/edit":
                if not isinstance(body, dict):
                    raise ValueError("编辑格式无效。")
                self.album.edit(body.get("ids"), {key: value for key, value in body.items() if key != "ids"})
                self.respond(200, {"ok": True})
            elif route == "/api/history/undo":
                self.album.undo_edit(body)
                self.respond(200, {"ok": True})
            elif route in ("/api/import/preview", "/api/import/apply"):
                self.respond(200, self.album.import_annotations(body, apply=route.endswith("/apply")))
            elif route == "/api/collections/save":
                self.respond(200, {"collection": self.album.save_collection(body)})
            elif route == "/api/collections/display":
                self.respond(200, {"display": self.album.save_collection_display(body)})
            elif route == "/api/scan":
                self.album.scan_event.set()
                self.respond(202, {"ok": True})
            elif route == "/api/shutdown":
                self.respond(200, {"ok": True})
                self.album.stop_event.set()
                self.album.scan_event.set()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self.respond(404, {"error": "没有这个操作。"})
        except (ValueError, TypeError) as exc:
            self.respond(400, {"error": str(exc)})
        except PickerBusy as exc:
            self.respond(409, {"error": str(exc)})
        except RuntimeError as exc:
            self.respond(503, {"error": str(exc)})
        except sqlite3.Error:
            self.respond(503, {"error": "无法保存设置，请检查相册数据目录是否可写，再重试。"})


def main():
    parser = argparse.ArgumentParser(description="VRChat 本地相册")
    parser.add_argument("--source", type=Path, help="指定并记住照片目录；未指定时使用已保存目录，首次在网页选择")
    parser.add_argument("--data", type=Path, default=BASE / "data", help="索引与缩略图目录，默认项目 data/，必须位于照片目录之外")
    parser.add_argument("--port", type=int, default=18764, help="本机端口，默认 18764")
    parser.add_argument("--interval", type=int, default=20, help="自动扫描间隔（秒），默认 20，最少 5")
    parser.add_argument("--open-browser", action="store_true", help="启动后立即打开浏览器，选择照片目录并查看整理进度")
    args = parser.parse_args()
    # Validate before creating directories or logs, including rejected startups.
    args.data = args.data.resolve()
    explicit_source = args.source is not None
    try:
        saved_source = None if explicit_source else read_saved_source(args.data)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        saved_source = None
    except (OSError, sqlite3.Error) as exc:
        parser.exit(1, f"无法读取相册数据，请先备份数据目录再检查：{exc}\n")
    configured = explicit_source or saved_source is not None
    args.source = (args.source or saved_source or DEFAULT_SOURCE).resolve()
    if args.data == args.source or args.source in args.data.parents:
        parser.error("相册数据目录必须放在原照片目录之外。")
    if args.port:
        connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=2)
        try:
            connection.request("GET", "/api/status")
            response = connection.getresponse()
            existing = json.loads(response.read()) if response.status == 200 else {}
            if existing.get("app") == APP_ID:
                if existing.get("version") != APP_VERSION:
                    parser.exit(1, "旧版本的相册仍在运行。请在原页面点击“停止后台”，然后重新打开相册。\n")
                if existing.get("data") != str(args.data):
                    parser.exit(1, "这个端口已用于另一个相册数据目录，请用 --port 指定其他端口。\n")
                if explicit_source and (not existing.get("configured") or existing.get("source") != str(args.source)):
                    connection.request("POST", "/api/settings/source", json.dumps({"source": str(args.source)}), {"Content-Type": "application/json"})
                    update = connection.getresponse()
                    result = json.loads(update.read())
                    if update.status != 200:
                        parser.exit(1, result.get("error", "无法更换照片目录。") + "\n")
                url = f"http://127.0.0.1:{args.port}"
                print(f"相册已经运行：{url}", flush=True)
                if args.open_browser:
                    webbrowser.open(url)
                return
        except (OSError, ValueError):
            pass
        finally:
            connection.close()
    args.data.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=args.data / "service.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", encoding="utf-8")
    album = Album(args.source, args.data, configured=configured)
    # Only loopback: no LAN access and no public exposure.
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        album.close()
        parser.exit(1, f"无法在本机端口 {args.port} 启动相册：{exc}\n请关闭占用该端口的程序，或用 --port 指定其他端口。\n")
    server.daemon_threads = True
    server.album = album
    worker = threading.Thread(target=album.watch, args=(max(5, args.interval),), daemon=True)
    worker.start()
    state_path = args.data / "runtime.json"
    state_path.write_text(json.dumps({"app": APP_ID, "pid": os.getpid(),
                                      "url": f"http://127.0.0.1:{server.server_port}"}), encoding="utf-8")
    url = f"http://127.0.0.1:{server.server_port}"
    hint = f"照片目录：{album.source}" if configured else "首次使用：在网页选择你的 VRChat 照片文件夹。"
    print(f"VRChat 本地相册：{url}\n{hint}\n每 {max(5, args.interval)} 秒自动检查新照片。关闭此窗口或按 Ctrl+C 停止。", flush=True)
    if args.open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\n相册已停止。", flush=True)
    finally:
        album.stop_event.set()
        album.scan_event.set()
        worker.join(timeout=30)
        server.server_close()
        if not worker.is_alive():
            album.close()


if __name__ == "__main__":
    main()
