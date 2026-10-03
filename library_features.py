"""Local library features. All writes go to the album database, never originals."""
import json
import os
import re
import uuid
from datetime import date


class LibraryFeatures:
    def initialize_library(self):
        self.db.execute("""CREATE TABLE IF NOT EXISTS collections (
            source TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
            document TEXT NOT NULL, PRIMARY KEY(source,id))""")

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
