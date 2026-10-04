import { describe, expect, it } from 'vitest';
import { adjustPixels, changedImage, clampPoint, clampRect, commitEdit, documentSize, exportName, MAX_EDIT_PIXELS, MAX_EDIT_SIDE, MAX_HISTORY, redoEdit, selectionRect, undoEdit, workingSize } from './image-editor';
import type { EditHistory, ImageDocument, ImageOperation } from './image-editor';

const bounds = { x: 0, y: 0, width: 640, height: 480 };
const initial = (): EditHistory => ({ past: [], present: { operations: [] }, future: [] });
const rotate: ImageOperation = { kind: 'rotate', angle: 90 };
describe('image editing geometry', () => {
  it.each([[640, 480], [8192, 1024], [240, 720]])('retains normal resolution %i × %i', (width, height) => {
    expect(workingSize(width, height)).toEqual({ width, height });
  });
  it.each([[16000, 12000], [100000, 1], [1, 100000], [8000, 8000]])('limits large working buffers %i × %i', (width, height) => {
    const size = workingSize(width, height);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_EDIT_PIXELS);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_EDIT_SIDE);
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(1);
  });
  it('clips pointer coordinates and integer selections to the actual image', () => {
    expect(clampPoint({ x: -20, y: 900 }, bounds)).toEqual({ x: 0, y: 480 });
    expect(clampRect({ x: 600, y: 450, width: 200, height: 90 }, bounds)).toEqual({ x: 600, y: 450, width: 40, height: 30 });
    expect(clampRect({ x: 900, y: 900, width: -2, height: 0 }, bounds)).toEqual({ x: 639, y: 479, width: 1, height: 1 });
  });
  it('normalizes reverse drags without losing the selected region', () => {
    expect(selectionRect({ x: 500, y: 400 }, { x: 100, y: 50 }, bounds)).toEqual({ x: 100, y: 50, width: 400, height: 350 });
  });
  it('constrains the ratio in either drag direction', () => {
    expect(selectionRect({ x: 100, y: 50 }, { x: 500, y: 400 }, bounds, 1)).toEqual({ x: 100, y: 50, width: 350, height: 350 });
    expect(selectionRect({ x: 500, y: 400 }, { x: 100, y: 50 }, bounds, 1)).toEqual({ x: 150, y: 50, width: 350, height: 350 });
    expect(selectionRect({ x: 0, y: 0 }, { x: 640, y: 480 }, bounds, 16 / 9)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });
  it('keeps a click-only selection nonzero and within the edge', () => {
    expect(selectionRect({ x: 640, y: 480 }, { x: 640, y: 480 }, bounds)).toEqual({ x: 639, y: 479, width: 1, height: 1 });
  });
  it('uses each previous operation’s output coordinates', () => {
    const document: ImageDocument = { operations: [rotate, { kind: 'crop', rect: { x: 300, y: 500, width: 250, height: 200 } }, rotate] };
    expect(documentSize(bounds, document)).toEqual({ width: 140, height: 180 });
    expect(documentSize(bounds, { operations: [rotate, rotate, rotate, rotate] })).toEqual({ width: 640, height: 480 });
  });
});
describe('non-destructive edit history', () => {
  it('undoes to the exact saved document and branches after undo', () => {
    const start = initial();
    const first = commitEdit(start, { operations: [rotate] });
    const second = commitEdit(first, { operations: [rotate, rotate] });
    const undo = undoEdit(second);
    expect(undo.present).toBe(first.present);
    expect(redoEdit(undo).present).toBe(second.present);
    const branch = commitEdit(undo, { operations: [rotate, { kind: 'flip', axis: 'horizontal' }] });
    expect(branch.future).toHaveLength(0);
    expect(start.present.operations).toHaveLength(0);
  });
  it('allows undoing a restore-original operation', () => {
    const edit = commitEdit(initial(), { operations: [rotate] });
    const reset = commitEdit(edit, { operations: [] });
    expect(changedImage(reset.present)).toBe(false);
    expect(undoEdit(reset).present).toBe(edit.present);
  });
  it('bounds undo memory without removing already applied operations', () => {
    let history = initial();
    for (let i = 0; i < MAX_HISTORY + 10; i++) history = commitEdit(history, { operations: [...history.present.operations, rotate] });
    expect(history.past).toHaveLength(MAX_HISTORY);
    expect(history.present.operations).toHaveLength(MAX_HISTORY + 10);
    for (let i = 0; i < MAX_HISTORY; i++) history = undoEdit(history);
    expect(history.present.operations).toHaveLength(10);
    expect(undoEdit(history)).toBe(history);
  });
  it('ignores redo/undo at an empty boundary', () => {
    const history = initial(); expect(redoEdit(history)).toBe(history); expect(undoEdit(history)).toBe(history);
  });
});
describe('color and export', () => {
  const adjustment: Extract<ImageOperation, {kind:'adjust'}> = {kind:'adjust',brightness:100,contrast:100,saturation:100,filter:'none'};
  it('preserves pixels and transparency for neutral settings', () => {
    const pixels = new Uint8ClampedArray([12, 100, 247, 73, 255, 0, 128, 0]);
    const before = pixels.slice(); adjustPixels(pixels, adjustment); expect(pixels).toEqual(before);
  });
  it('creates monochrome while preserving alpha', () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 128]);
    adjustPixels(pixels, { ...adjustment, filter: 'mono' }); expect([...pixels]).toEqual([54, 54, 54, 128]);
  });
  it('handles black and contrast midpoint without overflowing channels', () => {
    const dark = new Uint8ClampedArray([255, 90, 140, 255]); adjustPixels(dark, { ...adjustment, brightness: 0 }); expect([...dark]).toEqual([0, 0, 0, 255]);
    const flat = new Uint8ClampedArray([255, 0, 140, 77]); adjustPixels(flat, { ...adjustment, contrast: 0 }); expect([...flat]).toEqual([128, 128, 128, 77]);
    const bright = new Uint8ClampedArray([255, 255, 255, 12]); adjustPixels(bright, { ...adjustment, brightness: 200 }); expect([...bright]).toEqual([255, 255, 255, 12]);
  });
  it.each(['warm', 'cool', 'sepia'] as const)('supports %s without changing alpha', filter => {
    const pixels = new Uint8ClampedArray([100, 100, 100, 72]); adjustPixels(pixels, { ...adjustment, filter }); expect(pixels[3]).toBe(72);
    if (filter === 'cool') expect(pixels[2]).toBeGreaterThan(pixels[0]); else expect(pixels[0]).toBeGreaterThan(pixels[2]);
  });
  it('exports a new portable name without retaining the original extension', () => {
    const date = new Date(2026, 9, 4, 12, 30, 5, 123);
    expect(exportName('旅行.png', 'png', date)).toBe('旅行-edited-20261004-123005-123.png');
    const name = exportName('../invalid:name?.webp', 'jpeg', date);
    expect(name).toMatch(/-edited-20261004-123005-123\.jpg$/); expect(name).not.toMatch(/[<>:"/\\|?*]/);
    expect(exportName('a'.repeat(300) + '.jpg', 'png', date).length).toBeLessThan(150);
  });
});
