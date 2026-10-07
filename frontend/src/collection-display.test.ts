import { expect, it } from 'vitest';
import { collectionFrames, defaultDisplay, orderCollections } from './collection-display';
import { buildCollections } from './collections';
import type { Photo } from './types';

const photos: Photo[] = Array.from({ length: 10 }, (_, i) => ({ id: String(i), thumb_url: `/thumb/${i}`, original_url: `/original/${i}`, filename: `${i}.png`, month: '2026-10', width: 48, height: 36, copies: 1, date_source: 'filename', session_label: 'Test', favorite: true, date: '2026-10-07', captured_at: `2026-10-07T12:00:${String(i).padStart(2, '0')}`, tags: [], note: '', session_id: 'test', world: '', world_id: '' }));
const cards = buildCollections(photos, '2026-10-07');
const card = cards.find(c => c.id === 'favorites')!;

it('starts at an uploaded or chosen cover, avoids duplicates, and bounds slides', () => {
  const display = { ...defaultDisplay(card.id), slideshow: true, cover_type: 'upload' as const, cover_url: '/cover/local' };
  expect(collectionFrames(card, display, photos, '2026-10-07')).toHaveLength(6);
  expect(collectionFrames(card, display, photos, '2026-10-07')[0]).toBe('/cover/local');
  const chosen = collectionFrames(card, { ...display, cover_type: 'photo', cover_photo: '9' }, photos, '2026-10-07');
  expect(chosen[0]).toBe('/thumb/9');
  expect(new Set(chosen).size).toBe(chosen.length);
});
it('falls back when a photo disappears, handles empty collections, and keeps static covers static', () => {
  const display = { ...defaultDisplay(card.id), cover_type: 'photo' as const, cover_photo: 'gone' };
  expect(collectionFrames(card, display, photos, '2026-10-07')).toEqual([card.covers[0].thumb_url]);
  expect(collectionFrames({ ...card, covers: [] }, display, [], '2026-10-07')).toEqual([]);
  expect(collectionFrames(card, { ...display, cover_photo: '0' }, photos, '2026-10-07')).toEqual(['/thumb/0']);
});
it('puts the most recently pinned collections first without changing the unpinned order', () => {
  const displays = { [cards[1].id]: { ...defaultDisplay(cards[1].id), pinned: true, pinned_order: 1 }, [cards[2].id]: { ...defaultDisplay(cards[2].id), pinned: true, pinned_order: 2 } };
  const sorted = orderCollections(cards, displays);
  expect(sorted.slice(0, 2).map(c => c.id)).toEqual([cards[2].id, cards[1].id]);
  expect(sorted.slice(2)).toEqual(cards.filter(c => c !== cards[1] && c !== cards[2]));
  expect(cards[0]).toBe(card);
});
