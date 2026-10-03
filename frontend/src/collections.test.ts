import { describe, expect, it } from 'vitest';
import { buildCollections, collectionPhotos, dateNumber, localDateKey, memoryPhotos, scopePhotos, shiftDate } from './collections';
import type { Photo } from './types';

function photo(id: string, date = '2026-10-03', extra: Partial<Photo> = {}): Photo {
  return { id, date, month: date.slice(0, 7), captured_at: `${date}T12:00:00`, filename: `synthetic-${id}.png`,
    width: 400, height: 300, world: '合成世界', world_id: 'wrld_test', tags: [], note: '', favorite: false,
    copies: 1, date_source: 'filename', thumb_url: `/thumb/${id}`, original_url: `/original/${id}`,
    session_id: date, session_label: date, ...extra };
}
const ids = (photos: Photo[]) => photos.map(item => item.id);

describe('calendar memories', () => {
  it('uses local calendar dates instead of UTC dates', () => {
    expect(localDateKey(new Date(2026, 9, 3, 0, 5))).toBe('2026-10-03');
  });
  it.each(['2026-02-29', '2025-04-31', '2026-13-01', '2026-1-03', 'broken', '', '0000-01-01'])('rejects invalid date %s', value => {
    expect(dateNumber(value)).toBeNull();
    expect(memoryPhotos([photo('a')], value, 'day')).toEqual([]);
  });
  it('matches only the same calendar day in previous years, excluding the reference year and future years', () => {
    const photos = [photo('past', '2025-10-03'), photo('older', '2023-10-03'), photo('today'),
      photo('future', '2027-10-03'), photo('near', '2025-10-04'), photo('invalid', '2025-02-29')];
    expect(ids(memoryPhotos(photos, '2026-10-03', 'day'))).toEqual(['past', 'older']);
    expect(ids(memoryPhotos(photos, '2026-10-03', 'month'))).toEqual(['past', 'older', 'near']);
    expect(ids(memoryPhotos(photos, '2024-10-03', 'day'))).toEqual(['older']);
  });
  it('keeps leap-day memories exact and supports month browsing in a non-leap year', () => {
    const photos = [photo('leap', '2024-02-29'), photo('before', '2024-02-28'), photo('after', '2024-03-01')];
    expect(ids(memoryPhotos(photos, '2028-02-29', 'day'))).toEqual(['leap']);
    expect(ids(memoryPhotos(photos, '2026-02-28', 'day'))).toEqual(['before']);
    expect(ids(memoryPhotos(photos, '2026-02-28', 'month'))).toEqual(['leap', 'before']);
  });
  it('moves calendar dates across year and leap boundaries without timezone conversion', () => {
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDate('2024-02-29', 1)).toBe('2024-03-01');
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDate('0001-01-01', -1)).toBe('0001-01-01');
    expect(shiftDate('9999-12-31', 1)).toBe('9999-12-31');
  });
});

describe('automatic collection rules', () => {
  it('includes today and 29 previous calendar days in recent photos, excluding future and invalid dates', () => {
    const photos = [photo('now'), photo('first', '2026-09-04'), photo('old', '2026-09-03'), photo('future', '2026-10-04'), photo('bad', '2026-02-29')];
    expect(ids(collectionPhotos(photos, { kind: 'recent' }, '2026-10-03'))).toEqual(['now', 'first']);
    expect(collectionPhotos(photos, { kind: 'recent' }, 'broken')).toEqual([]);
  });
  it('matches a whole tag ignoring case and extra whitespace, rather than matching substrings', () => {
    const photos = [photo('a', undefined, { tags: [' FRIENDS ', 'Friends'] }), photo('b', undefined, { tags: ['friends'] }), photo('c', undefined, { tags: ['friends-of-friends'] })];
    expect(ids(collectionPhotos(photos, { kind: 'tag', value: 'FRIENDS' }, '2026-10-03'))).toEqual(['a', 'b']);
    const collection = buildCollections(photos, '2026-10-03').find(item => item.id === 'tag:friends');
    expect(collection?.count).toBe(2);
  });
  it('keeps worlds with the same ID together despite custom names, and keeps different IDs separate', () => {
    const photos = [photo('a'), photo('b', undefined, { world: '自定义名称' }), photo('c', undefined, { world_id: 'wrld_other' }), photo('unknown', undefined, { world: '', world_id: '' })];
    expect(ids(collectionPhotos(photos, { kind: 'world', value: 'wrld_test' }, '2026-10-03'))).toEqual(['a', 'b']);
    expect(buildCollections(photos, '2026-10-03').filter(item => item.category === '世界')).toHaveLength(2);
  });
  it('recognizes written and unwritten memories without treating whitespace as content', () => {
    const photos = [photo('note', undefined, { note: '记得这一天' }), photo('tag', undefined, { tags: ['朋友'] }), photo('empty', undefined, { tags: [' '], note: '  ' })];
    expect(ids(collectionPhotos(photos, { kind: 'notes' }, '2026-10-03'))).toEqual(['note']);
    expect(ids(collectionPhotos(photos, { kind: 'unwritten' }, '2026-10-03'))).toEqual(['empty']);
  });
  it('builds covers, counts unique photos rather than duplicate files, and uses the latest session across worlds', () => {
    const photos = [photo('a', '2026-10-03', { favorite: true, copies: 5 }), photo('b', '2026-10-03', { world_id: 'wrld_other' }),
      photo('c', '2025-10-03', { favorite: true }), photo('d', '2024-10-03', { favorite: true }), photo('e', '2023-10-03', { favorite: true })];
    const before = JSON.stringify(photos);
    const collections = buildCollections(photos, '2026-10-03');
    expect(collections.find(item => item.id === 'favorites')).toMatchObject({ count: 4, favorites: 4 });
    expect(collections.find(item => item.id === 'favorites')?.covers).toHaveLength(3);
    expect(collections.find(item => item.id === 'latest-session')?.count).toBe(2);
    expect(collections.filter(item => item.category === '年份').map(item => item.rule)).toEqual([
      { kind: 'year', value: '2026' }, { kind: 'year', value: '2025' }, { kind: 'year', value: '2024' }, { kind: 'year', value: '2023' },
    ]);
    for (const collection of collections) expect(collectionPhotos(photos, collection.rule, '2026-10-03')).toHaveLength(collection.count);
    expect(JSON.stringify(photos)).toBe(before);
    expect(buildCollections([], '2026-10-03')).toEqual([]);
  });
  it('leaves an empty selected collection empty instead of falling back to the full album', () => {
    expect(scopePhotos([photo('a')], { view: 'collections', collection: { title: '空合集', description: '', rule: { kind: 'tag', value: 'missing' } }, today: '2026-10-03', memoryDate: '2026-10-03', memoryRange: 'day' })).toEqual([]);
  });
});

import { customMembers, customCards } from './collections';
import type { CustomCollection } from './types';
it('intersects custom rules and preserves manual ordering and covers', () => {
  const a = photo('a', '2026-10-03', { tags:['Friends','landscape'], favorite:true, date:'2026-10-03' });
  const b = photo('b', '2026-10-03', { tags:['friends'], favorite:true, date:'2026-10-03' });
  const c: CustomCollection = {id:'c',revision:1,name:'c',mode:'rules',ids:['b','a'],cover:'a',rules:{from:'2026-01-01',to:'2026-12-31',world:'',tags:['friends','LANDSCAPE'],favorites:true}};
  expect(customMembers([a,b],c).map(p=>p.id)).toEqual(['a']);
  c.mode='manual';
  expect(customMembers([a,b],c).map(p=>p.id)).toEqual(['b','a']);
  expect(customCards([a,b],[c])[0].covers[0].id).toBe('a');
  expect(customMembers([],c)).toEqual([]);
});
