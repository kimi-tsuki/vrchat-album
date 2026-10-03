"""Local library features. All writes go to the album database, never originals."""
import json
import os
import re
import uuid
from datetime import date, datetime
from PIL import Image, ImageStat


class LibraryFeatures:
    def initialize_library(self):
        self.db.execute("""CREATE TABLE IF NOT EXISTS collections (
            source TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
            document TEXT NOT NULL, PRIMARY KEY(source,id))""")
        self.db.execute("CREATE TABLE IF NOT EXISTS visual_signatures (id TEXT PRIMARY KEY, hash TEXT NOT NULL, color TEXT NOT NULL)")

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
