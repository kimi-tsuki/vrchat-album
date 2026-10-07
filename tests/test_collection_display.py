import base64
import io
import json
import http.client
import threading
from PIL import Image
from test_library import FeatureTests
from test_album import backend


class CollectionDisplayTests(FeatureTests):
    def body(self, **changes):
        return {'source_revision': self.album.source_revision, 'display': {
            'id': 'favorites', 'revision': 0, 'pinned': True, 'slideshow': True,
            'interval': 8, 'position': 50, 'cover_type': 'auto', 'cover_photo': '', **changes}}

    def upload(self):
        stream = io.BytesIO()
        Image.new('RGBA', (2200, 1100), (240, 100, 70, 128)).save(stream, 'PNG')
        return base64.b64encode(stream.getvalue()).decode('ascii')

    def test_cover_persistence_validation_replacement_and_original_readonly(self):
        self.image('VRChat_2026-10-07_12-00-00.png', 'blue')
        self.album.scan()
        originals = self.state()
        body = self.body(cover_type='upload')
        body['image'] = self.upload()
        saved = self.album.save_collection_display(body)
        content = self.album.collection_cover('favorites', 1, 0)
        with Image.open(io.BytesIO(content)) as image:
            self.assertEqual(image.size, (1920, 960))
            self.assertEqual(image.mode, 'RGB')
            self.assertFalse(image.getexif())
        with self.assertRaises(ValueError):
            self.album.save_collection_display(body)  # stale revision
        for change in ({'source_revision': 99}, {'image': 'not-an-image'}):
            with self.assertRaises(ValueError):
                self.album.save_collection_display({**body, 'display': saved, **change})
        self.assertEqual(self.album.collection_displays()['favorites']['revision'], 1)
        self.album.close()
        self.album = backend.Album(self.source, self.data)
        self.assertEqual(self.album.collection_displays()['favorites']['cover_type'], 'upload')
        self.assertEqual(self.album.collection_cover('favorites', 1, 0), content)
        self.assertIsNone(self.album.collection_cover('favorites', 1, 99))
        self.assertIsNone(self.album.collection_cover('favorites', 2, 0))
        restored = self.album.save_collection_display(self.body(revision=1, cover_type='auto'))
        self.assertNotIn('cover_url', restored)
        self.assertIsNone(self.album.collection_cover('favorites', 2, 0))
        self.assertEqual(self.state(), originals)

    def test_source_isolation_order_and_missing_photo(self):
        first = self.album.save_collection_display(self.body())
        second = self.album.save_collection_display(self.body(id='recent'))
        self.assertGreater(second['pinned_order'], first['pinned_order'])
        with self.assertRaises(ValueError):
            self.album.save_collection_display(self.body(id='notes', cover_type='photo', cover_photo='f'*64))
        other = self.base / 'other'
        other.mkdir()
        self.album.configure_source(str(other.resolve()))
        self.assertEqual(self.album.collection_displays(), {})
        with self.assertRaises(ValueError):
            self.album.save_collection_display({'source_revision': 0, 'display': first})

    def test_invalid_settings_do_not_write(self):
        for change in ({'pinned': 1}, {'slideshow': 'yes'}, {'interval': 0}, {'position': 999}, {'cover_type': 'remote'}, {'cover_type': 'upload'}, {'id': '../outside'}):
            with self.assertRaises(ValueError):
                self.album.save_collection_display(self.body(**change))
        self.assertEqual(self.album.collection_displays(), {})

    def test_http_cover_upload_and_origin_guards(self):
        server = backend.ThreadingHTTPServer(('127.0.0.1', 0), backend.Handler)
        server.album = self.album
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        def request(method, path, body=None, origin=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                connection.request(method, path, json.dumps(body) if body else None, {'Content-Type': 'application/json', **({'Origin': origin} if origin else {})})
                response = connection.getresponse()
                return response.status, response.getheader('Content-Type'), response.read()
            finally:
                connection.close()
        try:
            body = {**self.body(cover_type='upload'), 'image': self.upload()}
            self.assertEqual(request('POST', '/api/collections/display', body, 'https://example.invalid')[0], 403)
            status, _, data = request('POST', '/api/collections/display', body)
            self.assertEqual(status, 200)
            url = json.loads(data)['display']['cover_url']
            status, mime, data = request('GET', url)
            self.assertEqual((status, mime), (200, 'image/jpeg'))
            with Image.open(io.BytesIO(data)) as image:
                self.assertEqual(image.width, 1920)
            self.assertEqual(request('GET', url.replace('revision=1', 'revision=999'))[0], 404)
        finally:
            server.shutdown(); server.server_close(); worker.join()
