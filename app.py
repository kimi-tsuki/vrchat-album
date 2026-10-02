"""A local, read-only photo index for VRChat. Originals are never modified."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import logging
import mimetypes
import os
import re
import sqlite3
import threading
import time
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageOps

APP_ID = "vrchat-local-album-v1"
DEFAULT_SOURCE = Path.home() / "Pictures" / "VRChat"
BASE = Path(__file__).resolve().parent
APP_VERSION = (BASE / "VERSION").read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", APP_VERSION):
    raise ValueError("VERSION 文件中的版本号无效。")
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SHOT_DATE = re.compile(r"VRChat_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:\.(\d+))?", re.I)
PHOTO_ID = re.compile(r"^[a-f0-9]{64}$")


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


class Album:
    def __init__(self, source: Path, data: Path):
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
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY, id TEXT NOT NULL, size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL, captured_at TEXT NOT NULL,
                date_quality INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS file_photo ON files(id);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(photos)")}
        for column in ("world_id", "world_custom"):
            if column not in columns:
                declaration = "TEXT NOT NULL DEFAULT ''" if column == "world_id" else "INTEGER NOT NULL DEFAULT 0"
                self.db.execute(f"ALTER TABLE photos ADD COLUMN {column} {declaration}")
        self.db.commit()
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
            self.scanning = True
            self.processed = 0
            self.scan_errors = []
        try:
            if not self.source.is_dir():
                raise FileNotFoundError(f"找不到照片目录：{self.source}。已有索引已保留，请检查目录。")
            paths = []
            walk_errors = []
            for folder, dirs, names in os.walk(self.source, followlinks=False,
                                               onerror=lambda err: walk_errors.append(err)):
                dirs[:] = [name for name in dirs if not (Path(folder) / name).is_symlink()]
                for name in names:
                    path = Path(folder) / name
                    if path.suffix.lower() in EXTENSIONS and not path.is_symlink():
                        paths.append(path)
            with self.lock:
                self.discovered = len(paths)
                cache = {row["path"]: dict(row) for row in self.db.execute("SELECT * FROM files")}
            seen = set()
            errors = []
            changed = False
            for path in sorted(paths):
                rel = str(path.relative_to(self.source))
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
                        self.db.execute("INSERT OR IGNORE INTO photos(id, width, height,world,world_id) VALUES (?, ?, ?,?,?)",
                                        (item["id"], item["width"], item["height"], item["world"], item["world_id"]))
                        self.db.execute("UPDATE photos SET world=? WHERE id=? AND world='' AND world_custom=0",
                                        (item["world"], item["id"]))
                        self.db.execute("UPDATE photos SET world_id=? WHERE id=? AND world_id=''",
                                        (item["world_id"], item["id"]))
                        self.db.execute("INSERT OR REPLACE INTO files(path,id,size,mtime_ns,captured_at,date_quality) VALUES(?,?,?,?,?,?)",
                                        (rel, item["id"], stat.st_size, stat.st_mtime_ns,
                                         item["captured_at"], item["date_quality"]))
                        self.db.commit()
                        changed = True
                except (OSError, ValueError, Image.DecompressionBombError) as exc:
                    errors.append({"file": rel, "message": str(exc)})
                    logging.warning("Cannot index %s: %s", rel, exc)
                finally:
                    with self.lock:
                        self.processed += 1
            with self.lock:
                # A failed traversal may temporarily hide a whole folder; preserve its index.
                if not walk_errors:
                    missing = set(cache) - seen
                    self.db.executemany("DELETE FROM files WHERE path=?", ((path,) for path in missing))
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
                self.error = str(exc)
                self.ready = True
        finally:
            with self.lock:
                self.scanning = False
            self.scan_lock.release()

    def catalog(self) -> dict:
        with self.lock:
            files = [dict(row) for row in self.db.execute("SELECT * FROM files ORDER BY date_quality DESC, path ASC")]
            records = {row["id"]: dict(row) for row in self.db.execute("SELECT * FROM photos")}
            state = {"app": APP_ID, "version": APP_VERSION, "source": str(self.source), "ready": self.ready,
                     "scanning": self.scanning, "error": self.error, "scan_errors": list(self.scan_errors),
                     "last_scan": self.last_scan, "processed": self.processed,
                     "discovered": self.discovered, "revision": self.revision}
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
        allowed = {"world", "tags", "note", "favorite"}
        if not isinstance(changes, dict) or not changes or set(changes) - allowed:
            raise ValueError("编辑字段无效。")
        fields = []
        values = []
        for key, value in changes.items():
            if key in ("world", "note"):
                limit = 200 if key == "world" else 4000
                if not isinstance(value, str) or len(value) > limit:
                    raise ValueError("世界名或备注太长。")
                value = value.strip()
            elif key == "tags":
                if not isinstance(value, list) or len(value) > 30 or any(not isinstance(tag, str) or len(tag) > 80 for tag in value):
                    raise ValueError("标签格式无效。")
                value = json.dumps(list(dict.fromkeys(tag.strip() for tag in value if tag.strip())), ensure_ascii=False)
            elif key == "favorite":
                if not isinstance(value, bool):
                    raise ValueError("收藏状态无效。")
                value = int(value)
            fields.append(f"{key}=?")
            values.append(value)
        with self.lock:
            placeholders = ",".join("?" for _ in ids)
            found = self.db.execute(f"SELECT count(*) FROM photos WHERE id IN ({placeholders})", ids).fetchone()[0]
            if found != len(set(ids)):
                raise ValueError("部分照片不在相册索引中。")
            self.db.execute(f"UPDATE photos SET {','.join(fields)} WHERE id IN ({placeholders})", values + ids)
            if "world" in changes:
                self.db.execute(f"UPDATE photos SET world_custom=1 WHERE id IN ({placeholders})", ids)
            self.db.commit()
            self.revision += 1

    def original(self, digest: str) -> Path | None:
        if not PHOTO_ID.fullmatch(digest):
            return None
        with self.lock:
            rows = self.db.execute("SELECT path FROM files WHERE id=? ORDER BY date_quality DESC,path", (digest,)).fetchall()
        for row in rows:
            candidate = (self.source / row["path"]).resolve()
            if self.source in candidate.parents and candidate.is_file():
                return candidate
        return None

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
                self.send_header("Cache-Control", "no-cache" if path.suffix == ".html" else "private, max-age=86400")
                if path.suffix == ".html":
                    self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
                self.end_headers()
                while chunk := file.read(128 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except FileNotFoundError:
            self.respond(404, {"error": "照片暂时不可用，正在等待下一次扫描。"})

    def do_GET(self):
        if not self._valid_host():
            self.respond(403, {"error": "只允许在本机打开相册。"})
            return
        route = urlparse(self.path).path
        if route in ("/api/catalog", "/api/status"):
            state = self.album.catalog()
            if route == "/api/status":
                state.pop("photos")
            self.respond(200, state)
        elif route == "/api/export":
            content = json.dumps(self.album.catalog(), ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="vrchat-album.json"')
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif match := re.fullmatch(r"/api/photo/([a-f0-9]{64})/(thumb|original)", route):
            digest, kind = match.groups()
            path = self.album.thumbs / f"{digest}.jpg" if kind == "thumb" else self.album.original(digest)
            if path and path.is_file():
                self.send_file(path)
            else:
                self.respond(404, {"error": "照片不存在。"})
        elif route in ("/", "/index.html"):
            self.send_file(BASE / "web" / "index.html", "text/html; charset=utf-8")
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
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= 1024 * 1024:
                raise ValueError("请求太大。")
            body = json.loads(self.rfile.read(length) or b"{}")
            route = urlparse(self.path).path
            if route == "/api/edit":
                if not isinstance(body, dict):
                    raise ValueError("编辑格式无效。")
                self.album.edit(body.get("ids"), {key: value for key, value in body.items() if key != "ids"})
                self.respond(200, {"ok": True})
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


def main():
    parser = argparse.ArgumentParser(description="VRChat 本地相册")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--data", type=Path, default=BASE / "data")
    parser.add_argument("--port", type=int, default=18764)
    parser.add_argument("--interval", type=int, default=20)
    parser.add_argument("--open-browser", action="store_true", help="整理完成后打开浏览器")
    args = parser.parse_args()
    # Validate before creating directories or logs, including rejected startups.
    args.source = args.source.resolve()
    args.data = args.data.resolve()
    if args.data == args.source or args.source in args.data.parents:
        parser.error("相册数据目录必须放在原照片目录之外。")
    if args.port:
        connection = http.client.HTTPConnection("127.0.0.1", args.port, timeout=2)
        try:
            connection.request("GET", "/api/status")
            response = connection.getresponse()
            existing = json.loads(response.read()) if response.status == 200 else {}
            if existing.get("app") == APP_ID and existing.get("source") == str(args.source.resolve()):
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
    album = Album(args.source, args.data)
    # Only loopback: no LAN access and no public exposure.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.album = album
    worker = threading.Thread(target=album.watch, args=(max(5, args.interval),), daemon=True)
    worker.start()
    state_path = args.data / "runtime.json"
    state_path.write_text(json.dumps({"app": APP_ID, "pid": os.getpid(),
                                      "url": f"http://127.0.0.1:{server.server_port}"}), encoding="utf-8")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"VRChat 本地相册：{url}\n照片目录：{album.source}\n每 {max(5, args.interval)} 秒自动检查新照片。关闭此窗口或按 Ctrl+C 停止。", flush=True)
    if args.open_browser:
        def open_when_ready():
            while not album.ready and not album.stop_event.wait(0.25):
                pass
            if not album.stop_event.is_set():
                webbrowser.open(url)
        threading.Thread(target=open_when_ready, daemon=True).start()
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
