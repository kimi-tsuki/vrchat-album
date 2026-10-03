"""Local feature regression tests, exclusively with synthetic images."""
import json
import unittest
import test_album as fixtures


class FeatureTests(unittest.TestCase):
    setUp = fixtures.AlbumTests.setUp
    tearDown = fixtures.AlbumTests.tearDown
    cleanup_synthetic_files = fixtures.AlbumTests.cleanup_synthetic_files
    image = fixtures.AlbumTests.image
    photos = fixtures.AlbumTests.photos
    state = fixtures.AlbumTests.state


class CollectionsTests(FeatureTests):
    def test_collection_persistence_order_and_source_guard(self):
        self.image('VRChat_2026-10-03_12-00-00.1.png', 'red')
        self.image('VRChat_2026-10-03_12-01-00.2.png', 'blue')
        self.album.scan()
        ids = [p['id'] for p in self.photos()]
        before = self.state()
        c = {'name': 'Synthetic collection', 'mode': 'manual', 'ids': ids[::-1], 'cover': ids[0], 'rules': {}}
        saved = self.album.save_collection({'collection': c, 'source_revision': 0})
        self.assertEqual(self.album.catalog()['custom_collections'][0]['ids'], ids[::-1])
        self.assertEqual(saved['cover'], ids[0])
        with self.assertRaises(ValueError):
            self.album.save_collection({'collection': saved, 'source_revision': 1})
        newer = self.album.save_collection({'collection': saved, 'source_revision': 0})
        self.assertEqual(newer['revision'], 2)
        with self.assertRaises(ValueError):
            self.album.save_collection({'collection': saved, 'source_revision': 0})
        self.assertEqual(before, self.state())
        self.album.close()
        from test_album import backend
        self.album = backend.Album(self.source, self.data)
        self.assertEqual(self.album.collection_list()[0]['revision'], 2)

    def test_invalid_rules_do_not_write(self):
        c = {'name': 'Bad rule', 'mode': 'rules', 'ids': [], 'rules': {'from': '2026-02-30'}}
        with self.assertRaises(ValueError):
            self.album.save_collection({'collection': c, 'source_revision': 0})

        self.assertEqual(self.album.collection_list(), [])
        c['rules'] = {'from': '2026-10-03', 'to': '2025-10-03'}
        with self.assertRaises(ValueError):
            self.album.save_collection({'collection': c, 'source_revision': 0})


class SimilarTests(FeatureTests):
    def test_similar_color_time_window_and_cached_readonly_scan(self):
        self.image('VRChat_2026-10-03_12-00-00.1.png', '#800000')
        self.image('VRChat_2026-10-03_12-00-01.2.png', '#900000')
        self.image('VRChat_2026-10-03_12-00-02.3.png', 'blue')
        self.image('VRChat_2026-10-03_12-10-00.4.png', '#980000')
        self.album.scan()
        before = self.state()
        result = self.album.similar_groups()
        self.assertEqual(result['checked'], 4)
        self.assertEqual(len(result['groups']), 1)
        self.assertEqual(len(result['groups'][0]), 2)
        self.assertEqual(result, self.album.similar_groups())
        self.assertEqual(self.album.db.execute('SELECT count(*) FROM visual_signatures').fetchone()[0], 4)
        self.assertEqual(before, self.state())


class RecoveryTests(FeatureTests):
    def test_batch_undo_import_preview_conflict_and_originals(self):
        self.image('VRChat_2026-10-03_12-00-00.1.png', 'red')
        self.image('VRChat_2026-10-03_12-01-00.2.png', 'blue')
        self.album.scan()
        ids = [p['id'] for p in self.photos()]
        original = self.state()
        self.album.edit(ids, {'world':'Synthetic friends','tags':['test'],'note':'A memory','favorite':True})
        backup = self.album.export_annotations()
        self.assertNotIn('source', backup)
        history = self.album.history()['entries']
        self.assertEqual(history[0]['count'], 2)
        self.album.undo_edit({'source_revision':0,'id':history[0]['id']})
        self.assertTrue(all(not p['note'] and not p['favorite'] for p in self.photos()))
        body = {'source_revision':0,'mode':'restore','document':backup}
        preview = self.album.import_annotations(body)
        self.assertEqual(preview['changed'], 2)
        self.assertTrue(all(not p['note'] for p in self.photos()))
        self.album.edit([ids[0]], {'note':'Newer note'})
        with self.assertRaises(ValueError):
            self.album.import_annotations({**body,'revision':preview['revision']}, apply=True)
        fill = self.album.import_annotations({**body,'mode':'fill'})
        self.album.import_annotations({**body,'mode':'fill','revision':fill['revision']}, apply=True)
        self.assertEqual(next(p for p in self.photos() if p['id']==ids[0])['note'], 'Newer note')
        self.assertEqual(original, self.state())
        newest = self.album.history()['entries'][0]
        self.album.undo_edit({'source_revision':0,'id':newest['id']})
        self.assertFalse(next(p for p in self.photos() if p['id']==ids[1])['favorite'])

    def test_invalid_import_is_atomic_and_source_guarded(self):
        self.image('VRChat_2026-10-03_12-00-00.1.png', 'red')
        self.album.scan()
        identifier = self.photos()[0]['id']
        doc = {'format':'vrchat-album-annotations','format_version':1,'photos':[{'id':identifier,'note':'good'},{'id':'f'*64,'note':123}]}
        with self.assertRaises(ValueError):
            self.album.import_annotations({'document':doc,'mode':'restore','source_revision':0,'revision':self.album.revision},apply=True)
        self.assertEqual(self.photos()[0]['note'], '')
        self.assertEqual(self.album.history()['entries'], [])
        doc['photos'] = [{'id':identifier,'note':'good'}]
        with self.assertRaises(ValueError):
            self.album.import_annotations({'document':doc,'mode':'restore','source_revision':1})
