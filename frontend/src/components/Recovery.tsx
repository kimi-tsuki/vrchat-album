import { Button } from '@heroui/react';
import { useEffect, useState } from 'react';
import { request } from '../api';
import type { AlbumHook } from '../useAlbum';
import { Dialog } from './Dialog';

interface Entry {id:number;created:string;label:string;count:number;undone:boolean}
interface Preview {matched:number;changed:number;missing:number;source_revision:number;revision:number}
export function Recovery({album,onClose}:{album:AlbumHook;onClose():void}) {
  const [entries,setEntries]=useState<Entry[]>([]);
  const [source]=useState(album.catalog?.source_revision);
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [message,setMessage]=useState('');
  const [text,setText]=useState(''); const [mode,setMode]=useState('fill'); const [preview,setPreview]=useState<Preview|null>(null);
  const load=async()=>{const history=await request<{entries:Entry[];source_revision:number}>('/api/history');if(history.source_revision!==source)throw new Error('照片目录已更换，请重新打开整理记录。');setEntries(history.entries);};
  useEffect(()=>{void load().catch(e=>setError(String(e.message)));},[]); // A recovery session is bound to its original source.
  const perform=async(action:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}};
  const latest=entries.find(e=>!e.undone);
  const payload=()=>({document:JSON.parse(text) as unknown,mode,source_revision:source});
  return <Dialog isOpen onClose={onClose} title="整理记录与恢复" size="lg" isBusy={busy} description="最近 50 次照片标注保存在本机，可依次撤销。恢复记录按照片内容编号匹配，只修改本机标注，不改动原图。">
    <h3>最近的整理</h3><div className="album-history-actions"><Button size="sm" variant="secondary" isDisabled={!latest || busy || album.pendingSourceChange} onPress={()=>{void perform(async()=>{await request('/api/history/undo',{id:latest?.id,source_revision:source});await album.refresh();await load();setPreview(null);setMessage('已撤销最近的整理。');});}}>撤销最近整理</Button><Button size="sm" variant="ghost" isDisabled={busy} onPress={()=>{void perform(load);}}>刷新记录</Button></div>
    <div className="album-history">{entries.slice(0,12).map(e=><p key={e.id}><time>{e.created.replace('T',' ')}</time><span>{e.label} · {e.count} 张</span><small>{e.undone?'已撤销':e.id===latest?.id?'可撤销':'历史记录'}</small></p>)}{!entries.length && <p>这一目录还没有可撤销的整理记录，新保存的标注会记录在这里。</p>}</div>
    <h3>从 JSON 恢复标注</h3><p className="discovery-hint">支持当前整理记录、旧版导出文件与标注草稿。仅恢复当前照片目录能匹配的标注；自定义合集、缩略图和完整索引请备份 data 目录。单次最多 16 MB、20000 张记录。</p>
    <fieldset disabled={busy} className="album-recovery-form"><label className="album-native-field">选择整理记录<input aria-label="选择整理记录文件" type="file" accept="application/json,.json" onChange={e=>{const file=e.target.files?.[0];if(file){setPreview(null);if(file.size>16*1024*1024){setError('记录文件超过 16 MB，请使用完整 data 备份。');return;}void file.text().then(value=>{setText(value);setError('');}).catch(()=>setError('无法读取记录文件。'));}}}/></label>
    <label className="album-native-field">或粘贴记录<textarea aria-label="整理记录 JSON" value={text} rows={5} onChange={e=>{setText(e.target.value);setPreview(null);}} placeholder="粘贴从相册导出的 JSON…"/></label>
    <label className="album-native-field">恢复方式<select aria-label="恢复方式" value={mode} onChange={e=>{setMode(e.target.value);setPreview(null);}}><option value="fill">仅补充空白标注</option><option value="restore">恢复为备份中的值</option></select></label>
    <Button variant="secondary" size="sm" isDisabled={!text.trim() || busy} onPress={()=>{void perform(async()=>{setPreview(null);setPreview(await request<Preview>('/api/import/preview',payload()));});}}>预览恢复</Button>
    {preview && <div className="album-import-preview"><p>匹配 <strong>{preview.matched}</strong> 张 · 会改变 <strong>{preview.changed}</strong> 张 · 未找到 <strong>{preview.missing}</strong> 张</p><p>{mode==='restore'?'确认恢复后，匹配照片的标注会采用备份值，可撤销这次恢复。':'只填充当前空白内容，已有标注保留。'}</p><Button isDisabled={!preview.changed || busy || album.pendingSourceChange} onPress={()=>{void perform(async()=>{const result=await request<Preview>('/api/import/apply',{...payload(),revision:preview.revision});await album.refresh();await load();setPreview(null);setMessage(`已恢复 ${result.changed} 张照片的标注，未找到的 ${result.missing} 张已跳过。`);});}}>确认恢复标注</Button></div>}
    </fieldset>{error && <p role="alert" className="form-message error">{error}</p>}{message && <p role="status" className="form-message">{message}</p>}
  </Dialog>;
}
