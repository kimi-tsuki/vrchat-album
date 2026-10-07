"""Per-source collection presentation, including local-only uploaded covers."""
import base64
import binascii
import io
import json
import os
import re
import warnings
from urllib.parse import urlencode

from PIL import Image, ImageOps


def normalize_cover(value):
    if not isinstance(value, str) or len(value) > 12 * 1024 * 1024:
        raise ValueError('封面文件不能超过 8 MB。')
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('封面文件不能超过 8 MB。')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ('JPEG', 'PNG', 'WEBP') or image.width * image.height > 24_000_000:
                    raise ValueError('请选择不超过 2400 万像素的 PNG、JPEG 或 WebP 封面。')
                image = ImageOps.exif_transpose(image)
                image.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
                rgba = image.convert('RGBA')
                clean = Image.new('RGB', rgba.size, '#20232c')
                clean.paste(rgba, mask=rgba.getchannel('A'))
                output = io.BytesIO()
                clean.save(output, 'JPEG', quality=88)
                return output.getvalue()
    except (OSError, binascii.Error, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise ValueError('无法读取封面，请选择有效的 PNG、JPEG 或 WebP 图片。') from exc


class CollectionDisplays:
    def initialize_collection_displays(self):
        self.db.execute('''CREATE TABLE IF NOT EXISTS collection_displays (
            source TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
            image BLOB, PRIMARY KEY(source,id))''')

    def collection_displays(self):
        result = {}
        for row in self.db.execute('SELECT id,document FROM collection_displays WHERE source=?', (os.path.normcase(str(self.source)),)):
            value = json.loads(row['document'])
            if value['cover_type'] == 'upload':
                value['cover_url'] = '/api/collections/cover?' + urlencode({
                    'id': row['id'], 'revision': value['revision'], 'source_revision': self.source_revision})
            result[row['id']] = value
        return result

    def collection_cover(self, identifier, revision, source_revision):
        with self.lock:
            if source_revision != self.source_revision:
                return None
            row = self.db.execute('SELECT document,image FROM collection_displays WHERE source=? AND id=?',
                                  (os.path.normcase(str(self.source)), identifier)).fetchone()
            if row and json.loads(row['document'])['revision'] == revision:
                return row['image']
            return None

    def save_collection_display(self, body):
        if not isinstance(body, dict) or not isinstance(body.get('display'), dict):
            raise ValueError('合集展示设置无效。')
        value = body['display']
        identifier = value.get('id')
        if not isinstance(identifier, str) or not re.fullmatch(r'(?:[a-f0-9]{32}|favorites|recent|notes|unwritten|latest-session|(?:world|tag|year):[^\x00-\x1f]{1,200})', identifier):
            raise ValueError('合集编号无效。')
        if any(not isinstance(value.get(key), bool) for key in ('pinned', 'slideshow')):
            raise ValueError('请选择置顶与幻灯片状态。')
        if type(value.get('interval')) is not int or value['interval'] not in (5, 8, 12):
            raise ValueError('幻灯片间隔请选择 5、8 或 12 秒。')
        if type(value.get('position')) is not int or value['position'] not in (25, 50, 75):
            raise ValueError('封面位置无效。')
        if value.get('cover_type') not in ('auto', 'photo', 'upload'):
            raise ValueError('封面类型无效。')
        photo = value.get('cover_photo', '') if value['cover_type'] == 'photo' else ''
        if not isinstance(photo, str) or (value['cover_type'] == 'photo' and not re.fullmatch(r'[a-f0-9]{64}', photo)):
            raise ValueError('请选择有效的封面照片。')
        # Decode before acquiring the database lock; recheck source/revision before any write.
        upload = normalize_cover(body['image']) if 'image' in body and value['cover_type'] == 'upload' else None
        with self.lock, self.db:
            if body.get('source_revision') != self.source_revision:
                raise ValueError('照片目录已更换，请重新打开合集设置。')
            source = os.path.normcase(str(self.source))
            old = self.db.execute('SELECT document,image FROM collection_displays WHERE source=? AND id=?', (source, identifier)).fetchone()
            previous = json.loads(old['document']) if old else {}
            if value.get('revision', 0) != previous.get('revision', 0):
                raise ValueError('合集设置已在另一窗口更新，请重新打开设置。')
            if not old and self.db.execute('SELECT count(*) FROM collection_displays WHERE source=?', (source,)).fetchone()[0] >= 500:
                raise ValueError('当前照片目录最多保存 500 个合集的展示设置。')
            if photo and not self.contains(photo):
                raise ValueError('封面照片已不在当前目录，请重新选择。')
            image = (upload if upload is not None else old['image'] if old else None) if value['cover_type'] == 'upload' else None
            if value['cover_type'] == 'upload' and not image:
                raise ValueError('请先选择本机封面文件。')
            rank = previous.get('pinned_order', 0)
            if value['pinned'] and not previous.get('pinned'):
                rank = 1 + max((d.get('pinned_order', 0) for d in self.collection_displays().values()), default=0)
            document = {key: value[key] for key in ('pinned', 'slideshow', 'interval', 'position', 'cover_type')}
            document.update(id=identifier, revision=previous.get('revision', 0) + 1, cover_photo=photo, pinned_order=rank)
            self.db.execute('INSERT OR REPLACE INTO collection_displays VALUES(?,?,?,?)',
                            (source, identifier, json.dumps(document, ensure_ascii=False), image))
            self.revision += 1
            return self.collection_displays()[identifier]
