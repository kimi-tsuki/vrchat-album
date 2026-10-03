import { Button, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { request } from '../api';
import { worldName } from '../model';
import type { AlbumHook } from '../useAlbum';
import { Dialog } from './Dialog';

export function Similar({ album }: { album: AlbumHook }) {
  const [groups, setGroups] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(12);
  const [compare, setCompare] = useState<string[] | null>(null);
  const [left, setLeft] = useState(''); const [right, setRight] = useState('');
  const [generation, setGeneration] = useState(album.catalog?.source_revision);
  const source = album.catalog?.source_revision;
  useEffect(()=>{setGroups([]);setChecked(null);setCompare(null);setGeneration(source);},[source]);
  const find = async () => {
    setBusy(true); setError('');
    try { const result = await request<{groups:string[][];source_revision:number;checked:number}>('/api/similar');
      if (result.source_revision !== source) throw new Error('照片目录已更换，请刷新相册后重试。');
      setGroups(result.groups);setChecked(result.checked);setGeneration(result.source_revision);setLimit(12);
    } catch(e) {setError(e instanceof Error?e.message:'查找失败');} finally{setBusy(false);}
  };
  const byId = new Map(album.photos.map(p=>[p.id,p]));
  const members = (compare || []).flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
  const stale = generation !== source || album.pendingSourceChange;
  return <section className="collections-section" aria-label="相似照片整理"><div className="discovery-heading"><div><p className="eyebrow">KEEP YOUR FAVORITE TAKE</p><h2>把相近的瞬间，放在一起看</h2><p>比较同一世界、两分钟内的构图与颜色。结果是候选分组，可以并排查看，再给喜欢的一张加星标。</p></div><Button onPress={()=>{void find();}} isPending={busy} isDisabled={album.catalog?.scanning}>{checked===null?'查找相似照片':'重新查找'}</Button></div>
    {busy && <p className="form-message"><Spinner size="sm"/>正在比较本机缩略图，首次运行会建立缓存…</p>}
    {error && <p role="alert" className="form-message error">{error}</p>}
    {checked!==null && <p className="discovery-hint">已比较 {checked} 张照片，找到 {groups.length} 组。每组最多 24 张；只比较相邻 32 张候选。原文件全部保留。</p>}
    <div className="collection-grid">{groups.slice(0,limit).map(ids=>{const photos=ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);return photos.length>1 && <Button className="collection-card" variant="ghost" key={ids.join(',')} onPress={()=>{setCompare(ids);setLeft(ids[0]);setRight(ids[1]);}}><span className="collection-covers">{photos.slice(0,3).map(p=><img key={p.id} src={p.thumb_url} alt="" loading="lazy"/>)}</span><span className="collection-copy"><span className="collection-title">{worldName(photos[0])}</span><span className="collection-description">{photos[0].date} · {photos.length} 张候选</span><span className="collection-meta">并排对比 →</span></span></Button>})}</div>
    {checked!==null && !groups.length && <div className="empty"><h3>暂时没有相似的连拍候选</h3><p>完全相同的文件仍会在相册中合并显示。</p></div>}
    {groups.length>limit && <Button variant="secondary" onPress={()=>setLimit(n=>n+12)}>更多候选分组</Button>}
    <Dialog isOpen={!!compare} onClose={()=>setCompare(null)} title="并排对比相似照片" size="lg" description="加星标表示偏爱这张照片。不会自动删除、隐藏或覆盖其他候选。">
      <div className="album-compare">{[left,right].map((id,index)=>{const photo=byId.get(id);return <div key={index} className="album-compare-side"><select aria-label={index?'右侧对比照片':'左侧对比照片'} value={id} onChange={e=>index?setRight(e.target.value):setLeft(e.target.value)}>{members.map((p,i)=><option value={p.id} key={p.id}>{i+1}. {p.filename}</option>)}</select>{photo && <><a href={photo.original_url} target="_blank" rel="noopener noreferrer"><img src={photo.original_url} alt={`${index?'右':'左'}侧 ${photo.filename}`}/></a><p>{photo.width} × {photo.height} · {photo.captured_at.slice(11,19)}</p><Button size="sm" variant={photo.favorite?'primary':'secondary'} isDisabled={stale} onPress={()=>{void album.toggleFavorite(photo.id);}}>{photo.favorite?'已设为星标 · 取消':'喜欢这张 · 加星标'}</Button></>}</div>})}</div>
    </Dialog></section>;
}
