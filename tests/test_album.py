"""Regression checks using synthetic images, never the user's photo directory."""
from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from PIL import Image
from PIL.PngImagePlugin import PngInfo


TEST_FILE = Path(__file__).resolve()
APP_CANDIDATES = (
    TEST_FILE.parent.parent / "app.py",  # Delivered app: tests/test_album.py.
    TEST_FILE.parents[2] / "outputs" / "vrchat-album" / "app.py",  # Scratch copy.
)
APP = next((candidate for candidate in APP_CANDIDATES if candidate.is_file()), None)
if APP is None:
    raise FileNotFoundError("Cannot find album app.py beside tests or in workspace outputs")
spec = importlib.util.spec_from_file_location("vrchat_album_backend", APP)
backend = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backend
spec.loader.exec_module(backend)


class AlbumTests(unittest.TestCase):
    def setUp(self):
        # Python's Windows mkdtemp 0700 ACL excludes the restricted sandbox token.
        # Plain mkdir inherits the permitted scratch-directory ACL instead.
        self.base = Path(__file__).parent / f"synthetic-{uuid.uuid4().hex}"
        self.base.mkdir()
        self.addCleanup(self.cleanup_synthetic_files)
        self.source = self.base / "source"
        self.data = self.base / "data"
        self.source.mkdir()
        self.album = backend.Album(self.source, self.data)

    def tearDown(self):
        self.album.close()

    def cleanup_synthetic_files(self):
        if self.base.resolve().parent != Path(__file__).resolve().parent:
            raise AssertionError("Refusing cleanup outside the synthetic test directory")
        shutil.rmtree(self.base)

    def image(self, filename, color, exif_date=None, xmp=None):
        path = self.source / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (48, 36), color)
        options = {}
        if exif_date:
            exif = Image.Exif()
            exif[36867] = exif_date
            options["exif"] = exif
        if xmp is not None:
            pnginfo = PngInfo()
            pnginfo.add_itxt("XML:com.adobe.xmp", xmp)
            options["pnginfo"] = pnginfo
        image.save(path, **options)
        os.utime(path, (time.time() - 10, time.time() - 10))
        return path

    def photos(self):
        return self.album.catalog()["photos"]

    def state(self):
        return {
            str(path.relative_to(self.source)): (
                hashlib.sha256(path.read_bytes()).hexdigest(),
                path.stat().st_mtime_ns,
            )
            for path in self.source.rglob("*") if path.is_file()
        }

    def test_nested_scan_and_repeated_scan_do_not_touch_originals(self):
        self.image("2026-10/VRChat_2026-10-02_20-10-00.000_1920x1080.png", "red")
        self.image("2026-10/sub/VRChat_2026-10-02_20-20-00.000_1920x1080.jpg", "blue")
        self.image("older/photo.webp", "green")
        before = self.state()
        self.album.scan()
        first_ids = {p["id"] for p in self.photos()}
        self.assertEqual(len(first_ids), 3)
        self.album.scan()
        self.assertEqual({p["id"] for p in self.photos()}, first_ids)
        self.assertEqual(self.state(), before)
        self.assertTrue(self.data.exists())

    def test_content_duplicates_merge_but_equal_filenames_do_not(self):
        original = self.image("a/same.png", "red")
        duplicate = self.source / "b/copy.png"
        duplicate.parent.mkdir()
        shutil.copy2(original, duplicate)
        other = self.image("c/same.png", "blue")
        self.album.scan()
        photos = self.photos()
        self.assertEqual(len(photos), 2)
        self.assertEqual(
            {p["id"] for p in photos},
            {hashlib.sha256(p.read_bytes()).hexdigest() for p in (original, other)},
        )
        self.assertEqual(self.album.catalog()["total_files"], 3)
        self.assertEqual(self.album.catalog()["duplicates"], 1)
        self.assertEqual(sorted(p["copies"] for p in photos), [1, 2])

    def test_filename_date_takes_priority_over_exif_and_mtime(self):
        path = self.image(
            "VRChat_2026-01-02_23-45-12.123_1920x1080.jpg",
            "red", exif_date="2025:06:01 10:00:00",
        )
        os.utime(path, (1700000000, 1700000000))
        self.album.scan()
        photo = self.photos()[0]
        self.assertTrue(photo["captured_at"].startswith("2026-01-02T23:45:12"), photo)
        self.assertEqual(photo["date_source"], "filename")

    def test_exif_date_used_when_filename_has_no_date(self):
        path = self.image("snapshot.jpg", "blue", exif_date="2025:06:01 10:00:00")
        os.utime(path, (1700000000, 1700000000))
        self.album.scan()
        self.assertTrue(self.photos()[0]["captured_at"].startswith("2025-06-01T10:00:00"))
        self.assertEqual(self.photos()[0]["date_source"], "metadata")

    def test_session_crosses_midnight_and_splits_after_ninety_minutes(self):
        self.image("VRChat_2026-10-02_23-50-00.000_1920x1080.png", "red")
        self.image("VRChat_2026-10-03_00-20-00.000_1920x1080.png", "blue")
        self.image("VRChat_2026-10-03_02-00-00.000_1920x1080.png", "green")
        self.album.scan()
        photos = sorted(self.photos(), key=lambda p: p["captured_at"])
        self.assertEqual(photos[0]["session_id"], photos[1]["session_id"])
        self.assertNotEqual(photos[1]["session_id"], photos[2]["session_id"])

    def test_favorites_and_tags_survive_restart_and_rescan(self):
        self.image("VRChat_2026-10-02_20-00-00.000_1920x1080.png", "red")
        self.album.scan()
        photo_id = self.photos()[0]["id"]
        self.album.edit([photo_id], {"favorite": True, "tags": ["朋友", "夜景"]})
        self.album.close()
        self.album = backend.Album(self.source, self.data)
        self.album.scan()
        photo = self.photos()[0]
        self.assertEqual(photo["id"], photo_id)
        self.assertTrue(photo["favorite"])
        self.assertEqual(set(photo["tags"]), {"朋友", "夜景"})

    def test_xmp_world_import_handles_leading_null_and_empty_or_absent_name(self):
        world_id = "wrld_12345678-1234-1234-1234-123456789abc"
        self.image("named.png", "red", xmp=(
            '\x00<x:xmpmeta xmlns:x="adobe:ns:meta/">'
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description xmlns:vrc="http://ns.vrchat.com/vrc/1.0/" '
            f'vrc:WorldDisplayName="星空庭院" vrc:WorldID="{world_id}"/>'
            '</rdf:RDF></x:xmpmeta>'
        ))
        self.image("empty.png", "blue", xmp=(
            '<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
            'xmlns:vrc="http://ns.vrchat.com/vrc/1.0/" '
            f'vrc:WorldDisplayName="" vrc:World="{world_id}"/>'
        ))
        self.image("absent.png", "green")
        self.album.scan()
        photos = {photo["filename"]: photo for photo in self.photos()}
        self.assertEqual(photos["named.png"]["world"], "星空庭院")
        self.assertEqual(photos["named.png"]["world_id"], world_id)
        self.assertEqual(photos["empty.png"]["world"], "")
        self.assertEqual(photos["empty.png"]["world_id"], world_id)
        self.assertEqual(photos["absent.png"]["world"], "")
        self.assertEqual(photos["absent.png"]["world_id"], "")

    def test_custom_world_and_cleared_world_survive_metadata_rescan_and_restart(self):
        path = self.image("named.png", "red", xmp=(
            '<vrc:WorldDisplayName xmlns:vrc="http://ns.vrchat.com/vrc/1.0/">'
            '自动识别的世界</vrc:WorldDisplayName>'
        ))
        original_state = self.state()
        self.album.scan()
        photo = self.photos()[0]
        self.assertEqual(photo["world"], "自动识别的世界")
        photo_id = photo["id"]
        for custom_name in ("朋友的秘密基地", ""):
            with self.subTest(custom_name=custom_name):
                self.album.edit([photo_id], {"world": custom_name})
                # Force actual image rereading, not just the cached-file fast path.
                (self.data / "thumbs" / f"{photo_id}.jpg").unlink()
                self.album.scan()
                self.assertEqual(self.photos()[0]["world"], custom_name)
                self.album.close()
                self.album = backend.Album(self.source, self.data)
                self.album.scan()
                self.assertEqual(self.photos()[0]["world"], custom_name)
                self.assertEqual(self.photos()[0]["id"], photo_id)
        self.assertEqual(self.state(), original_state)

    def test_new_photo_is_picked_up_by_later_scan(self):
        self.image("VRChat_2026-10-02_20-00-00.000_1920x1080.png", "red")
        self.album.scan()
        existing_id = self.photos()[0]["id"]
        self.image("VRChat_2026-10-02_20-15-00.000_1920x1080.png", "blue")
        self.album.scan()
        self.assertEqual(len(self.photos()), 2)
        self.assertIn(existing_id, {p["id"] for p in self.photos()})

    def test_corrupt_image_does_not_stop_other_imports(self):
        corrupt = self.source / "corrupt.png"
        corrupt.write_bytes(b"this is not a png")
        os.utime(corrupt, (time.time() - 10, time.time() - 10))
        self.image("valid.png", "red")
        self.album.scan()
        self.assertEqual(len(self.photos()), 1)
        self.assertEqual(len(self.album.catalog()["scan_errors"]), 1)

    def test_missing_source_keeps_existing_catalog_and_reports_error(self):
        self.image("valid.png", "red")
        self.album.scan()
        existing_ids = {p["id"] for p in self.photos()}
        self.source.rename(self.base / "source-temporarily-missing")
        self.album.scan()
        self.assertEqual({p["id"] for p in self.photos()}, existing_ids)
        self.assertTrue(self.album.catalog()["error"])

    def test_cli_rejects_data_inside_photo_tree_before_writing_anything(self):
        self.image("valid.png", "red")
        before = self.state()
        for target in (self.source, self.source / "must-not-be-created"):
            with self.subTest(data=target):
                result = subprocess.run(
                    [sys.executable, str(APP), "--source", str(self.source),
                     "--data", str(target), "--port", "0"],
                    capture_output=True, timeout=8,
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(self.state(), before)
                self.assertFalse((target / "service.log").exists())
                if target != self.source:
                    self.assertFalse(target.exists())

    def test_loopback_http_routes_and_host_origin_protection(self):
        frontend = self.base / "web" / "dist"
        assets = frontend / "assets"
        assets.mkdir(parents=True)
        entry = frontend / "index.html"
        entry.write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
        (assets / "index-Abc123XY.js").write_text("export {};", encoding="utf-8")
        base_patch = patch.object(backend, "BASE", self.base)
        base_patch.start()
        self.addCleanup(base_patch.stop)
        original = self.image("valid.png", "red")
        original_bytes = original.read_bytes()
        original_state = self.state()
        self.album.scan()
        photo_id = self.photos()[0]["id"]
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
                options = {} if payload is None else {"Content-Type": "application/json"}
                options.update(headers or {})
                connection.request(method, path, body=payload, headers=options)
                response = connection.getresponse()
                return response.status, dict(response.getheaders()), response.read()
            finally:
                connection.close()

        try:
            for page in ("/", "/index.html", "/guide", "/web/guide.html"):
                with self.subTest(page=page):
                    status, headers, body = request("GET", page)
                    self.assertEqual(status, 200)
                    self.assertEqual(body, entry.read_bytes())
                    self.assertEqual(headers["Cache-Control"], "no-cache")
                    self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
                    self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            status, headers, body = request("GET", "/web/dist/assets/index-Abc123XY.js")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"export {};")
            self.assertIn("immutable", headers["Cache-Control"])
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            entry.rename(frontend / "index-unbuilt.html")
            status, headers, body = request("GET", "/")
            self.assertEqual(status, 503)
            self.assertIn("npm run build", json.loads(body)["error"])
            self.assertEqual(headers["Cache-Control"], "no-store")
            status, _, body = request("GET", "/api/catalog")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["photos"][0]["id"], photo_id)
            status, _, body = request("GET", "/api/status")
            self.assertEqual(status, 200)
            self.assertNotIn("photos", json.loads(body))
            status, _, body = request("GET", f"/api/photo/{photo_id}/original")
            self.assertEqual(status, 200)
            self.assertEqual(body, original_bytes)
            status, headers, body = request("GET", f"/api/photo/{photo_id}/thumb")
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "image/jpeg")
            self.assertTrue(body.startswith(b"\xff\xd8"))
            status, headers, body = request("GET", "/api/export")
            self.assertEqual(status, 200)
            self.assertIn("attachment", headers["Content-Disposition"])
            self.assertEqual(json.loads(body)["photos"][0]["id"], photo_id)
            self.assertEqual(request("GET", "/web/../../app.py")[0], 404)
            self.assertEqual(request("GET", "/api/catalog", headers={"Host": "example.invalid"})[0], 403)

            edit = {"ids": [photo_id], "favorite": True}
            for denied_headers in (
                {"Origin": "https://example.invalid"},
                {"Host": "example.invalid", "Origin": origin},
                {"Origin": origin, "Sec-Fetch-Site": "cross-site"},
            ):
                with self.subTest(headers=denied_headers):
                    self.assertEqual(request("POST", "/api/edit", edit, denied_headers)[0], 403)
                    self.assertFalse(self.photos()[0]["favorite"])
            self.assertEqual(request("POST", "/api/edit", edit,
                                     {"Origin": origin, "Content-Type": "text/plain"})[0], 415)
            self.assertEqual(request("POST", "/api/edit", edit, {"Origin": origin})[0], 200)
            self.assertTrue(self.photos()[0]["favorite"])
            self.assertEqual(request("POST", "/api/scan", {}, {"Origin": origin})[0], 202)
            self.assertTrue(self.album.scan_event.is_set())
            self.assertEqual(self.state(), original_state)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main(verbosity=2)
