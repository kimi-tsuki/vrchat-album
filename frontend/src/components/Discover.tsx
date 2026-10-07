import { Button, Input, Label, Tabs, TextField } from '@heroui/react';
import { useMemo, useRef, useState } from 'react';
import { shiftDate, type SmartCollection } from '../collections';
import type { AlbumHook } from '../useAlbum';
import type { MemoryRange, CustomCollection } from '../types';
import { Icon } from './Icon';
import { useEntrance } from '../motion';
import { collectionFrames, defaultDisplay, orderCollections } from '../collection-display';
import { request } from '../api';
import { CollectionPoster } from './CollectionPoster';
import { CollectionSettings } from './CollectionSettings';

export function MemoryControls({ album }: { album: AlbumHook }) {
  const years = new Set(album.scoped.map(photo => photo.date.slice(0, 4)));
  const hasFallbackDate = album.scoped.some(photo => photo.date_source === 'modified');
  return <section className="memory-panel" aria-label="往年回忆">
    <div className="discovery-heading"><div><p className="eyebrow">A LITTLE TIME TRAVEL</p><h2>看看往年的这一天</h2><p>选一个日期，找回此前年份的同日或同月照片。</p></div><span className="memory-count">{album.scoped.length} 张回忆 · {years.size} 个年份</span></div>
    <div className="memory-controls"><div className="memory-date-nav">
      <Button isIconOnly variant="outline" aria-label="回忆日期前一天" onPress={() => album.setMemoryDate(shiftDate(album.memoryDate, -1))}><Icon name="left" /></Button>
      <TextField value={album.memoryDate} onChange={album.setMemoryDate} className="memory-date"><Label>回忆日期</Label><Input type="date" min="0001-01-01" max="9999-12-31" /></TextField>
      <Button isIconOnly variant="outline" aria-label="回忆日期后一天" onPress={() => album.setMemoryDate(shiftDate(album.memoryDate, 1))}><Icon name="right" /></Button>
      <Button variant="secondary" size="sm" onPress={() => album.setMemoryDate(album.today)}>回到今天</Button>
    </div><Tabs selectedKey={album.memoryRange} onSelectionChange={key => album.setMemoryRange(String(key) as MemoryRange)}><Tabs.ListContainer><Tabs.List aria-label="回忆范围"><Tabs.Tab id="day">同日往年<Tabs.Indicator /></Tabs.Tab><Tabs.Tab id="month">同月往年<Tabs.Indicator /></Tabs.Tab></Tabs.List></Tabs.ListContainer></Tabs></div>
    <p className="discovery-hint">只显示所选日期之前的年份，当前年份的照片可在“相册”里查看。{hasFallbackDate && ' 部分照片日期来自文件修改时间，可能与拍摄日期不同。'}</p>
  </section>;
}

const categories = ['全部', '自定义', '推荐', '世界', '标签', '年份'] as const;
type Category = typeof categories[number];
export function Collections({ album, onEdit, onCreate }: { album: AlbumHook; onEdit(collection: CustomCollection): void; onCreate(): void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('全部');
  const [limit, setLimit] = useState(12);
  const [settings, setSettings] = useState<SmartCollection | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const displays = album.catalog?.collection_displays;
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return orderCollections(album.collections.filter(collection => (category === '全部' || collection.category === category) &&
      (!needle || `${collection.title} ${collection.description}`.toLocaleLowerCase().includes(needle))), displays);
  }, [album.collections, displays, category, query]);
  const gridRef = useRef<HTMLDivElement>(null);
  useEntrance(gridRef, `${category}:${query}:${limit}:${visible.map(collection => collection.id).join(',')}`, '.collection-poster');
  const pin = async (collection: SmartCollection) => {
    setBusy(collection.id); setError('');
    const display = displays?.[collection.id] || defaultDisplay(collection.id);
    try {
      await request('/api/collections/display', { display: { ...display, pinned: !display.pinned }, source_revision: album.catalog?.source_revision });
      await album.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '置顶设置保存失败。'); }
    finally { setBusy(''); }
  };
  const shown = visible.slice(0, limit);
  const featured = shown.filter(c => displays?.[c.id]?.pinned);
  const regular = shown.filter(c => !displays?.[c.id]?.pinned);
  const poster = (collection: SmartCollection) => {
    const display = displays?.[collection.id] || defaultDisplay(collection.id);
    return <CollectionPoster key={`${collection.id}:${display.revision}`} collection={collection} display={display}
      frames={collectionFrames(collection, display, album.photos, album.today)} busy={!!busy || album.pendingSourceChange || !album.indexComplete}
      onOpen={() => album.openCollection(collection)} onSettings={() => setSettings(collection)} onPin={() => { void pin(collection); }} />;
  };
  return <section className="collections-section" aria-label="合集列表">
    <div className="discovery-heading collection-heading"><div><p className="eyebrow">YOUR PERSONAL EXHIBITION</p><h2>让喜欢的回忆，占据整个画面</h2><p>置顶一册，让它成为主角。点卡片右上角，定制封面与幻灯片。</p></div><Button variant="secondary" onPress={onCreate}>＋ 新建合集</Button></div>
    <div className="collections-toolbar"><Tabs selectedKey={category} onSelectionChange={key => { setCategory(String(key) as Category); setLimit(12); }}><Tabs.ListContainer><Tabs.List aria-label="合集分类">{categories.map(value => <Tabs.Tab id={value} key={value}>{value}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer></Tabs>
      <TextField aria-label="搜索合集" value={query} onChange={value => { setQuery(value); setLimit(12); }} className="collection-search"><Input placeholder="搜索世界、标签或年份…" /></TextField></div>
    {error && <p className="form-message error" role="alert">{error}</p>}
    <div ref={gridRef}>
      {!!featured.length && <div className="collection-featured" aria-label="置顶合集"><div className="collection-section-label"><span>精选置顶</span><small>FEATURED STORIES</small></div>{featured.map(poster)}</div>}
      {!!regular.length && <><div className="collection-section-label"><span>{featured.length ? '继续探索' : '我的合集'}</span><small>{visible.length} COLLECTIONS</small></div><div className="collection-gallery">{regular.map(poster)}</div></>}
    </div>
    {!visible.length && <div className="empty"><Icon name="folder" /><h3>{album.photos.length ? '没有匹配的合集' : '照片整理后，合集会出现在这里'}</h3><p>{album.photos.length ? '换个关键词或分类，看看其他回忆。' : '先在相册选择照片目录，再回来看看。'}</p>{album.photos.length > 0 && <Button variant="secondary" onPress={() => { setQuery(''); setCategory('全部'); setLimit(12); }}>显示全部合集</Button>}</div>}
    {visible.length > limit && <div className="load-more"><Button variant="secondary" onPress={() => setLimit(value => value + 12)}>更多合集 · 还有 {visible.length - limit} 个</Button></div>}
    <p className="discovery-hint">合集与封面保存在本机。新照片与标注保存后，自动合集会跟着更新。</p>
    {settings && <CollectionSettings album={album} collection={settings} onClose={() => setSettings(null)} onEdit={collection => { setSettings(null); onEdit(collection); }} />}
  </section>;
}
