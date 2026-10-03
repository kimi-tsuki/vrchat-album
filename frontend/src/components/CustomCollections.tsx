import { Button } from '@heroui/react';
import { useMemo, useState } from 'react';
import { request } from '../api';
import { customMembers } from '../collections';
import { tagsFrom, worldName } from '../model';
import type { CustomCollection } from '../types';
import type { AlbumHook } from '../useAlbum';
import { Dialog } from './Dialog';
import { Field } from './Field';

export function CollectionEditor({ album, initial, onClose }: { album: AlbumHook; initial?: CustomCollection; onClose(): void }) {
  const [draft, setDraft] = useState<CustomCollection>(() => initial || { id:'', revision:0, name:'', mode:album.selected.size ? 'manual' : 'rules', ids:[...album.selected], cover:'', rules:{from:'',to:'',world:'',tags:[],favorites:false} });
  const [tagText, setTagText] = useState(initial?.rules.tags.join('，') || '');
  const [sourceRevision] = useState(album.catalog?.source_revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(60);
  const dragged = useState<{ id: string }>(() => ({ id:'' }))[0];
  const members = useMemo(() => customMembers(album.photos, draft), [album.photos, draft]);
  const patch = (value: Partial<CustomCollection>) => setDraft(c => ({ ...c, ...value }));
  const rules = (value: Partial<CustomCollection['rules']>) => setDraft(c => ({ ...c, rules:{...c.rules,...value} }));
  const move = (id: string, delta: number) => {
    const ids = [...draft.ids]; const i = ids.indexOf(id); const j = Math.max(0, Math.min(ids.length - 1, i + delta));
    [ids[i],ids[j]] = [ids[j],ids[i]]; patch({ ids });
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const { collection } = await request<{collection:CustomCollection}>('/api/collections/save', { collection:draft, source_revision:sourceRevision });
      await album.refresh(); album.openCollection({title:collection.name, description:collection.mode === 'manual' ? '手选照片 · 自定顺序' : '组合规则 · 自动收集',rule:{kind:'custom',value:collection}}); onClose();
    } catch(e) { setError(e instanceof Error ? e.message : '合集保存失败'); } finally { setBusy(false); }
  };
  return <Dialog isOpen onClose={onClose} title={initial ? '编辑自定义合集' : '新建自定义合集'} size="lg" isBusy={busy} description="合集只保存照片引用，不复制或移动原图。组合规则需要同时满足；手选顺序可拖动，也可用上下按钮调整。" footer={<><Button variant="ghost" onPress={onClose} isDisabled={busy}>取消</Button><Button onPress={() => { void save(); }} isPending={busy} isDisabled={!draft.name.trim() || album.pendingSourceChange}>保存合集</Button></>}>
    <div className="field-stack"><Field label="合集名称" value={draft.name} onChange={name => patch({name})} maxLength={100} isDisabled={busy}/>
    <label className="album-native-field">收集方式<select aria-label="合集收集方式" disabled={busy} value={draft.mode} onChange={e => patch({mode:e.target.value as CustomCollection['mode']})}><option value="rules">组合规则 · 自动收集</option><option value="manual">手选照片 · 自定顺序</option></select></label>
    {draft.mode === 'rules' ? <><div className="album-rule-dates"><label className="album-native-field">开始日期<input type="date" aria-label="合集开始日期" value={draft.rules.from} onChange={e=>rules({from:e.target.value})}/></label><label className="album-native-field">结束日期<input type="date" aria-label="合集结束日期" value={draft.rules.to} onChange={e=>rules({to:e.target.value})}/></label></div>
      <label className="album-native-field">世界<select aria-label="合集世界规则" value={draft.rules.world} onChange={e=>rules({world:e.target.value})}><option value="">全部世界</option>{album.sidebar.worlds.map(w=><option value={w.key} key={w.key}>{w.name}</option>)}</select></label>
      <Field label="同时包含这些标签" value={tagText} onChange={value=>{setTagText(value);rules({tags:tagsFrom(value)});}} description="逗号分隔；例如 朋友，风景，照片需要同时有两个标签。"/>
      <label><input type="checkbox" checked={draft.rules.favorites} onChange={e=>rules({favorites:e.target.checked})}/> 只收集星标照片</label></> : <Button variant="secondary" onPress={()=>patch({ids:[...new Set([...draft.ids,...album.filtered.map(p=>p.id)])]})} isDisabled={busy || album.filtered.length + draft.ids.length > 2000}>加入当前筛选照片</Button>}
    <p className="discovery-hint">匹配 {members.length} 张照片 · 点击“用作封面”固定封面，取消后使用第一张。</p>
    <div className="album-members">{members.slice(0,limit).map((p,i)=><div className="album-member" key={p.id} draggable={draft.mode==='manual' && !busy} onDragStart={()=>{dragged.id=p.id;}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault(); if(dragged.id && dragged.id!==p.id && draft.mode==='manual'){const ids=draft.ids.filter(id=>id!==dragged.id);ids.splice(ids.indexOf(p.id),0,dragged.id);patch({ids});} dragged.id='';}}>
      <img src={p.thumb_url} alt="" loading="lazy"/><span>{i+1}. {worldName(p)}<small>{p.date} · {p.filename}</small></span><Button size="sm" variant={draft.cover===p.id?'primary':'secondary'} onPress={()=>patch({cover:draft.cover===p.id?'':p.id})}>{draft.cover===p.id?'取消封面':'用作封面'}</Button>
      {draft.mode==='manual' && <><Button size="sm" variant="ghost" aria-label={`上移第 ${i+1} 张照片`} isDisabled={!i} onPress={()=>move(p.id,-1)}>↑</Button><Button size="sm" variant="ghost" aria-label={`下移第 ${i+1} 张照片`} isDisabled={i===members.length-1} onPress={()=>move(p.id,1)}>↓</Button><Button size="sm" variant="ghost" onPress={()=>patch({ids:draft.ids.filter(id=>id!==p.id),cover:draft.cover===p.id?'':draft.cover})}>移出合集</Button></>}
    </div>)}</div>{members.length>limit && <Button variant="ghost" onPress={()=>setLimit(n=>n+60)}>显示更多照片</Button>}
    {error && <p className="form-message error" role="alert">{error}</p>}</div>
  </Dialog>;
}
