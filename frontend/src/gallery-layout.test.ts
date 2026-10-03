import { describe, expect, it } from 'vitest';
import { justified, masonry, ratioOf, type LayoutItem, type LayoutResult } from './gallery-layout';

const epsilon = 1e-7;
function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon * Math.max(1, Math.abs(expected)));
}

function verifyGeometry(result: LayoutResult, items: readonly LayoutItem[], width: number) {
  expect(result.positions).toHaveLength(items.length);
  expect(Number.isFinite(result.height)).toBe(true);
  expect(result.height).toBeGreaterThanOrEqual(0);
  const boxes = result.positions.map((position, index) => {
    Object.values(position).forEach((value) => expect(Number.isFinite(value)).toBe(true));
    expect(position.left).toBeGreaterThanOrEqual(-epsilon);
    expect(position.top).toBeGreaterThanOrEqual(-epsilon);
    expect(position.width).toBeGreaterThan(0);
    expect(position.mediaHeight).toBeGreaterThan(0);
    expect(position.left + position.width).toBeLessThanOrEqual(width + epsilon);
    close(position.width / position.mediaHeight, ratioOf(items[index].ratio));
    if (index) expect(position.top + epsilon).toBeGreaterThanOrEqual(result.positions[index - 1].top);
    const rawFooter = Number(items[index].footerHeight);
    const footer = Number.isFinite(rawFooter) && rawFooter >= 0 ? rawFooter : 0;
    const bottom = position.top + position.mediaHeight + footer;
    expect(bottom).toBeLessThanOrEqual(result.height + epsilon);
    return { ...position, right: position.left + position.width, bottom };
  });
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const horizontal = Math.min(boxes[a].right, boxes[b].right) - Math.max(boxes[a].left, boxes[b].left);
      const vertical = Math.min(boxes[a].bottom, boxes[b].bottom) - Math.max(boxes[a].top, boxes[b].top);
      expect(horizontal <= epsilon || vertical <= epsilon, `Photo and caption ${a} and ${b} must not overlap`).toBe(true);
    }
  }
}

describe('natural image layouts', () => {
  it('falls back to 4:3 when photo proportions are absent or unusable', () => {
    for (const value of [undefined, null, '', 0, -1, NaN, Infinity, 'unknown']) close(ratioOf(value), 4 / 3);
    close(ratioOf('1.5'), 1.5);
    close(ratioOf(1 / 40), 1 / 40);
  });

  it('reserves no height for an empty photo group', () => {
    for (const result of [masonry([], 320, 19, 216), justified([], 320, 19, 220)]) expect(result).toEqual({ positions: [], height: 0 });
  });

  const ratios = [4 / 3, 2 / 3, 1, 16 / 9, 3 / 4, 40, 1 / 40, undefined, 0, NaN];
  const mixed = Array.from({ length: 67 }, (_, index): LayoutItem => ({ ratio: ratios[index % ratios.length], footerHeight: [24, 39, 58][index % 3] }));
  for (const width of [284, 320, 375, 760, 1160, 1900]) {
    it(`fits mixed image proportions and captions into a ${width}px gallery`, () => {
      const before = structuredClone(mixed);
      verifyGeometry(masonry(mixed, width, 19, 216), mixed, width);
      verifyGeometry(justified(mixed, width, 19, 220), mixed, width);
      expect(mixed).toEqual(before);
    });
  }

  it('uses caption heights when choosing a masonry column', () => {
    const items = [{ ratio: 1, footerHeight: 140 }, { ratio: 1, footerHeight: 15 }, { ratio: 1, footerHeight: 30 }];
    const result = masonry(items, 500, 20, 216);
    verifyGeometry(result, items, 500);
    close(result.positions[2].left, result.positions[1].left);
    expect(result.positions[2].top).toBeGreaterThanOrEqual(result.positions[1].mediaHeight + items[1].footerHeight + 20);
  });

  it('keeps a short final row at the target height', () => {
    const items = [{ ratio: 0.75, footerHeight: 35 }, { ratio: 1.25, footerHeight: 40 }];
    const result = justified(items, 1160, 19, 220);
    verifyGeometry(result, items, 1160);
    result.positions.forEach((position) => close(position.mediaHeight, 220));
    const last = result.positions.at(-1)!;
    expect(last.left + last.width).toBeLessThan(1160);
  });

  it('shrinks a panoramic image to fit the available row width', () => {
    const items = [{ ratio: 40, footerHeight: 35 }];
    const result = justified(items, 320, 19, 220);
    verifyGeometry(result, items, 320);
    close(result.positions[0].width, 320);
    expect(result.positions[0].mediaHeight).toBeLessThan(220);
  });

  it('limits row gaps even for extremely narrow photos', () => {
    const items = Array.from({ length: 36 }, (): LayoutItem => ({ ratio: 0.0001, footerHeight: 35 }));
    for (const width of [320, 375, 1160]) verifyGeometry(justified(items, width, 19, 220), items, width);
  });
});
