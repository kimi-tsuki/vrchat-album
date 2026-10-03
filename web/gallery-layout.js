/* Geometry only: keep the existing DOM order, filters and selection intact. */
(function () {
  'use strict';
  const ratioOf = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 4 / 3;
  const footerOf = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

  function masonry(items, width, gap, minWidth) {
    const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
    const columnWidth = (width - gap * (columns - 1)) / columns;
    const heights = Array(columns).fill(0);
    const positions = items.map(item => {
      const column = heights.indexOf(Math.min(...heights));
      const mediaHeight = columnWidth / ratioOf(item.ratio);
      const position = {left: column * (columnWidth + gap), top: heights[column], width: columnWidth, mediaHeight};
      heights[column] += mediaHeight + footerOf(item.footerHeight) + gap;
      return position;
    });
    return {positions, height: items.length ? Math.max(...heights) - gap : 0};
  }

  function justified(items, width, gap, targetHeight) {
    const positions = [];
    let start = 0, top = 0;
    while (start < items.length) {
      let count = 0, sum = 0;
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
      // A short final row stays at the target height instead of enlarging a lone image.
      const mediaHeight = Math.min(fitHeight, targetHeight * (start + count === items.length ? 1 : 1.5));
      let left = 0, footerHeight = 0;
      for (let index = start; index < start + count; index++) {
        const itemWidth = ratioOf(items[index].ratio) * mediaHeight;
        positions.push({left, top, width: itemWidth, mediaHeight});
        left += itemWidth + gap;
        footerHeight = Math.max(footerHeight, footerOf(items[index].footerHeight));
      }
      top += mediaHeight + footerHeight + gap;
      start += count;
    }
    return {positions, height: items.length ? top - gap : 0};
  }

  function apply(grid, layout) {
    const cards = [...grid.children];
    grid.classList.remove('layout-ready');
    grid.style.height = '';
    for (const card of cards) {
      card.classList.remove('photo-narrow', 'photo-tiny');
      for (const property of ['width', 'left', 'top']) card.style[property] = '';
      card.querySelector('.photo-media').style.height = '';
    }
    if (layout === 'grid' || !cards.length || !grid.clientWidth) return;

    const style = getComputedStyle(grid);
    const width = grid.clientWidth;
    const gap = parseFloat(style.getPropertyValue('--photo-gap')) || 19;
    const minWidth = parseFloat(style.getPropertyValue('--photo-min')) || 216;
    const targetHeight = parseFloat(style.getPropertyValue('--row-height')) || 220;
    const items = cards.map(card => ({ratio: ratioOf(card.dataset.ratio), footerHeight: 0}));
    const arrange = () => layout === 'masonry' ? masonry(items, width, gap, minWidth) : justified(items, width, gap, targetHeight);
    let result = arrange();
    grid.classList.add('layout-ready');
    // Reserve image space from metadata, then measure captions at their actual width.
    result.positions.forEach((position, index) => {
      const card = cards[index], media = card.querySelector('.photo-media');
      card.style.width = position.width + 'px';
      card.classList.toggle('photo-narrow', position.width < 90);
      card.classList.toggle('photo-tiny', position.width < 40);
      media.style.height = position.mediaHeight + 'px';
    });
    cards.forEach((card, index) => {
      items[index].footerHeight = card.getBoundingClientRect().height - card.querySelector('.photo-media').getBoundingClientRect().height;
    });
    result = arrange();
    result.positions.forEach((position, index) => {
      const card = cards[index];
      card.style.left = position.left + 'px';
      card.style.top = position.top + 'px';
    });
    grid.style.height = result.height + 'px';
  }

  globalThis.albumLayouts = Object.freeze({ratioOf, masonry, justified, apply});
})();
