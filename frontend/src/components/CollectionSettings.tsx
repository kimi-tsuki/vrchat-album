import { Button } from '@heroui/react';
import { useMemo, useState } from 'react';
import { request } from '../api';
import { collectionFrames, defaultDisplay } from '../collection-display';
import { collectionPhotos, type SmartCollection } from '../collections';
import type { CollectionDisplay, CustomCollection } from '../types';
import type { AlbumHook } from '../useAlbum';
import { CollectionPoster } from './CollectionPoster';
import { Dialog } from './Dialog';

export function CollectionSettings({ album, collection, onClose, onEdit }: {
  album: AlbumHook; collection: SmartCollection; onClose(): void; onEdit(collection: CustomCollection): void;
}) {
  const [draft, setDraft] = useState(() => album.catalog?.collection_displays?.[collection.id] || defaultDisplay(collection.id));
  const [sourceRevision] = useState(album.catalog?.source_revision);
  const [upload, setUpload] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(24);
  const [query, setQuery] = useState('');
  const patch = (value: Partial<CollectionDisplay>) => setDraft(previous => ({ ...previous, ...value }));
  const members = useMemo(() => collectionPhotos(album.photos, collection.rule, album.today), [album.photos, collection.rule, album.today]);
  const matches = useMemo(() => members.filter(p => `${p.filename} ${p.world} ${p.date}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [members, query]);
  const preview = { ...draft, cover_url: previewUrl || draft.cover_url };
  const frames = collectionFrames(collection, preview, album.photos, album.today);
  const chooseFile = async (file?: File) => {
    if (!file) return;
    setError(''); setReading(true);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('封面文件不能超过 8 MB。');
      if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取这个文件。')); reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image(); image.onload = () => image.width * image.height <= 24_000_000 ? resolve() : reject(new Error('封面不能超过 2400 万像素。'));
        image.onerror = () => reject(new Error('无法读取图片，请换一张封面。')); image.src = url;
      });
      setUpload(url.slice(url.indexOf(',') + 1)); setPreviewUrl(url); patch({ cover_type: 'upload' });
    } catch (reason) { setError(reason instanceof Error ? reason.message : '封面读取失败。'); }
    finally { setReading(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      await request('/api/collections/display', { display: draft, source_revision: sourceRevision, ...(draft.cover_type === 'upload' && upload ? { image: upload } : {}) });
      await album.refresh(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '合集设置保存失败。'); }
    finally { setBusy(false); }
  };
  return <Dialog isOpen onClose={onClose} title="合集设置" description={collection.title} size="lg" isBusy={busy || reading}
    footer={<><Button variant="ghost" onPress={onClose} isDisabled={busy || reading}>取消</Button><Button onPress={() => { void save(); }} isPending={busy} isDisabled={reading || album.pendingSourceChange || (draft.cover_type === 'photo' && !draft.cover_photo) || (draft.cover_type === 'upload' && !upload && !draft.cover_url)}>保存展示设置</Button></>}>
    <div className="collection-settings">
      <CollectionPoster key={collection.id} collection={collection} display={preview} frames={frames} preview />
      <fieldset disabled={busy || reading}>
        <legend>展示方式</legend>
        <label className="collection-toggle"><span><strong>置顶这本合集</strong><small>在合集页最前面独占一行，展示超大封面。</small></span><input type="checkbox" checked={draft.pinned} onChange={e => patch({ pinned: e.target.checked })} /></label>
        <label className="collection-toggle"><span><strong>封面幻灯片</strong><small>从封面开始，轮播最多 6 张。鼠标停留时暂停。</small></span><input type="checkbox" checked={draft.slideshow} onChange={e => patch({ slideshow: e.target.checked })} /></label>
        {draft.slideshow && <label className="album-native-field">切换间隔<select aria-label="封面切换间隔" value={draft.interval} onChange={e => patch({ interval: Number(e.target.value) as CollectionDisplay['interval'] })}>{[5, 8, 12].map(n => <option value={n} key={n}>{n} 秒</option>)}</select></label>}
        {draft.slideshow && <p className="discovery-hint">离开屏幕或切换标签页后暂停；系统开启“减少动态效果”时保持静态。只有一张图片时显示静态封面。</p>}
      </fieldset>
      <fieldset disabled={busy || reading}>
        <legend>封面与取景</legend>
        <div className="cover-source-options">{(['auto', 'photo', 'upload'] as const).map((kind, i) => <Button key={kind} size="sm" variant={draft.cover_type === kind ? 'primary' : 'secondary'} aria-pressed={draft.cover_type === kind} onPress={() => patch({ cover_type: kind })}>{['自动封面', '从合集选图', '本机上传'][i]}</Button>)}</div>
        {draft.cover_type === 'upload' && <label className="cover-upload">选择封面图片<input aria-label="上传自定义封面" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }} /><small>PNG / JPEG / WebP · 最大 8 MB、2400 万像素；在本机保存优化后的封面副本。</small></label>}
        {draft.cover_type === 'photo' && <><input className="cover-search" aria-label="查找封面照片" placeholder="搜索世界、日期或文件名" value={query} onChange={e => { setQuery(e.target.value); setLimit(24); }} />
          <div className="cover-picker">{matches.slice(0, limit).map(p => <button key={p.id} type="button" className={draft.cover_photo === p.id ? 'selected' : ''} aria-label={`封面 ${p.filename}`} aria-pressed={draft.cover_photo === p.id} onClick={() => patch({ cover_photo: p.id })}><img src={p.thumb_url} alt="" loading="lazy" /><span>{p.date}</span></button>)}</div>
          {!matches.length && <p className="discovery-hint">没有匹配的照片，可使用本机上传封面。</p>}{matches.length > limit && <Button variant="ghost" size="sm" onPress={() => setLimit(n => n + 24)}>显示更多封面</Button>}</>}
        <label className="album-native-field">封面取景<select aria-label="封面取景" value={draft.position} onChange={e => patch({ position: Number(e.target.value) as CollectionDisplay['position'] })}><option value={25}>偏上</option><option value={50}>居中</option><option value={75}>偏下</option></select></label>
      </fieldset>
      {collection.rule.kind === 'custom' && <Button variant="secondary" onPress={() => { if (collection.rule.kind === 'custom') onEdit(collection.rule.value); }} isDisabled={busy || reading}>编辑合集名称、照片与收集规则</Button>}
      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
