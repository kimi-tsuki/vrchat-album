import { Button, Checkbox, Chip } from '@heroui/react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { justified, masonry, ratioOf, type LayoutItem } from '../gallery-layout';
import { groupPhotos, timeText, worldName } from '../model';
import type { Layout } from '../preferences';
import type { GroupMode, Photo } from '../types';
import { Icon } from './Icon';

export interface GalleryProps {
  photos: Photo[];
  allPhotos?: Photo[];
  limit: number;
  group: GroupMode;
  layout: Layout;
  selected: ReadonlySet<string>;
  selectMode: boolean;
  onOpen: (photo: Photo) => void;
  onSelect: (photo: Photo) => void;
  onFavorite: (photo: Photo) => void;
  onBatch: (ids: string[], title: string) => void;
  onMore: () => void;
}

function arrangeGrid(grid: HTMLDivElement, layout: Layout) {
  const cards = Array.from(grid.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  grid.classList.remove('layout-ready');
  grid.style.height = '';
  for (const card of cards) {
    card.classList.remove('photo-narrow', 'photo-tiny');
    card.style.width = '';
    card.style.left = '';
    card.style.top = '';
    const media = card.querySelector<HTMLElement>('.photo-media');
    if (media) media.style.height = '';
  }
  if (layout === 'grid' || !cards.length || !grid.clientWidth) return;

  const style = getComputedStyle(grid);
  const width = grid.clientWidth;
  const gap = parseFloat(style.getPropertyValue('--photo-gap')) || 18;
  const minWidth = parseFloat(style.getPropertyValue('--photo-min')) || 216;
  const targetHeight = parseFloat(style.getPropertyValue('--photo-target')) || 220;
  const items: LayoutItem[] = cards.map((card) => ({ ratio: ratioOf(card.dataset.ratio), footerHeight: 0 }));
  const arrange = () => layout === 'masonry' ? masonry(items, width, gap, minWidth) : justified(items, width, gap, targetHeight);

  let result = arrange();
  grid.classList.add('layout-ready');
  result.positions.forEach((position, index) => {
    const card = cards[index];
    card.style.width = `${position.width}px`;
    card.classList.toggle('photo-narrow', position.width < 90);
    card.classList.toggle('photo-tiny', position.width < 40);
    const media = card.querySelector<HTMLElement>('.photo-media');
    if (media) media.style.height = `${position.mediaHeight}px`;
  });
  // Measure captions only after every image has its final width; long labels can wrap.
  cards.forEach((card, index) => {
    const media = card.querySelector<HTMLElement>('.photo-media');
    items[index].footerHeight = Math.max(0, card.getBoundingClientRect().height - (media?.getBoundingClientRect().height ?? 0));
  });
  result = arrange();
  result.positions.forEach((position, index) => {
    cards[index].style.left = `${position.left}px`;
    cards[index].style.top = `${position.top}px`;
  });
  grid.style.height = `${result.height}px`;
}

function PhotoGrid({ photos, layout, selected, selectMode, onOpen, onSelect, onFavorite }: Pick<GalleryProps,
  'photos' | 'layout' | 'selected' | 'selectMode' | 'onOpen' | 'onSelect' | 'onFavorite'>) {
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let frame = 0;
    let active = true;
    let lastWidth = grid.clientWidth;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (active) arrangeGrid(grid, layout); });
    };
    arrangeGrid(grid, layout);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (grid.clientWidth !== lastWidth) { lastWidth = grid.clientWidth; schedule(); }
    });
    observer?.observe(grid);
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(() => { if (active) schedule(); });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [photos, layout, selectMode, selected]);

  return <div ref={gridRef} className="photo-grid" data-layout={layout}>
    {photos.map((photo) => {
      const isSelected = selected.has(photo.id);
      const name = worldName(photo);
      return <article key={photo.id} className={`photo${isSelected ? ' selected' : ''}`} data-id={photo.id} data-ratio={ratioOf(photo.width / photo.height)}>
        <button type="button" className="photo-media" aria-label={`${selectMode ? (isSelected ? '取消选择' : '选择') : '查看'} ${photo.world || photo.filename}`}
          onClick={() => selectMode ? onSelect(photo) : onOpen(photo)}>
          <img src={photo.thumb_url} alt={photo.world || photo.filename} loading="lazy" decoding="async" />
          {photo.copies > 1 && <Chip size="sm" className="photo-copies" variant="soft">{photo.copies} 个副本</Chip>}
        </button>
        <Button isIconOnly size="sm" variant="tertiary" className={`photo-star${photo.favorite ? ' favorite' : ''}`}
          aria-label={photo.favorite ? '取消星标' : '添加星标'} aria-pressed={photo.favorite} onPress={() => onFavorite(photo)}>
          <Icon name="star" />
        </Button>
        {selectMode && <Checkbox className="photo-select" isSelected={isSelected} aria-label={`${isSelected ? '取消选择' : '选择'}这张照片`}
          onChange={() => onSelect(photo)}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control></Checkbox.Content>
        </Checkbox>}
        <div className="photo-caption">
          <div className="photo-bottom"><span className="photo-name" title={name}>{name}</span><time className="photo-time" dateTime={photo.captured_at}>{timeText(photo)}</time></div>
          <div className="photo-tags">
            {photo.tags.length ? photo.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>) : <span>{photo.note ? photo.note.slice(0, 38) : '点击照片，留下这段回忆'}</span>}
          </div>
        </div>
      </article>;
    })}
  </div>;
}

export function Gallery({ photos, allPhotos = photos, limit, group, layout, selected, selectMode, onOpen, onSelect, onFavorite, onBatch, onMore }: GalleryProps) {
  const groups = useMemo(() => groupPhotos(photos, group, limit), [photos, group, limit]);
  const remaining = Math.max(0, photos.length - limit);
  return <div id="gallery" className={`gallery${selectMode ? ' selection-enabled' : ''}`}>
    {groups.map((section) => <section className="group" key={section.key}>
      <div className="group-head">
        <h2 className="group-title">{section.title}</h2>
        <Chip size="sm" variant="soft" className="group-count">{section.count} 张</Chip>
        {section.meta && <span className="group-meta">{section.meta}</span>}
        <span className="group-line" />
        {group === 'session' && <Button size="sm" variant="ghost" className="group-edit" onPress={() => onBatch(allPhotos.filter((photo) => photo.session_id === section.key).map((photo) => photo.id), '填写这一场')}> <Icon name="edit" />填写这一场</Button>}
      </div>
      <PhotoGrid photos={section.photos} layout={layout} selected={selected} selectMode={selectMode} onOpen={onOpen} onSelect={onSelect} onFavorite={onFavorite} />
    </section>)}
    {remaining > 0 && <div className="load-more"><Button variant="secondary" onPress={onMore}>继续回看 · 还有 {remaining.toLocaleString()} 张</Button></div>}
  </div>;
}
