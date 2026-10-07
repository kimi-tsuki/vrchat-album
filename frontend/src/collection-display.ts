import { collectionPhotos, type SmartCollection } from './collections';
import type { CollectionDisplay, Photo } from './types';

export const defaultDisplay = (id: string): CollectionDisplay => ({
  id, revision: 0, pinned: false, pinned_order: 0, slideshow: false, interval: 8,
  position: 50, cover_type: 'auto', cover_photo: '',
});

/** Keep the chosen cover first and bound the number of images on a card. */
export function collectionFrames(collection: SmartCollection, display: CollectionDisplay, photos: readonly Photo[], today: string): string[] {
  const cover = display.cover_type === 'upload' ? display.cover_url : display.cover_type === 'photo'
    ? photos.find(p => p.id === display.cover_photo)?.thumb_url : collection.covers[0]?.thumb_url;
  if (!display.slideshow) return cover || collection.covers[0]?.thumb_url ? [cover || collection.covers[0].thumb_url] : [];
  const members = display.slideshow ? collectionPhotos(photos, collection.rule, today).slice(0, 12) : [];
  return [...new Set([cover, ...members.map(p => p.thumb_url), collection.covers[0]?.thumb_url].filter((url): url is string => !!url))].slice(0, 6);
}

export function orderCollections(collections: SmartCollection[], displays: Record<string, CollectionDisplay> = {}): SmartCollection[] {
  return [...collections].sort((a, b) => Number(!!displays[b.id]?.pinned) - Number(!!displays[a.id]?.pinned) ||
    (displays[a.id]?.pinned && displays[b.id]?.pinned ? displays[b.id].pinned_order - displays[a.id].pinned_order : 0));
}
