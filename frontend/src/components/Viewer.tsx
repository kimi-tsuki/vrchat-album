import { Button, Modal, Spinner } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { AlbumHook } from '../useAlbum';
import { dateText, timeText, worldName } from '../model';
import { Field } from './Field';
import { Icon } from './Icon';
import { useEntrance } from '../motion';
import { clampPan, swipeDirection } from '../viewer-tools';

export function DraftActions({ album }: { album: AlbumHook }) {
  if (!album.pendingSourceChange && !album.viewerMissing) return null;
  return <div className="draft-actions"><p>{album.pendingSourceChange ? '另一个窗口更换了照片文件夹。这份草稿仍保留在这里，请先复制或导出，再放弃草稿并打开当前相册。' : '这张照片已经不在当前相册中，草稿仍保留在这里。请先复制或导出，然后放弃草稿并关闭。'}</p>
    <div className="form-actions"><Button size="sm" variant="secondary" onPress={() => { void album.copyDraft(); }}>复制草稿</Button><Button size="sm" variant="secondary" onPress={album.exportDraft}>导出草稿 JSON</Button></div>
    {album.draftText && <textarea readOnly aria-label="可复制的文字草稿" value={album.draftText} onFocus={event => event.target.select()} />}
    <Button size="sm" variant="danger-soft" onPress={() => { if (album.pendingSourceChange) void album.discardDraftAndRefresh(); else album.discardViewerDraft(); }}>{album.pendingSourceChange ? '放弃草稿并打开当前相册' : '放弃草稿并关闭'}</Button>
  </div>;
}

function OriginalImage({ url, alt, onMove, onReady }: { url: string; alt: string; onMove(direction: -1 | 1): void; onReady(ready: boolean): void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const start = useRef<{ x: number; y: number; pan: typeof pan } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  useEntrance(imageRef, state === 'ready' ? url : '');
  useEffect(() => { onReady(state === 'ready'); }, [state, onReady]);
  const toggleZoom = () => { setZoom(value => value === 1 ? 2.5 : 1); setPan({ x: 0, y: 0 }); };
  return <><div className={`album-image-canvas${zoom > 1 ? ' zoomed' : ''}`} onDoubleClick={toggleZoom}
    onPointerDown={event => { if (event.pointerType === 'mouse' && zoom === 1) return; start.current = { x: event.clientX, y: event.clientY, pan }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (!start.current || zoom === 1) return; setPan({ x: clampPan(start.current.pan.x + event.clientX - start.current.x, event.currentTarget.clientWidth, zoom), y: clampPan(start.current.pan.y + event.clientY - start.current.y, event.currentTarget.clientHeight, zoom) }); }}
    onPointerUp={event => { const origin = start.current; start.current = null; if (origin && zoom === 1) { const direction = swipeDirection(event.clientX - origin.x, event.clientY - origin.y); if (direction) onMove(direction); } }}
    onPointerCancel={() => { start.current = null; }}>
    <img ref={imageRef} draggable={false} className="viewer-image" src={url} alt={alt} style={{ opacity: state === 'ready' ? 1 : 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} onLoad={() => setState('ready')} onError={() => setState('error')} />
  </div><Button className="album-zoom-control" size="sm" variant="secondary" onPress={toggleZoom} isDisabled={state !== 'ready'}>{zoom === 1 ? '放大 · 双击照片' : '还原大小'}</Button>
    {state !== 'ready' && <span className="viewer-image-state">{state === 'loading' ? <><Spinner size="sm" /> 正在加载原图…</> : '原图暂时无法读取，可以尝试打开原图链接。'}</span>}</>;
}

export function Viewer({ album }: { album: AlbumHook }) {
  const photo = album.viewerPhoto;
  const viewer = album.viewer;
  const [immersive, setImmersive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [interval, setIntervalSeconds] = useState(5);
  const [imageReady, setImageReady] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const blocked = !viewer || viewer.dirty || viewer.saving || album.pendingSourceChange || album.viewerMissing || !!album.batch;
  useEffect(() => { setImageReady(false); }, [photo?.id]);
  useEffect(() => {
    if (!viewer || blocked || album.viewerIndex >= album.viewerCount - 1) setPlaying(false);
  }, [viewer, blocked, album.viewerIndex, album.viewerCount]);
  useEffect(() => {
    if (!playing || blocked || !imageReady) return;
    const timer = window.setTimeout(() => { if (!document.hidden) void album.moveViewer(1); else setPlaying(false); }, interval * 1000);
    return () => clearTimeout(timer);
  }, [playing, blocked, imageReady, photo?.id, interval, album.moveViewer]);
  useEffect(() => {
    if (!viewer) { setPlaying(false); setImmersive(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }
  }, [viewer]);
  const fullscreen = async () => {
    setImmersive(true); setFullscreenError('');
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if (root.current?.requestFullscreen) await root.current.requestFullscreen(); else setFullscreenError('当前浏览器不支持系统全屏，已进入沉浸模式。'); }
    catch { setFullscreenError('浏览器未允许系统全屏，已进入沉浸模式。'); }
  };
  useEffect(() => {
    if (!viewer || album.batch) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,[contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); void album.moveViewer(event.key === 'ArrowLeft' ? -1 : 1); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewer, album.batch, album.moveViewer]);
  return <Modal><Modal.Backdrop isOpen={!!viewer} onOpenChange={open => { if (!open) void album.closeViewer(); }} isDismissable={false} isKeyboardDismissDisabled={viewer?.saving || album.pendingSourceChange}>
    <Modal.Container size="full" className="viewer-container"><Modal.Dialog aria-label="照片查看器" className={`viewer-dialog${immersive ? ' album-immersive' : ''}`}><div className="album-viewer-root" ref={root}>
      {photo && viewer && <>
        <header className="viewer-top"><div className="viewer-position"><strong>{album.viewerIndex >= 0 ? album.viewerIndex + 1 : '—'}</strong> / {album.viewerCount} <span> · {worldName(photo)}</span></div><div className="viewer-top-actions">
          <Button isIconOnly variant="ghost" aria-label="上一张照片" onPress={() => { void album.moveViewer(-1); }} isDisabled={album.viewerIndex <= 0 || viewer.saving || album.pendingSourceChange}><Icon name="left" /></Button>
          <Button isIconOnly variant="ghost" aria-label="下一张照片" onPress={() => { void album.moveViewer(1); }} isDisabled={album.viewerIndex < 0 || album.viewerIndex >= album.viewerCount - 1 || viewer.saving || album.pendingSourceChange}><Icon name="right" /></Button>
          <Button isIconOnly variant="ghost" className="viewer-favorite" aria-label={photo.favorite ? '取消星标' : '添加星标'} aria-pressed={photo.favorite} onPress={() => { void album.toggleFavorite(photo.id); }} isDisabled={album.pendingSourceChange}><Icon key={String(photo.favorite)} name="star" style={photo.favorite ? { fill: 'currentColor', color: 'var(--accent)' } : undefined} /></Button>
          <Button isIconOnly variant="ghost" aria-label="关闭照片查看器" isDisabled={viewer.saving || album.pendingSourceChange} onPress={() => { void album.closeViewer(); }}><Icon name="close" /></Button>
        </div></header>
        <div className="album-viewer-tools"><Button size="sm" variant="secondary" onPress={() => { setImmersive(!immersive); setPlaying(false); }}>{immersive ? '显示整理面板' : '沉浸看图'}</Button><Button size="sm" variant="ghost" onPress={() => { void fullscreen(); }}>全屏</Button><Button size="sm" variant="secondary" isDisabled={blocked || album.viewerIndex >= album.viewerCount - 1} onPress={() => { setImmersive(true); setPlaying(!playing); }}>{playing ? '暂停播放' : '自动播放'}</Button><label>间隔 <select aria-label="幻灯片播放间隔" value={interval} onChange={event => setIntervalSeconds(Number(event.target.value))}><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={15}>15 秒</option></select></label><span role="status">{fullscreenError || (viewer.dirty ? '先保存标注再播放' : '双击缩放 · 放大后拖动 · 触屏左右滑动')}</span></div>
        <div className="viewer-body"><div className="viewer-stage"><OriginalImage key={photo.id} url={photo.original_url} alt={photo.world || photo.filename} onReady={setImageReady} onMove={direction => { setPlaying(false); void album.moveViewer(direction); }} /></div>
          <aside className="viewer-side"><div className="viewer-photo-meta" key={photo.id}><p className="eyebrow">这一刻的回忆</p><h2>{dateText(photo.date)}</h2><div className="viewer-meta">{timeText(photo)} · {photo.width} × {photo.height} · {photo.session_label}</div><p className="viewer-file">{photo.filename}</p></div>
            <form onSubmit={event => { event.preventDefault(); void album.saveViewer(); }}><div className="field-stack"><Field label="世界名称" value={viewer.fields.world} onChange={world => album.updateViewer({ world })} placeholder="为这次漫游取一个名字" maxLength={200} isDisabled={viewer.saving} />
              <Field label="标签" value={viewer.fields.tagsText} onChange={tagsText => album.updateViewer({ tagsText })} placeholder="朋友，风景，想再来一次" description="用逗号分隔多个标签" isDisabled={viewer.saving} />
              <Field label="留下这段回忆" value={viewer.fields.note} onChange={note => album.updateViewer({ note })} placeholder="那天发生了什么？" multiline maxLength={4000} isDisabled={viewer.saving} /></div>
            <Button type="submit" className="save-button" isPending={viewer.saving} isDisabled={album.pendingSourceChange || album.viewerMissing}>保存这段回忆</Button></form><p className="save-status" role="status">{viewer.message || '记录保存在本机，原照片不会被修改。'}</p>
            <DraftActions album={album} />
            <div className="viewer-links"><a href={photo.original_url} target="_blank" rel="noopener noreferrer"><Icon name="external" /> 打开原图</a><Button variant="ghost" onPress={() => { void album.openSession(photo.session_id); }} isDisabled={album.pendingSourceChange || viewer.saving}><Icon name="edit" />为这一场的 {album.sessionCount} 张照片填写世界</Button>{photo.copies > 1 && <p>{photo.copies} 个完全相同的副本合并显示，所有原文件均保留。</p>}</div>
          </aside></div>
      </>}
    </div></Modal.Dialog></Modal.Container>
  </Modal.Backdrop></Modal>;
}
