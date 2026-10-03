"""Local library features. All writes go to the album database, never originals."""
import json
import os
import re
import uuid
from datetime import date, datetime
from PIL import Image, ImageStat


class CatalogChanged(ValueError):
    pass


def annotation_values(changes):
    if not isinstance(changes, dict) or not changes or set(changes) - {'world', 'tags', 'note', 'favorite'}:
        raise ValueError('编辑字段无效。')
    result = {}
    for key, value in changes.items():
        if key in ('world', 'note'):
            if not isinstance(value, str) or len(value) > (200 if key == 'world' else 4000):
                raise ValueError('世界名或备注太长。')
            result[key] = value.strip()
        elif key == 'tags':
            if not isinstance(value, list) or len(value) > 30 or any(not isinstance(t, str) or len(t) > 80 for t in value):
                raise ValueError('标签格式无效。')
            result[key] = json.dumps(list(dict.fromkeys(t.strip() for t in value if t.strip())), ensure_ascii=False)
        else:
            if not isinstance(value, bool):
                raise ValueError('收藏状态无效。')
            result[key] = int(value)
    return result


class LibraryFeatures:
    def initialize_library(self):
        self._page_cache = None
        self.db.execute("""CREATE TABLE IF NOT EXISTS collections (
            source TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
            document TEXT NOT NULL, PRIMARY KEY(source,id))""")
        self.db.execute("CREATE TABLE IF NOT EXISTS visual_signatures (id TEXT PRIMARY KEY, hash TEXT NOT NULL, color TEXT NOT NULL)")
        self.db.execute("""CREATE TABLE IF NOT EXISTS edit_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, created TEXT NOT NULL,
            label TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0)""")

    def catalog_page(self, offset=0, limit=256, snapshot=None):
        if not 0 <= offset or not 1 <= limit <= 512:
            raise ValueError('分页范围无效。')
        with self.lock:
            token = f'{self.source_revision}:{self.revision}'
            if snapshot and snapshot != token:
                raise CatalogChanged('索引已更新，正在重新载入。')
            if offset and not snapshot:
                raise ValueError('后续分页需要提供索引快照编号。')
            if not self._page_cache or self._page_cache[0] != token:
                self._page_cache = (token, self.catalog())
            catalog = self._page_cache[1]
            photos = catalog['photos']
            if offset > len(photos):
                raise ValueError('分页位置超出索引。')
            end = min(len(photos), offset+limit)
            return {**catalog, **self._state(), 'photos':photos[offset:end], 'snapshot':token,
                    'total_photos':len(photos), 'next_offset':end if end<len(photos) else None}

    def annotation_snapshot(self, ids):
        # Chunk IN queries to support large recovery files on older SQLite builds.
        result = {}
        for start in range(0, len(ids), 500):
            chunk = ids[start:start+500]
            if chunk:
                for row in self.db.execute(f"SELECT id,world,world_custom,tags,note,favorite FROM photos WHERE id IN ({','.join('?' for _ in chunk)})", chunk):
                    result[row['id']] = {k:row[k] for k in ('world','world_custom','tags','note','favorite')}
        return result

    def record_edit(self, before, after, label):
        if before == after:
            return
        source = os.path.normcase(str(self.source))
        self.db.execute('INSERT INTO edit_history(source,created,label,before,after) VALUES(?,?,?,?,?)',
                        (source,datetime.now().isoformat(timespec='seconds'),label,json.dumps(before),json.dumps(after)))
        self.db.execute('DELETE FROM edit_history WHERE source=? AND id NOT IN (SELECT id FROM edit_history WHERE source=? ORDER BY id DESC LIMIT 50)', (source,source))

    def history(self):
        with self.lock:
            rows = self.db.execute('SELECT id,created,label,before,undone FROM edit_history WHERE source=? ORDER BY id DESC LIMIT 50', (os.path.normcase(str(self.source)),))
            return {'source_revision':self.source_revision, 'entries':[{'id':r['id'],'created':r['created'],'label':r['label'],'count':len(json.loads(r['before'])),'undone':bool(r['undone'])} for r in rows]}

    def undo_edit(self, body):
        with self.lock, self.db:
            if not isinstance(body, dict) or body.get('source_revision') != self.source_revision:
                raise ValueError('照片目录已更换，请重新打开整理记录。')
            row = self.db.execute('SELECT * FROM edit_history WHERE source=? AND undone=0 ORDER BY id DESC LIMIT 1', (os.path.normcase(str(self.source)),)).fetchone()
            if not row or body.get('id') != row['id']:
                raise ValueError('请先撤销最近的一次整理，或刷新操作记录。')
            before, after = json.loads(row['before']), json.loads(row['after'])
            if self.annotation_snapshot(list(after)) != after or any(not self.contains(i) for i in before):
                raise ValueError('这些照片或标注已发生变化，未覆盖后续记录。请重新检查。')
            for identifier, fields in before.items():
                self.db.execute(f"UPDATE photos SET {','.join(k+'=?' for k in fields)} WHERE id=?", list(fields.values())+[identifier])
            self.db.execute('UPDATE edit_history SET undone=1 WHERE id=?', (row['id'],))
            self.revision += 1

    def export_annotations(self):
        with self.lock:
            photos = []
            for identifier, fields in self.annotation_snapshot([p['id'] for p in self.catalog()['photos']]).items():
                item = {'id':identifier,'tags':json.loads(fields['tags']),'note':fields['note'],'favorite':bool(fields['favorite'])}
                if fields['world_custom']:
                    item['world'] = fields['world']
                photos.append(item)
            return {'format':'vrchat-album-annotations','format_version':1,'exported_at':datetime.now().isoformat(timespec='seconds'),'photos':photos}

    def _import_plan(self, body):
        document = body.get('document')
        mode = body.get('mode')
        if mode not in ('fill', 'restore') or not isinstance(document, dict):
            raise ValueError('请选择有效的 JSON 记录与恢复方式。')
        fmt = document.get('format')
        if fmt not in ('vrchat-album-annotations','vrchat-album-annotation-draft') and document.get('app') != 'vrchat-local-album-v1':
            raise ValueError('这个文件不是相册导出的整理记录或标注草稿。')
        if fmt and document.get('format_version') != 1:
            raise ValueError('不支持这个记录格式版本。')
        rows = document.get('photos')
        if not isinstance(rows, list) or not rows or len(rows) > 20000:
            raise ValueError('记录应包含 1 至 20000 张照片。超过时请备份完整 data 目录。')
        incoming = {}
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('id'),str) or not re.fullmatch(r'[a-f0-9]{64}',row['id']) or row['id'] in incoming:
                raise ValueError('记录包含无效或重复的照片编号。')
            if fmt == 'vrchat-album-annotation-draft':
                fields = document.get('fields')
                if not isinstance(fields, dict) or not isinstance(fields.get('tags_text'),str):
                    raise ValueError('草稿字段无效。')
                changes = {'world':fields.get('world'),'note':fields.get('note'),'tags':re.split(r'[,，;；\n]',fields['tags_text'])}
                if document.get('mode') == 'batch':
                    changes = {k:v for k,v in changes.items() if (any(t.strip() for t in v) if k=='tags' else v)}
            else:
                changes = {k:v for k,v in row.items() if k in ('world','tags','note','favorite')}
            incoming[row['id']] = annotation_values(changes) if changes else {}
        current_ids = {p['id'] for p in self.catalog()['photos']}
        matched = [i for i in incoming if i in current_ids]
        before = self.annotation_snapshot(matched)
        updates = {}
        for identifier in matched:
            current = before[identifier]
            changes = {k:v for k,v in incoming[identifier].items() if mode=='restore' or current[k] in ('','[]',0)}
            if 'world' in changes:
                changes['world_custom'] = 1
            after = {**current, **changes}
            if after != current:
                updates[identifier] = changes
        return before, updates, len(incoming)-len(matched)

    def import_annotations(self, body, apply=False):
        if not isinstance(body, dict):
            raise ValueError('恢复请求格式无效。')
        with self.lock, self.db:
            if body.get('source_revision') != self.source_revision:
                raise ValueError('照片目录已更换，请重新预览恢复。')
            if apply and body.get('revision') != self.revision:
                raise ValueError('相册在预览后发生变化，请重新预览再恢复。')
            before, updates, missing = self._import_plan(body)
            result = {'matched':len(before),'changed':len(updates),'missing':missing,'source_revision':self.source_revision,'revision':self.revision}
            if apply and updates:
                for identifier, fields in updates.items():
                    self.db.execute(f"UPDATE photos SET {','.join(k+'=?' for k in fields)} WHERE id=?", list(fields.values())+[identifier])
                ids = list(updates)
                self.record_edit({i:before[i] for i in ids},self.annotation_snapshot(ids),'恢复整理记录')
                self.revision += 1
            return result

    def similar_groups(self):
        with self.lock:
            catalog = self.catalog()
            generation = self.source_revision
            cached = {r['id']: (int(r['hash'], 16), json.loads(r['color'])) for r in self.db.execute('SELECT * FROM visual_signatures')}
        photos = sorted(catalog['photos'], key=lambda p: (p['captured_at'], p['id']))
        signatures = {}
        for p in photos:
            if self.stop_event.is_set():
                raise ValueError('相册正在停止，请下次启动后再整理。')
            signature = cached.get(p['id'])
            if signature is None:
                try:
                    with Image.open(self.thumbs / (p['id'] + '.jpg')) as image:
                        rgb = image.convert('RGB').resize((9, 8), Image.Resampling.LANCZOS)
                        pixels = rgb.convert('L').tobytes()
                        digest = 0
                        for y in range(8):
                            for x in range(8):
                                digest = (digest << 1) | int(pixels[y * 9 + x] > pixels[y * 9 + x + 1])
                        signature = (digest, ImageStat.Stat(rgb).mean)
                    with self.lock:
                        self.db.execute('INSERT OR REPLACE INTO visual_signatures VALUES(?,?,?)', (p['id'], format(signature[0], '016x'), json.dumps(signature[1])))
                        self.db.commit()
                except OSError:
                    continue
            signatures[p['id']] = signature
        # Limit comparisons to nearby captures in the same world. No all-pairs scan.
        buckets = {}
        parent = {p['id']: p['id'] for p in photos}
        sizes = {p['id']: 1 for p in photos}
        def root(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        for p in photos:
            sig = signatures.get(p['id'])
            if sig is None:
                continue
            when = datetime.fromisoformat(p['captured_at'])
            bucket = buckets.setdefault((p['date'], p['world_id'] or p['world']), [])
            bucket[:] = [(q, t) for q, t in bucket[-32:] if (when - t).total_seconds() <= 120]
            for q, _ in bucket:
                other = signatures[q['id']]
                ratio = (p['width'] / p['height']) / (q['width'] / q['height'])
                if not 0.92 <= ratio <= 1.08 or (sig[0] ^ other[0]).bit_count() > 8 or max(abs(a-b) for a,b in zip(sig[1], other[1])) > 25:
                    continue
                a, b = root(p['id']), root(q['id'])
                if a != b and sizes[a] + sizes[b] <= 24:
                    parent[b] = a
                    sizes[a] += sizes[b]
            bucket.append((p, when))
        groups = {}
        for p in photos:
            groups.setdefault(root(p['id']), []).append(p['id'])
        with self.lock:
            if generation != self.source_revision:
                raise ValueError('照片目录已更换，请重新查找相似照片。')
        return {'source_revision': generation, 'groups': [ids for ids in reversed(list(groups.values())) if len(ids) > 1],
                'checked': len(signatures)}

    def collection_list(self):
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT document FROM collections WHERE source=? ORDER BY rowid DESC", (os.path.normcase(str(self.source)),))]

    def save_collection(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("collection"), dict):
            raise ValueError("合集格式无效。")
        c = body["collection"]
        name = c.get("name")
        ids = c.get("ids", [])
        cover = c.get("cover", "")
        rules = c.get("rules", {})
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100 or c.get("mode") not in ("manual", "rules"):
            raise ValueError("请填写合集名称并选择有效的收集方式。")
        if not isinstance(ids, list) or len(ids) > 2000 or any(not isinstance(i, str) or not re.fullmatch(r"[a-f0-9]{64}", i) for i in ids):
            raise ValueError("手选合集最多收集 2000 张有效照片。")
        if not isinstance(cover, str) or (cover and not re.fullmatch(r"[a-f0-9]{64}", cover)):
            raise ValueError("封面照片无效。")
        if not isinstance(rules, dict) or set(rules) - {"from", "to", "world", "tags", "favorites"}:
            raise ValueError("合集规则无效。")
        for key in ("from", "to"):
            value = rules.get(key, "")
            if not isinstance(value, str):
                raise ValueError("日期格式无效。")
            if value:
                date.fromisoformat(value)
        if rules.get("from") and rules.get("to") and rules["from"] > rules["to"]:
            raise ValueError("开始日期不能晚于结束日期。")
        if not isinstance(rules.get("world", ""), str) or len(rules.get("world", "")) > 200:
            raise ValueError("世界规则无效。")
        tags = rules.get("tags", [])
        if not isinstance(tags, list) or len(tags) > 30 or any(not isinstance(t, str) or len(t) > 80 for t in tags):
            raise ValueError("标签规则无效。")
        if not isinstance(rules.get("favorites", False), bool):
            raise ValueError("星标规则无效。")
        identifier = c.get("id") or uuid.uuid4().hex
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("合集编号无效。")
        with self.lock:
            if body.get("source_revision") != self.source_revision:
                raise ValueError("照片目录已更换，请重新打开合集编辑器。")
            source = os.path.normcase(str(self.source))
            old = self.db.execute("SELECT revision FROM collections WHERE source=? AND id=?", (source, identifier)).fetchone()
            if old and c.get("revision") != old[0]:
                raise ValueError("这个合集已在另一窗口更新，请重新打开后编辑。")
            if not old and self.db.execute("SELECT count(*) FROM collections WHERE source=?", (source,)).fetchone()[0] >= 100:
                raise ValueError("每个照片目录最多保存 100 个自定义合集。")
            members = set(ids + ([cover] if cover else []))
            if any(not self.contains(i) for i in members):
                raise ValueError("部分照片已不在当前目录，请重新选择。")
            document = {"id": identifier, "revision": old[0] + 1 if old else 1, "name": name.strip(),
                        "mode": c["mode"], "ids": list(dict.fromkeys(ids)), "cover": cover,
                        "rules": {"from": rules.get("from", ""), "to": rules.get("to", ""), "world": rules.get("world", ""),
                                  "tags": list(dict.fromkeys(t.strip() for t in tags if t.strip())), "favorites": rules.get("favorites", False)}}
            self.db.execute("INSERT OR REPLACE INTO collections VALUES(?,?,?,?)", (source, identifier, document["revision"], json.dumps(document, ensure_ascii=False)))
            self.db.commit()
            self.revision += 1
            return document
