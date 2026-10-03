import { Button, Input, Label, Tabs, TextField } from '@heroui/react';
import { useMemo, useRef, useState } from 'react';
import { shiftDate, type SmartCollection } from '../collections';
import type { AlbumHook } from '../useAlbum';
import type { MemoryRange } from '../types';
import { Icon } from './Icon';
import { useEntrance } from '../motion';

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

const categories = ['全部', '推荐', '世界', '标签', '年份'] as const;
type Category = typeof categories[number];
export function Collections({ album }: { album: AlbumHook }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('全部');
  const [limit, setLimit] = useState(12);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return album.collections.filter(collection => (category === '全部' || collection.category === category) &&
      (!needle || `${collection.title} ${collection.description}`.toLocaleLowerCase().includes(needle)));
  }, [album.collections, category, query]);
  const gridRef = useRef<HTMLDivElement>(null);
  useEntrance(gridRef, `${category}:${query}:${limit}:${visible.map(collection => collection.id).join(',')}`, '.collection-card');
  const open = (collection: SmartCollection) => album.openCollection(collection);
  return <section className="collections-section" aria-label="自动合集列表">
    <div className="discovery-heading"><div><p className="eyebrow">STORIES ALREADY IN YOUR ALBUM</p><h2>不用搬动照片，也能汇成一册</h2><p>根据日期、世界、标签和星标自动整理。新照片与标注保存后，合集会跟着更新。</p></div><span className="memory-count">{album.collections.length} 个合集</span></div>
    <div className="collections-toolbar"><Tabs selectedKey={category} onSelectionChange={key => { setCategory(String(key) as Category); setLimit(12); }}><Tabs.ListContainer><Tabs.List aria-label="合集分类">{categories.map(value => <Tabs.Tab id={value} key={value}>{value}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer></Tabs>
      <TextField aria-label="搜索合集" value={query} onChange={value => { setQuery(value); setLimit(12); }} className="collection-search"><Input placeholder="搜索世界、标签或年份…" /></TextField></div>
    <div ref={gridRef} className="collection-grid">{visible.slice(0, limit).map(collection => <Button key={collection.id} variant="ghost" className="collection-card" aria-label={`打开合集 ${collection.title}，${collection.count} 张`} onPress={() => open(collection)}>
      <span className={`collection-covers covers-${collection.covers.length}`} aria-hidden="true">{collection.covers.map(photo => <img key={photo.id} src={photo.thumb_url} alt="" loading="lazy" decoding="async" />)}<span className="collection-category">{collection.category}</span></span>
      <span className="collection-copy"><span className="collection-title">{collection.title}</span><span className="collection-description">{collection.description}</span><span className="collection-meta"><span>{collection.count.toLocaleString()} 张照片</span>{collection.favorites > 0 && <span><Icon name="star" />{collection.favorites} 张星标</span>}<Icon name="right" /></span></span>
    </Button>)}</div>
    {!visible.length && <div className="empty"><Icon name="folder" /><h3>{album.photos.length ? '没有匹配的合集' : '照片整理后，合集会出现在这里'}</h3><p>{album.photos.length ? '换个关键词或分类，看看其他回忆。' : '先在相册选择照片目录，再回来看看。'}</p>{album.photos.length > 0 && <Button variant="secondary" onPress={() => { setQuery(''); setCategory('全部'); setLimit(12); }}>显示全部合集</Button>}</div>}
    {visible.length > limit && <div className="load-more"><Button variant="secondary" onPress={() => setLimit(value => value + 12)}>更多合集 · 还有 {visible.length - limit} 个</Button></div>}
    <p className="discovery-hint">合集按现有记录自动分组，无需联网。给照片加同一个标签，就能得到自己的主题合集。</p>
  </section>;
}
