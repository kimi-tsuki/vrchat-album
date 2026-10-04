import { Button, Spinner } from '@heroui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Photo } from '../types';
import { changedImage, clampPoint, clampRect, commitEdit, documentSize, exportName, redoEdit, renderImage, selectionRect, undoEdit, workingSize } from '../image-editor';
import type { EditHistory, ImageDocument, ImageOperation, Point, Rect } from '../image-editor';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

type Tool = 'crop' | 'brush' | 'mosaic' | 'text' | 'arrow' | 'rectangle' | 'ellipse' | 'adjust';
type Adjustment = Extract<ImageOperation, { kind: 'adjust' }>;
const DEFAULT_ADJUST: Adjustment = { kind: 'adjust', brightness: 100, contrast: 100, saturation: 100, filter: 'none' };
const TOOLS: [Tool, string, string][] = [
  ['crop', '裁剪', '拖动框选保留的区域，也可以输入精确尺寸。'],
  ['brush', '画笔', '在图片上拖动画线，点击可以画一个圆点。'],
  ['mosaic', '马赛克', '拖动框选要遮挡的区域，确认后应用马赛克。'],
  ['text', '文字', '输入文字，点击图片设置位置，确认后添加。'],
  ['arrow', '箭头', '从起点拖向终点，确认后添加箭头。'],
  ['rectangle', '矩形', '拖动框选区域，确认后添加矩形。'],
  ['ellipse', '椭圆', '拖动框选区域，确认后添加椭圆。'],
  ['adjust', '调色', '实时预览配色，满意后应用调整。'],
];
function Numeric({ label, value, max, min = 0, onChange }: { label: string; value: number; max: number; min?: number; onChange(value: number): void }) {
  return <label className="album-native-field">{label}<input type="number" aria-label={label} value={value} min={min} max={max} step={1} onChange={event => { const n = event.target.valueAsNumber; if (Number.isFinite(n)) onChange(Math.round(Math.max(min, Math.min(max, n)))); }} /></label>;
}
function Range({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return <label className="album-native-field album-editor-range"><span>{label}<output>{value}</output></span><input type="range" aria-label={label} value={value} min={min} max={max} onChange={e => onChange(Number(e.target.value))} /></label>;
}

export function PhotoEditor({ photo, onClose }: { photo: Photo; onClose(): void }) {
  const [source, setSource] = useState<{ image: HTMLImageElement; width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<EditHistory>(() => ({ past: [], present: { operations: [] }, future: [] }));
  const [exported, setExported] = useState<ImageDocument | null>(null);
  const [tool, setTool] = useState<Tool>('crop');
  const [color, setColor] = useState('#ff625e');
  const [stroke, setStroke] = useState(12);
  const [block, setBlock] = useState(24);
  const [text, setText] = useState('');
  const [fontSize, setFontSize] = useState(40);
  const [outline, setOutline] = useState(true);
  const [filled, setFilled] = useState(false);
  const [anchor, setAnchor] = useState<Point>({ x: 24, y: 24 });
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, width: 1, height: 1 });
  const [arrow, setArrow] = useState<{ start: Point; end: Point } | null>(null);
  const [selection, setSelection] = useState(false);
  const [ratio, setRatio] = useState(0);
  const [adjust, setAdjust] = useState<Adjustment>(DEFAULT_ADJUST);
  const [draftBrush, setDraftBrush] = useState<Extract<ImageOperation, {kind:'brush'}> | null>(null);
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState(92);
  const [outputWidth, setOutputWidth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [renderError, setRenderError] = useState('');
  const [askDiscard, setAskDiscard] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 640, height: 480 });
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const exportPanel = useRef<HTMLFieldSetElement>(null);
  const gesture = useRef<{ id: number; start: Point; points: Point[] } | null>(null);
  const drawingFrame = useRef<number | null>(null);
  const exportLock = useRef(false);
  const mounted = useRef(true);
  const doc = history.present;
  const initial = useMemo(() => source ? workingSize(source.width, source.height) : { width: 1, height: 1 }, [source]);
  const size = useMemo(() => documentSize(initial, doc), [initial, doc]);
  const bounds = useMemo(() => ({ x: 0, y: 0, ...size }), [size]);
  const shape = tool === 'arrow' || tool === 'rectangle' || tool === 'ellipse';
  const adjusted = adjust.brightness !== 100 || adjust.contrast !== 100 || adjust.saturation !== 100 || adjust.filter !== 'none';
  const pending = selection || !!text.trim() || adjusted || !!draftBrush;
  const unsaved = pending || (changedImage(doc) && doc !== exported);
  const disabled = !source || busy;
  const fit = Math.min((stageSize.width - 32) / size.width, (stageSize.height - 32) / size.height, 1);
  const shapeOperation = (): ImageOperation => ({ kind: 'shape', shape: shape ? tool : 'rectangle', start: arrow?.start ?? { x: rect.x, y: rect.y }, end: arrow?.end ?? { x: rect.x + rect.width, y: rect.y + rect.height }, color, width: stroke, filled });
  const textOperation = (): ImageOperation => ({ kind: 'text', point: anchor, text: text.trim(), color, size: fontSize, maxWidth: Math.max(fontSize, size.width - anchor.x), outline });
  const previewOperation = draftBrush ?? (tool === 'mosaic' && selection ? { kind: 'mosaic' as const, rect, block } : shape && selection ? shapeOperation() : tool === 'text' && text.trim() ? textOperation() : tool === 'adjust' && adjusted ? adjust : null);
  const preview = previewOperation ? { operations: [...doc.operations, previewOperation] } : doc;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (drawingFrame.current !== null) cancelAnimationFrame(drawingFrame.current); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoadError(''); setSource(null);
    const image = new Image(); image.decoding = 'async';
    image.onload = () => { if (active) setSource({ image, width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { if (active) setLoadError('原图读取失败。请确认照片仍在原目录，然后重试。'); };
    image.src = photo.original_url;
    return () => { active = false; image.onload = image.onerror = null; };
  }, [photo.original_url, retry]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(entries => { const r = entries[0].contentRect; setStageSize({ width: r.width, height: r.height }); });
    observer.observe(stage.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setOutputWidth(size.width);
    setRect(clampRect({ x: Math.round(size.width * .1), y: Math.round(size.height * .1), width: Math.round(size.width * .8), height: Math.round(size.height * .8) }, bounds));
    setAnchor({ x: Math.min(24, size.width - 1), y: Math.min(24, size.height - 1) });
  }, [size.width, size.height, bounds]);
  useEffect(() => {
    if (!canvas.current || !source) return;
    const frame = requestAnimationFrame(() => {
      try { renderImage(canvas.current!, source.image, initial, preview, Math.min(1, 2048 / Math.max(initial.width, initial.height))); setRenderError(''); }
      catch { setRenderError('图片预览失败，请撤销最近的操作或重新打开编辑器。'); }
    });
    return () => cancelAnimationFrame(frame);
  }, [source, initial, preview]);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  const clearDraft = () => { gesture.current = null; setSelection(false); setArrow(null); setText(''); setAdjust(DEFAULT_ADJUST); setDraftBrush(null); };
  const close = () => { if (!exportLock.current) { if (unsaved) setAskDiscard(true); else onClose(); } };
  const undo = () => { if (pending) clearDraft(); else setHistory(undoEdit); setMessage(''); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (askDiscard || busy) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) { clearDraft(); setHistory(redoEdit); } else undo();
      }
    };
    document.addEventListener('keydown', onKey, true); return () => document.removeEventListener('keydown', onKey, true);
  });
  const commit = (operation: ImageOperation) => {
    if (doc.operations.length >= 200) { setMessage('已达到 200 个编辑步骤，请先导出；也可以撤销部分操作后继续。'); return; }
    setHistory(current => commitEdit(current, { operations: [...current.present.operations, operation] })); clearDraft(); setMessage('');
  };
  const point = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const r = event.currentTarget.getBoundingClientRect();
    return clampPoint({ x: (event.clientX - r.left) / r.width * size.width, y: (event.clientY - r.top) / r.height * size.height }, bounds);
  };
  const move = (end: Point) => {
    const active = gesture.current; if (!active) return;
    if (tool === 'brush') {
      const last = active.points.at(-1)!;
      if (Math.hypot(end.x - last.x, end.y - last.y) < .5) return;
      active.points.push(end);
      // Bound long pointer gestures without discarding their overall path.
      if (active.points.length > 8000) active.points = active.points.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
      if (drawingFrame.current === null) drawingFrame.current = requestAnimationFrame(() => { drawingFrame.current = null; if (gesture.current) setDraftBrush({ kind: 'brush', points: [...gesture.current.points], color, width: stroke }); });
    } else {
      setRect(selectionRect(active.start, end, bounds, tool === 'crop' ? ratio : 0));
      setArrow(tool === 'arrow' ? { start: active.start, end } : null); setSelection(true);
    }
  };
  const download = async () => {
    if (!source || pending || exportLock.current) return;
    exportLock.current = true; setBusy(true); setMessage('正在生成图片…');
    const output = document.createElement('canvas');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => { window.setTimeout(resolve, 0); }));
      renderImage(output, source.image, initial, doc, outputWidth / size.width, format === 'jpeg');
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('empty export')), `image/${format}`, quality / 100));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = exportName(photo.filename, format); document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (mounted.current) { setExported(doc); setMessage(`已发起下载 · ${output.width} × ${output.height} · ${format.toUpperCase()}。可在浏览器下载记录中查看。`); }
    } catch { if (mounted.current) setMessage('导出失败，请尝试减小导出宽度后重试，当前编辑仍然保留。'); }
    finally { output.width = output.height = 1; exportLock.current = false; if (mounted.current) setBusy(false); }
  };
  const updateRect = (key: keyof Rect, value: number) => { setRect(clampRect({ ...rect, [key]: value }, bounds)); setSelection(true); setArrow(null); };

  return <section className="album-editor" aria-label="图片编辑器">
    <header className="album-editor-header"><div><p className="eyebrow">把这一刻，留成你喜欢的样子</p><h2><Icon name="edit" /> 图片编辑器 <small>本机编辑</small></h2><p className="album-editor-filename">{photo.filename}</p></div><Button variant="secondary" onPress={close} isDisabled={busy}>返回详情</Button></header>
    <div className="album-editor-toolbar" aria-label="编辑工具">
      <div className="album-editor-tools">{TOOLS.map(([id, label]) => <Button key={id} size="sm" variant={tool === id ? 'primary' : 'ghost'} aria-pressed={tool === id} isDisabled={disabled} onPress={() => { clearDraft(); setTool(id); setMessage(''); }}>{label}</Button>)}</div>
      <div className="album-editor-history"><Button size="sm" variant="secondary" isDisabled={disabled || (!history.past.length && !pending)} onPress={undo}>撤销</Button><Button size="sm" variant="secondary" isDisabled={disabled || !history.future.length || pending} onPress={() => { setHistory(redoEdit); setMessage(''); }}>重做</Button><Button size="sm" variant="ghost" isDisabled={disabled || (!changedImage(doc) && !pending)} onPress={() => { clearDraft(); setHistory(current => commitEdit(current, { operations: [] })); setMessage('已恢复原图，可以撤销这一步。'); }}>恢复原图</Button><Button size="sm" variant="primary" isDisabled={disabled} onPress={() => exportPanel.current?.scrollIntoView({ block: 'nearest' })}><Icon name="download" />导出设置</Button></div>
    </div>
    <div className="album-editor-body">
      <div className="album-editor-workspace"><div className="album-editor-stage" ref={stage}>
        {!source ? <div className="album-editor-loading">{loadError ? <><p role="alert">{loadError}</p><Button variant="secondary" onPress={() => setRetry(n => n + 1)}>重试读取原图</Button></> : <><Spinner />正在加载原图…</>}</div> : <div className="album-editor-surface" style={{ width: Math.max(1, size.width * fit), height: Math.max(1, size.height * fit) }}>
          <canvas ref={canvas} tabIndex={0} role="img" aria-label="图片编辑画布" aria-describedby="album-editor-hint" onPointerDown={event => {
            if (busy || !event.isPrimary || event.button !== 0 || tool === 'adjust') return;
            const start = point(event); event.currentTarget.focus();
            if (tool === 'text') { setAnchor({ x: Math.min(size.width - 1, Math.round(start.x)), y: Math.min(size.height - 1, Math.round(start.y)) }); return; }
            gesture.current = { id: event.pointerId, start, points: [start] }; event.currentTarget.setPointerCapture(event.pointerId);
            if (tool === 'brush') setDraftBrush({ kind: 'brush', points: [start], color, width: stroke });
            else { setRect(selectionRect(start, start, bounds)); setSelection(true); setArrow(null); }
          }} onPointerMove={event => { if (gesture.current?.id === event.pointerId) move(point(event)); }} onPointerUp={event => {
            if (gesture.current?.id !== event.pointerId) return;
            move(point(event)); const active = gesture.current; gesture.current = null;
            if (tool === 'brush') commit({ kind: 'brush', points: [...active.points], color, width: stroke });
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => { gesture.current = null; setDraftBrush(null); setSelection(false); }} onLostPointerCapture={event => { if (gesture.current?.id === event.pointerId) { gesture.current = null; setDraftBrush(null); setSelection(false); } }} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && tool === 'brush' && !busy) { event.preventDefault(); commit({ kind: 'brush', points: [{ x: size.width / 2, y: size.height / 2 }], color, width: stroke }); } }} />
          {selection && (tool === 'crop' || tool === 'mosaic') && <div className={`album-editor-selection${tool === 'crop' ? ' is-crop' : ''}`} style={{ left: `${rect.x / size.width * 100}%`, top: `${rect.y / size.height * 100}%`, width: `${rect.width / size.width * 100}%`, height: `${rect.height / size.height * 100}%` }}><span>{rect.width} × {rect.height}</span></div>}
        </div>}
      </div><div className="album-editor-canvas-caption"><span>{size.width} × {size.height} px</span><span>{doc.operations.length} 步编辑 · {unsaved ? '尚未导出' : exported === doc ? '已发起下载' : '原图'}</span></div><p id="album-editor-hint" className="album-editor-hint">{TOOLS.find(item => item[0] === tool)?.[2]} {pending && '切换工具会取消当前预览。'}</p>{renderError && <p className="album-editor-error" role="alert">{renderError}</p>}
      </div>
      <aside className="album-editor-panel"><fieldset disabled={disabled} className="album-editor-settings"><h3>{TOOLS.find(item => item[0] === tool)?.[1]} <small>工具设置</small></h3>
        {(tool === 'brush' || tool === 'text' || shape) && <label className="album-native-field album-editor-color">颜色<input type="color" aria-label="标注颜色" value={color} onChange={e => setColor(e.target.value)} /></label>}
        {(tool === 'brush' || shape) && <Range label="笔画粗细" value={stroke} min={1} max={160} onChange={setStroke} />}
        {tool === 'crop' && <label className="album-native-field">拖选比例<select aria-label="裁剪比例" value={ratio} onChange={e => { const next = Number(e.target.value); setRatio(next); if (selection && next) setRect(selectionRect({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, bounds, next)); }}><option value={0}>自由裁剪</option><option value={1}>1:1 · 正方形</option><option value={4 / 3}>4:3 · 照片</option><option value={16 / 9}>16:9 · 宽屏</option><option value={9 / 16}>9:16 · 竖屏</option></select></label>}
        {(tool === 'crop' || tool === 'mosaic' || shape) && <><div className="album-editor-numbers"><Numeric label="选区 X" value={rect.x} max={size.width - 1} onChange={n => updateRect('x', n)} /><Numeric label="选区 Y" value={rect.y} max={size.height - 1} onChange={n => updateRect('y', n)} /><Numeric label="选区宽度" value={rect.width} min={1} max={size.width - rect.x} onChange={n => updateRect('width', n)} /><Numeric label="选区高度" value={rect.height} min={1} max={size.height - rect.y} onChange={n => updateRect('height', n)} /></div><p className="album-editor-note">数值单位为像素；手动输入尺寸可自由调整比例。</p></>}
        {tool === 'mosaic' && <Range label="马赛克块大小" value={block} min={8} max={120} onChange={setBlock} />}
        {shape && tool !== 'arrow' && <label className="album-editor-check"><input type="checkbox" checked={filled} onChange={e => setFilled(e.target.checked)} />填充形状</label>}
        {tool === 'text' && <><label className="album-native-field">文字内容<textarea aria-label="文字内容" rows={3} maxLength={500} placeholder="写下这一刻…" value={text} onChange={e => setText(e.target.value)} /></label><Range label="文字大小" value={fontSize} min={12} max={240} onChange={setFontSize} /><div className="album-editor-numbers"><Numeric label="文字 X" value={anchor.x} max={size.width - 1} onChange={n => setAnchor({ ...anchor, x: n })} /><Numeric label="文字 Y" value={anchor.y} max={size.height - 1} onChange={n => setAnchor({ ...anchor, y: n })} /></div><label className="album-editor-check"><input type="checkbox" checked={outline} onChange={e => setOutline(e.target.checked)} />深色描边，让文字更清晰</label><Button size="sm" isDisabled={!text.trim()} onPress={() => commit(textOperation())}>添加文字</Button></>}
        {tool === 'adjust' && <><Range label="亮度" value={adjust.brightness} min={0} max={200} onChange={n => setAdjust({ ...adjust, brightness: n })} /><Range label="对比度" value={adjust.contrast} min={0} max={200} onChange={n => setAdjust({ ...adjust, contrast: n })} /><Range label="饱和度" value={adjust.saturation} min={0} max={200} onChange={n => setAdjust({ ...adjust, saturation: n })} /><label className="album-native-field">滤镜<select aria-label="图片滤镜" value={adjust.filter} onChange={e => setAdjust({ ...adjust, filter: e.target.value as Adjustment['filter'] })}><option value="none">原色</option><option value="mono">黑白</option><option value="warm">暖调</option><option value="cool">冷调</option><option value="sepia">怀旧</option></select></label><Button size="sm" isDisabled={!adjusted} onPress={() => commit(adjust)}>应用调色</Button></>}
        {tool === 'crop' && <Button size="sm" isDisabled={!selection} onPress={() => commit({ kind: 'crop', rect })}>应用裁剪</Button>}
        {tool === 'mosaic' && <Button size="sm" isDisabled={!selection} onPress={() => commit({ kind: 'mosaic', rect, block })}>应用马赛克</Button>}
        {shape && <Button size="sm" isDisabled={!selection} onPress={() => commit(shapeOperation())}>添加{TOOLS.find(item => item[0] === tool)?.[1]}</Button>}
        {pending && <Button size="sm" variant="ghost" onPress={clearDraft}>取消当前预览</Button>}
        <div className="album-editor-transform"><h3>旋转与翻转</h3><div>{([['向左旋转', { kind: 'rotate', angle: -90 }], ['向右旋转', { kind: 'rotate', angle: 90 }], ['水平翻转', { kind: 'flip', axis: 'horizontal' }], ['垂直翻转', { kind: 'flip', axis: 'vertical' }]] as [string, ImageOperation][]).map(([label, operation]) => <Button key={label} size="sm" variant="secondary" isDisabled={pending} onPress={() => commit(operation)}>{label}</Button>)}</div></div>
      </fieldset>
      <fieldset ref={exportPanel} disabled={disabled} className="album-editor-export"><h3>导出新图片</h3><div className="album-editor-numbers"><label className="album-native-field">文件格式<select aria-label="导出格式" value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="png">PNG · 无损</option><option value="jpeg">JPEG · 小体积</option></select></label><Numeric label="导出宽度" min={1} max={size.width} value={outputWidth} onChange={setOutputWidth} /></div>{format === 'jpeg' && <Range label="JPEG 质量" value={quality} min={50} max={100} onChange={setQuality} />}<p className="album-editor-note">输出 {outputWidth} × {Math.max(1, Math.round(size.height * outputWidth / size.width))} px，保持比例。{format === 'jpeg' && '透明区域填充为白色。'}</p><Button onPress={() => { void download(); }} isPending={busy} isDisabled={disabled || pending || !!renderError}><Icon name="download" />导出并下载</Button>{pending && <p className="album-editor-note">先应用或取消当前预览，再导出。</p>}<p className="album-editor-note">另存一张新图片，原图保留。编辑步骤仅在本次打开期间保留，导出图片不携带原照片的元数据。</p></fieldset>
      {source && (source.width !== initial.width || source.height !== initial.height) && <p className="album-editor-note">原图较大，为保证编辑稳定，工作尺寸已缩小为 {initial.width} × {initial.height}（最长边 8192 px、最多 2400 万像素）。</p>}
      <p className="album-editor-message" role="status">{message || '支持 Ctrl / ⌘ Z 撤销，Ctrl / ⌘ Shift Z 重做。'}</p></aside>
    </div>
    <Dialog isOpen={askDiscard} onClose={() => setAskDiscard(false)} title="编辑尚未导出" description="当前图片还有未导出的编辑或预览，返回详情会丢弃这些内容。" footer={<><Button variant="secondary" onPress={() => setAskDiscard(false)}>继续编辑</Button><Button variant="danger-soft" onPress={onClose}>放弃编辑并返回</Button></>}><p>可以先继续编辑，导出新图片后再返回。</p></Dialog>
  </section>;
}
