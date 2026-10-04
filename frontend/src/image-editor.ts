export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export type ImageMark =
  | { kind: 'brush'; points: readonly Point[]; color: string; width: number }
  | { kind: 'mosaic'; rect: Rect; block: number }
  | { kind: 'text'; point: Point; text: string; color: string; size: number; maxWidth: number; outline: boolean }
  | { kind: 'shape'; shape: 'arrow' | 'rectangle' | 'ellipse'; start: Point; end: Point; color: string; width: number; filled: boolean };
export type ImageOperation = ImageMark
  | { kind: 'crop'; rect: Rect }
  | { kind: 'rotate'; angle: 90 | -90 }
  | { kind: 'flip'; axis: 'horizontal' | 'vertical' }
  | { kind: 'adjust'; brightness: number; contrast: number; saturation: number; filter: 'none' | 'mono' | 'warm' | 'cool' | 'sepia' };
export interface ImageDocument { operations: readonly ImageOperation[] }
export interface EditHistory { past: readonly ImageDocument[]; present: ImageDocument; future: readonly ImageDocument[] }
export const MAX_EDIT_PIXELS = 24_000_000;
export const MAX_EDIT_SIDE = 8192;
export const MAX_HISTORY = 60;

export function workingSize(width: number, height: number) {
  const scale = Math.min(1, MAX_EDIT_SIDE / Math.max(width, height), Math.sqrt(MAX_EDIT_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
export function clampPoint(point: Point, bounds: Rect): Point {
  return { x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, point.x)), y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, point.y)) };
}
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const x = Math.round(Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, rect.x)));
  const y = Math.round(Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, rect.y)));
  return { x, y, width: Math.round(Math.max(1, Math.min(bounds.x + bounds.width - x, rect.width))), height: Math.round(Math.max(1, Math.min(bounds.y + bounds.height - y, rect.height))) };
}
export function selectionRect(start: Point, end: Point, bounds: Rect, ratio = 0): Rect {
  const a = clampPoint(start, bounds); const b = clampPoint(end, bounds);
  let width = Math.abs(b.x - a.x); let height = Math.abs(b.y - a.y);
  if (ratio > 0 && width && height) {
    if (width / height > ratio) width = height * ratio;
    else height = width / ratio;
  }
  return clampRect({ x: b.x < a.x ? a.x - width : a.x, y: b.y < a.y ? a.y - height : a.y, width, height }, bounds);
}
export function commitEdit(history: EditHistory, document: ImageDocument): EditHistory {
  return { past: [...history.past, history.present].slice(-MAX_HISTORY), present: document, future: [] };
}
export function undoEdit(history: EditHistory): EditHistory {
  const previous = history.past.at(-1);
  return previous ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] } : history;
}
export function redoEdit(history: EditHistory): EditHistory {
  const next = history.future[0];
  return next ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) } : history;
}
export function documentSize(size: {width:number;height:number}, document: ImageDocument) {
  let result = { ...size };
  for (const operation of document.operations) {
    if (operation.kind === 'crop') { const r = clampRect(operation.rect, {x:0,y:0,...result}); result = {width:r.width,height:r.height}; }
    if (operation.kind === 'rotate') result = {width:result.height,height:result.width};
  }
  return result;
}
export function changedImage(document: ImageDocument): boolean { return document.operations.length > 0; }

/** In-place adjustments keep alpha intact and also work in browsers without canvas filters. */
export function adjustPixels(pixels: Uint8ClampedArray, adjustment: Extract<ImageOperation,{kind:'adjust'}>) {
  const brightness=adjustment.brightness/100, contrast=adjustment.contrast/100;
  const saturation=adjustment.filter==='mono'?0:adjustment.saturation/100;
  for(let i=0;i<pixels.length;i+=4) {
    const r=(pixels[i]*brightness-128)*contrast+128;
    const g=(pixels[i+1]*brightness-128)*contrast+128;
    const b=(pixels[i+2]*brightness-128)*contrast+128;
    const luminance=r*.2126+g*.7152+b*.0722;
    let red=luminance+(r-luminance)*saturation, green=luminance+(g-luminance)*saturation, blue=luminance+(b-luminance)*saturation;
    if(adjustment.filter==='warm'){red*=1.08;green*=1.02;blue*=.9;}
    if(adjustment.filter==='cool'){red*=.92;green*=1.02;blue*=1.1;}
    if(adjustment.filter==='sepia'){const sr=red*.393+green*.769+blue*.189,sg=red*.349+green*.686+blue*.168,sb=red*.272+green*.534+blue*.131;red=sr;green=sg;blue=sb;}
    pixels[i]=red;pixels[i+1]=green;pixels[i+2]=blue;
  }
}
export function exportName(name: string, format: 'png' | 'jpeg', date = new Date()): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'photo';
  const stamp = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}-${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}${String(date.getSeconds()).padStart(2,'0')}-${String(date.getMilliseconds()).padStart(3,'0')}`;
  return `${stem}-edited-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  return text.split('\n').flatMap(paragraph => {
    const lines: string[] = []; let line = '';
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > maxWidth) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line); return lines;
  });
}

/** Replay operations in order so rotations/crops affect existing marks as well as the photograph. */
export function renderImage(canvas: HTMLCanvasElement, image: HTMLImageElement, size: {width:number;height:number}, document: ImageDocument, scale = 1, jpeg = false) {
  let logical = { ...size };
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建图片画布。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const replace = (next: typeof logical, paint: (ctx: CanvasRenderingContext2D) => void) => {
    const buffer = canvas.ownerDocument.createElement('canvas');
    buffer.width = Math.max(1, Math.round(next.width * scale)); buffer.height = Math.max(1, Math.round(next.height * scale));
    const ctx = buffer.getContext('2d'); if (!ctx) throw new Error('浏览器无法创建编辑画布。');
    paint(ctx); canvas.width=buffer.width; canvas.height=buffer.height; context.drawImage(buffer,0,0);
    buffer.width=buffer.height=1; logical=next;
  };
  for (const mark of document.operations) {
    const sx=canvas.width/logical.width,sy=canvas.height/logical.height;
    if(mark.kind==='crop') {
      const r=clampRect(mark.rect,{x:0,y:0,...logical});
      replace({width:r.width,height:r.height},ctx=>ctx.drawImage(canvas,r.x*sx,r.y*sy,r.width*sx,r.height*sy,0,0,ctx.canvas.width,ctx.canvas.height));continue;
    }
    if(mark.kind==='rotate') {
      replace({width:logical.height,height:logical.width},ctx=>{ctx.translate(ctx.canvas.width/2,ctx.canvas.height/2);ctx.rotate(mark.angle*Math.PI/180);ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2);});continue;
    }
    if(mark.kind==='flip') {
      replace(logical,ctx=>{ctx.translate(mark.axis==='horizontal'?canvas.width:0,mark.axis==='vertical'?canvas.height:0);ctx.scale(mark.axis==='horizontal'?-1:1,mark.axis==='vertical'?-1:1);ctx.drawImage(canvas,0,0);});continue;
    }
    if(mark.kind==='adjust') {
      const pixels=context.getImageData(0,0,canvas.width,canvas.height);adjustPixels(pixels.data,mark);context.putImageData(pixels,0,0);continue;
    }
    context.save(); context.setTransform(sx,0,0,sy,0,0);
    context.lineCap='round'; context.lineJoin='round';
    if (mark.kind === 'brush') {
      const first = mark.points[0];
      if (first) {
        context.fillStyle = mark.color; context.strokeStyle = mark.color; context.lineWidth = mark.width;
        if (mark.points.length === 1) { context.beginPath(); context.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2); context.fill(); }
        else { context.beginPath(); context.moveTo(first.x, first.y); for (const point of mark.points.slice(1)) context.lineTo(point.x, point.y); context.stroke(); }
      }
    } else if (mark.kind === 'mosaic') {
      const r=clampRect(mark.rect,{x:0,y:0,...logical});
      const small = canvas.ownerDocument.createElement('canvas');
      small.width = Math.max(1, Math.ceil(r.width / mark.block)); small.height = Math.max(1, Math.ceil(r.height / mark.block));
      const sample = small.getContext('2d'); if (!sample) throw new Error('浏览器无法创建马赛克画布。');
      sample.drawImage(canvas,r.x*sx,r.y*sy,r.width*sx,r.height*sy,0,0,small.width,small.height);
      context.imageSmoothingEnabled = false; context.drawImage(small,0,0,small.width,small.height,r.x,r.y,r.width,r.height);
      small.width = small.height = 1;
    } else if(mark.kind==='shape') {
      context.strokeStyle=mark.color;context.fillStyle=mark.color;context.lineWidth=mark.width;
      const left=Math.min(mark.start.x,mark.end.x),top=Math.min(mark.start.y,mark.end.y),width=Math.abs(mark.end.x-mark.start.x),height=Math.abs(mark.end.y-mark.start.y);
      context.beginPath();
      if(mark.shape==='arrow') {
        const angle=Math.atan2(mark.end.y-mark.start.y,mark.end.x-mark.start.x),head=Math.max(mark.width*3,12);
        context.moveTo(mark.start.x,mark.start.y);context.lineTo(mark.end.x,mark.end.y);
        context.moveTo(mark.end.x-head*Math.cos(angle-.5),mark.end.y-head*Math.sin(angle-.5));context.lineTo(mark.end.x,mark.end.y);context.lineTo(mark.end.x-head*Math.cos(angle+.5),mark.end.y-head*Math.sin(angle+.5));context.stroke();
      } else {
        if(mark.shape==='rectangle')context.rect(left,top,width,height);else context.ellipse(left+width/2,top+height/2,width/2,height/2,0,0,Math.PI*2);
        if(mark.filled)context.fill();else context.stroke();
      }
    } else {
      context.font = `${mark.size}px system-ui, "Microsoft YaHei", sans-serif`; context.textBaseline='top'; context.fillStyle=mark.color;
      context.strokeStyle='#111111'; context.lineWidth=Math.max(1,mark.size*.08);
      wrapText(context,mark.text,mark.maxWidth).forEach((line,index)=>{const y=mark.point.y+index*mark.size*1.25;if(mark.outline)context.strokeText(line,mark.point.x,y);context.fillText(line,mark.point.x,y);});
    }
    context.restore();
  }
  if(jpeg){context.save();context.globalCompositeOperation='destination-over';context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.restore();}
}
