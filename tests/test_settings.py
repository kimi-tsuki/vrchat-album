"""Onboarding, source switching, migration, and settings HTTP regressions."""
from __future__ import annotations

from contextlib import closing, contextmanager
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from PIL import Image


APP = Path(__file__).resolve().parent.parent / "app.py"
spec = importlib.util.spec_from_file_location("vrchat_album_settings_backend", APP)
backend = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backend
spec.loader.exec_module(backend)


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(__file__).resolve().parent / "scratch"
        self.scratch.mkdir(exist_ok=True)
        self.base = self.scratch / f"settings-{uuid.uuid4().hex}"
        self.base.mkdir()
        self.addCleanup(self.cleanup)
        self.source = self.base / "相册 A"
        self.other = self.base / "相册 B"
        self.data = self.base / "data"
        self.source.mkdir()
        self.other.mkdir()
        self.album = backend.Album(self.source, self.data, configured=False)

    def tearDown(self):
        self.album.close()

    def cleanup(self):
        if self.base.resolve().parent != self.scratch.resolve():
            raise AssertionError("Refusing cleanup outside settings test scratch")
        shutil.rmtree(self.base)

    def image(self, source, filename="same.png", color="red"):
        path = source / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (48, 36), color).save(path)
        old = time.time() - 10
        os.utime(path, (old, old))
        return path

    def photos(self):
        return self.album.catalog()["photos"]

    def activate(self, source=None):
        revision = self.album.configure_source(str(source or self.source))
        self.album.scan()
        return revision

    def legacy_index(self):
        image = self.image(self.source)
        photo_id = hashlib.sha256(image.read_bytes()).hexdigest()
        stat = image.stat()
        legacy_data = self.base / "legacy-data"
        legacy_data.mkdir()
        with closing(sqlite3.connect(legacy_data / "album.sqlite3")) as db:
            db.executescript("""
                CREATE TABLE photos(id TEXT PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL,
                    world TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                    note TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE files(path TEXT PRIMARY KEY, id TEXT NOT NULL, size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL, captured_at TEXT NOT NULL, date_quality INTEGER NOT NULL);
                CREATE INDEX file_photo ON files(id);
            """)
            db.execute("INSERT INTO photos VALUES(?,?,?,?,?,?,?)", (photo_id, 48, 36, "旧世界", '["旧标签"]', "旧备注", 1))
            db.execute("INSERT INTO files VALUES(?,?,?,?,?,?)", (image.name, photo_id, stat.st_size, stat.st_mtime_ns, "2026-10-02T20:00:00", 1))
            db.commit()
        return legacy_data, photo_id

    def unknown_legacy_rows(self):
        return [tuple(row) for row in self.album.db.execute(
            "SELECT source,path,id,size,captured_at,date_quality FROM files WHERE source='' ORDER BY path"
        )]

    def test_unconfigured_album_does_not_scan_or_save_default_source(self):
        self.image(self.source)
        self.album.scan()
        self.assertEqual(self.photos(), [])
        self.assertFalse(self.album.catalog()["configured"])
        self.assertIsNone(backend.read_saved_source(self.data))
        self.assertEqual(list((self.data / "thumbs").iterdir()), [])

    def test_configuration_is_saved_and_restored_after_restart(self):
        self.image(self.source)
        revision = self.activate()
        self.assertTrue(self.album.catalog()["configured"])
        self.assertIsInstance(revision, int)
        self.assertGreater(revision, 0)
        self.assertEqual(backend.read_saved_source(self.data), self.source.resolve())
        old_id = self.photos()[0]["id"]
        self.album.close()
        self.album = backend.Album(backend.read_saved_source(self.data), self.data)
        self.album.scan()
        self.assertEqual(self.photos()[0]["id"], old_id)

    def test_unconfirmed_restart_still_requires_folder_setup(self):
        self.image(self.source)
        self.album.scan()
        self.album.close()
        saved = backend.read_saved_source(self.data)
        legacy = backend.has_legacy_index(self.data)
        self.assertIsNone(saved)
        self.assertFalse(legacy)
        self.album = backend.Album(self.source, self.data, configured=saved is not None or legacy)
        self.album.scan()
        self.assertFalse(self.album.settings()["configured"])
        self.assertFalse(self.album.catalog()["configured"])
        self.assertEqual(self.photos(), [])
        self.assertIsNone(backend.read_saved_source(self.data))
        self.assertEqual(list((self.data / "thumbs").iterdir()), [])

    def test_rejected_sources_leave_configuration_and_index_unchanged(self):
        image = self.image(self.source)
        revision = self.activate()
        ids = {photo["id"] for photo in self.photos()}
        originals = image.read_bytes()
        targets = ("relative/photos", str(self.base / "missing"), str(image), str(self.base))
        for target in targets:
            with self.subTest(source=target):
                with self.assertRaises(ValueError):
                    self.album.configure_source(target)
                self.assertEqual(backend.read_saved_source(self.data), self.source.resolve())
                self.assertEqual(self.album.source, self.source.resolve())
                self.assertEqual(self.album.catalog()["source_revision"], revision)
                self.assertEqual({photo["id"] for photo in self.photos()}, ids)
        self.assertEqual(image.read_bytes(), originals)

    def test_unreadable_source_does_not_replace_working_configuration(self):
        self.image(self.source)
        revision = self.activate()
        before = self.photos()
        with patch.object(backend.os, "access", return_value=False), patch.object(backend.os, "scandir", side_effect=PermissionError("synthetic unreadable directory")), patch.object(Path, "iterdir", side_effect=PermissionError("synthetic unreadable directory")):
            with self.assertRaises(ValueError):
                self.album.configure_source(str(self.other))
        self.assertEqual(self.album.source, self.source.resolve())
        self.assertEqual(self.album.catalog()["source_revision"], revision)
        self.assertEqual(self.photos(), before)

    def test_switching_same_relative_path_does_not_reuse_cache_and_restores_annotations(self):
        first = self.image(self.source, color="red")
        second = self.image(self.other, color="blue")
        # Different photos with identical relative path, size and mtime exposed
        # the old cache's source-blind key even when no file metadata changed.
        size = max(first.stat().st_size, second.stat().st_size)
        timestamp = time.time() - 10
        for path in (first, second):
            path.write_bytes(path.read_bytes().ljust(size, b"\0"))
            os.utime(path, (timestamp, timestamp))
        original_bytes = {str(path): path.read_bytes() for path in (first, second)}
        self.activate()
        first_id = self.photos()[0]["id"]
        self.album.edit([first_id], {"favorite": True, "tags": ["朋友"], "world": "秘密花园", "note": "记住这一天"})
        revision = self.album.configure_source(str(self.other))
        self.assertFalse(self.album.catalog()["ready"])
        self.assertEqual(self.photos(), [])
        self.album.scan()
        second_photo = self.photos()[0]
        self.assertNotEqual(second_photo["id"], first_id)
        self.assertEqual(second_photo["id"], hashlib.sha256(second.read_bytes()).hexdigest())
        self.assertFalse(second_photo["favorite"])
        self.assertEqual(second_photo["tags"], [])
        self.assertEqual(self.album.catalog()["source_revision"], revision)
        self.activate(self.source)
        restored = self.photos()[0]
        self.assertEqual(restored["id"], first_id)
        self.assertTrue(restored["favorite"])
        self.assertEqual(restored["tags"], ["朋友"])
        self.assertEqual(restored["world"], "秘密花园")
        self.assertEqual(restored["note"], "记住这一天")
        self.assertEqual({str(path): path.read_bytes() for path in (first, second)}, original_bytes)

    def test_legacy_files_index_migrates_without_losing_annotations(self):
        legacy_data, photo_id = self.legacy_index()
        self.assertTrue(backend.has_legacy_index(legacy_data))
        self.album.close()
        self.album = backend.Album(self.source, legacy_data)
        self.assertFalse(backend.has_legacy_index(legacy_data))
        self.album.scan()
        restored = self.photos()[0]
        self.assertEqual(restored["id"], photo_id)
        self.assertEqual(restored["world"], "旧世界")
        self.assertEqual(restored["tags"], ["旧标签"])
        self.assertEqual(restored["note"], "旧备注")
        self.assertTrue(restored["favorite"])
        self.image(self.other, color="blue")
        self.activate(self.other)
        self.assertNotEqual(self.photos()[0]["id"], photo_id)
        self.activate(self.source)
        self.assertEqual(self.photos()[0]["tags"], ["旧标签"])

    def test_main_upgrade_without_source_does_not_assume_the_default_directory(self):
        legacy_data, _ = self.legacy_index()
        self.assertTrue(backend.has_legacy_index(legacy_data))
        argv = [str(APP), "--data", str(legacy_data), "--port", "0"]
        # Stop at construction to observe CLI decisions without a server,
        # browser, logger, or access to the user's default Pictures directory.
        with patch.object(backend.sys, "argv", argv), patch.object(backend, "DEFAULT_SOURCE", self.other), patch.object(backend.logging, "basicConfig"), patch.object(backend, "Album", side_effect=RuntimeError("captured isolated startup")) as constructor:
            with self.assertRaisesRegex(RuntimeError, "captured isolated startup"):
                backend.main()
            constructor.assert_called_once_with(self.other.resolve(), legacy_data.resolve(), configured=False)
        self.assertIsNone(backend.read_saved_source(legacy_data))
        self.assertTrue(backend.has_legacy_index(legacy_data))

    def test_unknown_legacy_source_is_preserved_and_restart_still_requires_setup(self):
        legacy_data, photo_id = self.legacy_index()
        self.album.close()
        self.album = backend.Album(self.other, legacy_data, configured=False)
        self.album.scan()
        rows = self.unknown_legacy_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0:3], ("", "same.png", photo_id))
        self.assertEqual(rows[0][4], "2026-10-02T20:00:00")
        self.assertFalse(self.album.settings()["configured"])
        self.assertEqual(self.photos(), [])
        self.assertIsNone(backend.read_saved_source(legacy_data))
        self.album.close()
        configured = backend.read_saved_source(legacy_data) is not None
        self.album = backend.Album(self.other, legacy_data, configured=configured)
        self.album.scan()
        self.assertFalse(self.album.settings()["configured"])
        self.assertEqual(self.unknown_legacy_rows(), rows)
        self.assertEqual(self.photos(), [])

    def test_confirming_wrong_directory_never_prunes_unknown_legacy_index(self):
        legacy_data, photo_id = self.legacy_index()
        self.album.close()
        self.album = backend.Album(self.other, legacy_data, configured=False)
        rows = self.unknown_legacy_rows()
        self.activate(self.other)  # A valid but incorrect empty directory.
        self.assertTrue(self.album.settings()["configured"])
        self.assertEqual(self.photos(), [])
        self.assertEqual(self.unknown_legacy_rows(), rows)
        self.activate(self.source)
        restored = self.photos()[0]
        self.assertEqual(restored["id"], photo_id)
        self.assertEqual(restored["tags"], ["旧标签"])
        self.assertEqual(restored["world"], "旧世界")
        self.assertEqual(restored["note"], "旧备注")
        self.assertTrue(restored["favorite"])
        self.assertEqual(self.unknown_legacy_rows(), rows)

    def test_switch_during_scan_cancels_stale_write_and_old_index_deletion(self):
        removed = self.image(self.source, "old.png", "red")
        self.image(self.source, "keep.png", "green")
        self.activate()
        old_ids = {photo["id"] for photo in self.photos()}
        removed.unlink()  # Synthetic photo only; a stale scan must not prune it.
        self.image(self.source, "new.png", "blue")
        self.image(self.other, "other.png", "yellow")
        entered = threading.Event()
        release = threading.Event()
        read_photo = self.album._read_photo

        def blocked_read(path, stat):
            if path.name == "new.png":
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("Timed out waiting for controlled source switch")
            return read_photo(path, stat)

        with patch.object(self.album, "_read_photo", side_effect=blocked_read):
            worker = threading.Thread(target=self.album.scan, daemon=True)
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                revision = self.album.configure_source(str(self.other))
                release.set()
                worker.join(5)
                self.assertFalse(worker.is_alive())
                self.assertEqual(self.album.catalog()["source_revision"], revision)
                self.assertEqual(self.photos(), [])
                self.assertFalse(self.album.catalog()["ready"])
                self.assertFalse(self.album.catalog()["scanning"])
                self.assertEqual(self.album.catalog()["processed"], 0)
                self.assertEqual(self.album.catalog()["discovered"], 0)
            finally:
                release.set()
                worker.join(5)
        self.album.configure_source(str(self.source))
        self.assertEqual({photo["id"] for photo in self.photos()}, old_ids)
        self.activate(self.other)
        self.assertEqual([photo["filename"] for photo in self.photos()], ["other.png"])
        self.assertTrue(self.album.catalog()["ready"])

    @contextmanager
    def http(self):
        server = backend.ThreadingHTTPServer(("127.0.0.1", 0), backend.Handler)
        server.daemon_threads = True
        server.album = self.album
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        origin = f"http://127.0.0.1:{server.server_port}"

        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                payload = None if body is None else json.dumps(body).encode("utf-8")
                options = {} if payload is None else {"Content-Type": "application/json", "Origin": origin}
                options.update(headers or {})
                connection.request(method, path, body=payload, headers=options)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        try:
            yield request, origin
        finally:
            server.shutdown()
            server.server_close()
            worker.join(5)
            self.assertFalse(worker.is_alive())

    def test_settings_http_configure_and_picker_cancel_or_selection(self):
        with self.http() as (request, _):
            status, settings = request("GET", "/api/settings")
            self.assertEqual(status, 200)
            self.assertFalse(settings["configured"])
            self.assertIn("default_source", settings)
            self.assertIn("source_exists", settings)
            self.assertIsInstance(settings["picker_available"], bool)
            status, selected = request("POST", "/api/settings/source", {"source": str(self.source)})
            self.assertEqual(status, 200)
            self.assertTrue(selected["ok"])
            self.assertEqual(selected["source"], str(self.source.resolve()))
            revision = selected["source_revision"]
            with patch.object(backend, "pick_folder", return_value=None) as picker:
                status, cancelled = request("POST", "/api/pick-folder", {})
                self.assertEqual(status, 200)
                picker.assert_called_once()
                self.assertTrue(cancelled["cancelled"])
                self.assertEqual(self.album.source, self.source.resolve())
                self.assertEqual(self.album.catalog()["source_revision"], revision)
            with patch.object(backend, "pick_folder", return_value=str(self.other)):
                status, picked = request("POST", "/api/pick-folder", {})
                self.assertEqual(status, 200)
                self.assertFalse(picked["cancelled"])
                self.assertEqual(picked["path"], str(self.other.resolve()))
                self.assertEqual(self.album.source, self.source.resolve())
                self.assertEqual(self.album.catalog()["source_revision"], revision)
                status, confirmed = request("POST", "/api/settings/source", {"source": picked["path"]})
                self.assertEqual(status, 200)
                self.assertTrue(confirmed["ok"])
                self.assertGreater(confirmed["source_revision"], revision)
            self.assertEqual(backend.read_saved_source(self.data), self.other.resolve())

    def test_settings_http_rejections_have_no_configuration_side_effects(self):
        self.image(self.source)
        revision = self.activate()
        before = self.photos()
        with self.http() as (request, origin), patch.object(backend, "pick_folder") as picker:
            for endpoint, body in (("/api/settings/source", {"source": str(self.other)}), ("/api/pick-folder", {})):
                for headers in ({"Host": "example.invalid"}, {"Origin": "https://example.invalid"}, {"Sec-Fetch-Site": "cross-site", "Origin": origin}, {"Content-Type": "text/plain"}):
                    with self.subTest(endpoint=endpoint, headers=headers):
                        status, _ = request("POST", endpoint, body, headers)
                        self.assertEqual(status, 415 if headers.get("Content-Type") == "text/plain" else 403)
            status, _ = request("POST", "/api/settings/source", {"source": str(self.base / "absent")})
            self.assertEqual(status, 400)
            for endpoint, invalid_body in (("/api/settings/source", {}), ("/api/settings/source", {"source": str(self.other), "unexpected": True}), ("/api/settings/source", []), ("/api/pick-folder", {"source": str(self.other)})):
                with self.subTest(endpoint=endpoint, invalid_body=invalid_body):
                    self.assertEqual(request("POST", endpoint, invalid_body)[0], 400)
            picker.assert_not_called()
        self.assertEqual(self.album.source, self.source.resolve())
        self.assertEqual(self.album.catalog()["source_revision"], revision)
        self.assertEqual(self.photos(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
