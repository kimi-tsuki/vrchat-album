export interface LayoutItem {
  ratio: unknown;
  footerHeight?: number;
}

export interface PhotoPosition {
  left: number;
  top: number;
  width: number;
  mediaHeight: number;
}

export interface LayoutResult {
  positions: PhotoPosition[];
  height: number;
}

export function ratioOf(value: unknown): number {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 4 / 3;
}

function footerOf(value: unknown): number {
  const height = Number(value);
  return Number.isFinite(height) && height >= 0 ? height : 0;
}

/** Place each photo in the shortest column, keeping catalog order unchanged. */
export function masonry(items: readonly LayoutItem[], width: number, gap: number, minWidth: number): LayoutResult {
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const heights: number[] = Array(columns).fill(0);
  const positions = items.map((item): PhotoPosition => {
    const column = heights.indexOf(Math.min(...heights));
    const mediaHeight = columnWidth / ratioOf(item.ratio);
    const position = { left: column * (columnWidth + gap), top: heights[column], width: columnWidth, mediaHeight };
    heights[column] += mediaHeight + footerOf(item.footerHeight) + gap;
    return position;
  });
  return { positions, height: items.length ? Math.max(...heights) - gap : 0 };
}

/** Fit natural image proportions into rows, reserving the tallest caption in each row. */
export function justified(items: readonly LayoutItem[], width: number, gap: number, targetHeight: number): LayoutResult {
  const positions: PhotoPosition[] = [];
  let start = 0;
  let top = 0;
  while (start < items.length) {
    let count = 0;
    let sum = 0;
    do {
      sum += ratioOf(items[start + count].ratio);
      count++;
    } while (start + count < items.length && gap * count < width && sum * targetHeight + gap * (count - 1) < width);

    let fitHeight = (width - gap * (count - 1)) / sum;
    if (count > 1) {
      const previousSum = sum - ratioOf(items[start + count - 1].ratio);
      const previousHeight = (width - gap * (count - 2)) / previousSum;
      if (Math.abs(previousHeight - targetHeight) < Math.abs(fitHeight - targetHeight)) {
        count--;
        sum = previousSum;
        fitHeight = previousHeight;
      }
    }
    const mediaHeight = Math.min(fitHeight, targetHeight * (start + count === items.length ? 1 : 1.5));
    let left = 0;
    let footerHeight = 0;
    for (let index = start; index < start + count; index++) {
      const itemWidth = ratioOf(items[index].ratio) * mediaHeight;
      positions.push({ left, top, width: itemWidth, mediaHeight });
      left += itemWidth + gap;
      footerHeight = Math.max(footerHeight, footerOf(items[index].footerHeight));
    }
    top += mediaHeight + footerHeight + gap;
    start += count;
  }
  return { positions, height: items.length ? top - gap : 0 };
}
