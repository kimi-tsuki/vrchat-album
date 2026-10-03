import { sortPhotos, worldKey, worldName } from './model';
import type { AlbumState, CollectionRule, CollectionSelection, GroupMode, MemoryRange, Photo, CustomCollection } from './types';

const DAY = 86_400_000;
export function localDateKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function dateNumber(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : null;
}
export function shiftDate(date: string, days: number): string {
  const value = dateNumber(date);
  if (value === null) return date;
  const next = new Date(value + days * DAY).toISOString().slice(0, 10);
  return dateNumber(next) === null ? date : next;
}
export function memoryPhotos(photos: readonly Photo[], date: string, range: MemoryRange): Photo[] {
  if (dateNumber(date) === null) return [];
  const year = Number(date.slice(0, 4));
  const anniversary = range === 'day' ? date.slice(5) : date.slice(5, 7);
  return photos.filter(photo => dateNumber(photo.date) !== null && Number(photo.date.slice(0, 4)) < year &&
    (range === 'day' ? photo.date.slice(5) : photo.date.slice(5, 7)) === anniversary);
}
const normalizedTag = (tag: string) => tag.trim().toLocaleLowerCase();
export function collectionPhotos(photos: readonly Photo[], rule: CollectionRule, today: string): Photo[] {
  if (rule.kind === 'custom') return customMembers(photos, rule.value);
  const end = dateNumber(today);
  return photos.filter(photo => {
    switch (rule.kind) {
      case 'favorites': return photo.favorite;
      case 'recent': {
        const value = dateNumber(photo.date);
        return end !== null && value !== null && value <= end && value >= end - 29 * DAY;
      }
      case 'notes': return !!photo.note.trim();
      case 'unwritten': return !photo.note.trim() && !photo.tags.some(tag => tag.trim());
      case 'session': return photo.session_id === rule.value;
      case 'world': return worldKey(photo) === rule.value;
      case 'tag': return photo.tags.some(tag => normalizedTag(tag) === normalizedTag(rule.value));
      case 'year': return dateNumber(photo.date) !== null && photo.date.slice(0, 4) === rule.value;
    }
  });
}
export type DiscoveryScope = Pick<AlbumState, 'view' | 'collection' | 'today' | 'memoryDate' | 'memoryRange'>;
export function scopePhotos(photos: readonly Photo[], scope: DiscoveryScope): Photo[] {
  if (scope.view === 'memories') return memoryPhotos(photos, scope.memoryDate, scope.memoryRange);
  if (scope.view === 'collections' && scope.collection) return collectionPhotos(photos, scope.collection.rule, scope.today);
  return [...photos];
}
export const scopeGroup = (scope: Pick<AlbumState, 'view' | 'group'>): GroupMode => scope.view === 'memories' ? 'date' : scope.group;
export interface SmartCollection extends CollectionSelection {
  id: string;
  category: '推荐' | '世界' | '标签' | '年份' | '自定义';
  count: number;
  covers: Photo[];
  favorites: number;
  sessions: number;
}
export function buildCollections(photos: readonly Photo[], today: string): SmartCollection[] {
  const ordered = sortPhotos(photos);
  if (!ordered.length) return [];
  const result: SmartCollection[] = [];
  const add = (id: string, title: string, description: string, category: SmartCollection['category'], rule: CollectionRule, members: Photo[]) => {
    if (!members.length) return;
    result.push({ id, title, description, category, rule, count: members.length, covers: members.slice(0, 3),
      favorites: members.filter(photo => photo.favorite).length,
      sessions: new Set(members.map(photo => photo.session_id).filter(Boolean)).size });
  };
  for (const [kind, title, description] of [
    ['favorites', '珍藏瞬间', '所有加过星标的照片'], ['recent', '最近 30 天', '近一个月留下的漫游瞬间'],
    ['notes', '写过的回忆', '已经留下文字备注的照片'], ['unwritten', '待写回忆', '还没有标签或备注的照片'],
  ] as const) add(kind, title, description, '推荐', { kind }, collectionPhotos(ordered, { kind }, today));
  const latest = ordered.find(photo => photo.session_id);
  if (latest) add('latest-session', '最近一场漫游', latest.session_label || latest.date, '推荐',
    { kind: 'session', value: latest.session_id }, ordered.filter(photo => photo.session_id === latest.session_id));

  const worlds = new Map<string, Photo[]>();
  const tags = new Map<string, { label: string; photos: Photo[] }>();
  const years = new Map<string, Photo[]>();
  for (const photo of ordered) {
    const key = worldKey(photo);
    if (key !== '__unknown__') {
      const members = worlds.get(key) || [];
      members.push(photo); worlds.set(key, members);
    }
    for (const tag of new Set(photo.tags.map(normalizedTag).filter(Boolean))) {
      const bucket = tags.get(tag) || { label: photo.tags.find(value => normalizedTag(value) === tag)!.trim(), photos: [] };
      bucket.photos.push(photo); tags.set(tag, bucket);
    }
    if (dateNumber(photo.date) !== null) {
      const year = photo.date.slice(0, 4);
      const members = years.get(year) || [];
      members.push(photo); years.set(year, members);
    }
  }
  for (const [key, members] of [...worlds].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const visits = new Set(members.map(photo => photo.session_id).filter(Boolean)).size;
    add(`world:${key}`, worldName(members[0]), `${visits} 场漫游 · 最近 ${members[0].date}`, '世界', { kind: 'world', value: key }, members);
  }
  for (const [key, bucket] of [...tags].sort((a, b) => b[1].photos.length - a[1].photos.length || a[0].localeCompare(b[0]))) {
    add(`tag:${key}`, `#${bucket.label}`, '带有这个标签的照片，自动汇成一册', '标签', { kind: 'tag', value: key }, bucket.photos);
  }
  for (const [year, members] of [...years].sort(([a], [b]) => b.localeCompare(a))) {
    add(`year:${year}`, `${Number(year)} 年的足迹`, `${new Set(members.map(worldKey).filter(key => key !== '__unknown__')).size} 个世界 · 一年的漫游记录`,
      '年份', { kind: 'year', value: year }, members);
  }
  return result;
}

export function customMembers(photos: readonly Photo[], c: CustomCollection): Photo[] {
  const byId = new Map(photos.map(p => [p.id, p]));
  if (c.mode === 'manual') return c.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  return sortPhotos(photos.filter(p => (!c.rules.from || p.date >= c.rules.from) && (!c.rules.to || p.date <= c.rules.to) &&
    (!c.rules.world || worldKey(p) === c.rules.world) && (!c.rules.favorites || p.favorite) &&
    c.rules.tags.every(tag => p.tags.some(t => normalizedTag(t) === normalizedTag(tag)))));
}
export function customCards(photos: readonly Photo[], collections: CustomCollection[]): SmartCollection[] {
  return collections.map(c => {
    const members = customMembers(photos, c); const cover = members.find(p => p.id === c.cover);
    return { id: c.id, category: '自定义', title: c.name, description: c.mode === 'manual' ? '手选照片 · 自定顺序' : '组合规则 · 自动收集', rule: { kind: 'custom', value: c },
      count: members.length, covers: (cover ? [cover, ...members.filter(p => p.id !== cover.id)] : members).slice(0, 3), favorites: members.filter(p => p.favorite).length, sessions: new Set(members.map(p => p.session_id)).size };
  });
}
