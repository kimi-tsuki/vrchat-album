import type { AlbumCatalog, AnnotationDraft, AnnotationFields, GroupMode, Photo, PhotoFilters } from './types';

export const EMPTY_FILTERS: PhotoFilters = { month: '', world: '', favorites: false, search: '' };
export const EMPTY_FIELDS: AnnotationFields = { world: '', tagsText: '', note: '' };

export function monthText(month: string): string {
  const parts = month.split('-');
  return parts.length === 2 ? `${Number(parts[0])} 年 ${Number(parts[1])} 月` : '日期未知';
}

export function dateText(date: string): string {
  const parts = date.split('-');
  return parts.length === 3 ? `${Number(parts[0])} 年 ${Number(parts[1])} 月 ${Number(parts[2])} 日` : '拍摄日期未知';
}

export const timeText = (photo: Photo): string => photo.captured_at.slice(11, 16) || '—';
export const worldKey = (photo: Photo): string => photo.world_id || photo.world || '__unknown__';
export const worldName = (photo: Photo): string => photo.world || (photo.world_id ? '未命名世界' : '未记录世界');
export const worldRank = (photo: Photo): number => photo.world ? 0 : photo.world_id ? 1 : 2;
export const groupKey = (photo: Photo, mode: GroupMode): string => mode === 'world' ? worldKey(photo) : mode === 'date' ? photo.date : photo.session_id;

export function tagsFrom(value: string): string[] {
  return [...new Set(value.split(/[,，;；\n]/).map(tag => tag.trim()).filter(Boolean))];
}

export function fieldsFrom(photo: Photo): AnnotationFields {
  return { world: photo.world || '', tagsText: photo.tags.join('，'), note: photo.note || '' };
}

export function sortPhotos(photos: readonly Photo[]): Photo[] {
  return [...photos].sort((a, b) => b.captured_at.localeCompare(a.captured_at) || b.id.localeCompare(a.id));
}

export function filterPhotos(photos: readonly Photo[], filters: PhotoFilters): Photo[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return photos.filter(photo =>
    (!filters.month || photo.month === filters.month) &&
    (!filters.world || worldKey(photo) === filters.world) &&
    (!filters.favorites || photo.favorite) &&
    (!query || [photo.world, photo.world_id, photo.note, photo.filename, photo.date, photo.session_label, ...photo.tags]
      .join(' ').toLocaleLowerCase().includes(query)));
}

export function orderPhotos(photos: readonly Photo[], mode: GroupMode): Photo[] {
  const ordered = sortPhotos(photos);
  if (mode !== 'world') return ordered;
  const worlds = new Map<string, Photo[]>();
  for (const photo of ordered) {
    const key = worldKey(photo);
    const group = worlds.get(key);
    if (group) group.push(photo);
    else worlds.set(key, [photo]);
  }
  return [...worlds.values()].sort((a, b) => worldRank(a[0]) - worldRank(b[0]) || b[0].captured_at.localeCompare(a[0].captured_at)).flat();
}

export interface PhotoGroup {
  key: string;
  title: string;
  meta: string;
  count: number;
  photos: Photo[];
}

export function groupPhotos(photos: readonly Photo[], mode: GroupMode, limit = Infinity, alreadyOrdered = false): PhotoGroup[] {
  const ordered = alreadyOrdered ? photos : orderPhotos(photos, mode);
  const counts = new Map<string, number>();
  const groups = new Map<string, Photo[]>();
  for (const photo of ordered) {
    const key = groupKey(photo, mode);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const photo of ordered.slice(0, limit)) {
    const key = groupKey(photo, mode);
    const group = groups.get(key);
    if (group) group.push(photo);
    else groups.set(key, [photo]);
  }
  return [...groups].map(([key, members]) => {
    const first = members[0];
    const worlds = [...new Set(members.map(photo => photo.world).filter(Boolean))];
    return {
      key,
      title: mode === 'world' ? worldName(first) : mode === 'date' ? dateText(first.date) : first.session_label || dateText(first.date),
      meta: mode === 'world' ? `最近照片 ${first.date.replaceAll('-', ' / ')}` : mode === 'session' ? worlds.slice(0, 2).join(' · ') || '世界名称待填写' : '',
      count: counts.get(key) || 0,
      photos: members,
    };
  });
}

export function sidebarModel(photos: readonly Photo[]) {
  const months = new Map<string, number>();
  const worlds = new Map<string, { key: string; name: string; count: number; rank: number; latest: string }>();
  let favorites = 0;
  const ordered = sortPhotos(photos);
  for (const photo of ordered) {
    months.set(photo.month, (months.get(photo.month) || 0) + 1);
    const key = worldKey(photo);
    const world = worlds.get(key);
    if (world) world.count++;
    else worlds.set(key, { key, name: worldName(photo), count: 1, rank: worldRank(photo), latest: photo.captured_at });
    if (photo.favorite) favorites++;
  }
  return {
    months: [...months].sort(([a], [b]) => b.localeCompare(a)).map(([key, count]) => ({ key, name: monthText(key), count })),
    worlds: [...worlds.values()].sort((a, b) => a.rank - b.rank || b.latest.localeCompare(a.latest)),
    favorites,
    total: photos.length,
    worldCount: [...worlds.keys()].filter(key => key !== '__unknown__').length,
    latestDate: ordered[0]?.date || '',
  };
}

export function catalogError(catalog: AlbumCatalog): string {
  if (catalog.error) return catalog.error;
  if (catalog.scan_errors.length) {
    const firstMessage = catalog.scan_errors[0]?.message;
    return `${catalog.scan_errors.length} 个文件暂时无法读取，其余照片已整理。${firstMessage ? ` ${firstMessage}` : ''}`;
  }
  return '';
}

export function createDraft(
  catalog: AlbumCatalog | null,
  photos: readonly Photo[],
  ids: readonly string[],
  fields: AnnotationFields,
  mode: 'batch' | 'photo',
  now = new Date(),
): AnnotationDraft {
  return {
    format: 'vrchat-album-annotation-draft',
    format_version: 1,
    exported_at: now.toISOString(),
    source: catalog?.source || '',
    source_revision: catalog?.source_revision ?? null,
    mode,
    photos: ids.map(id => ({ id, filename: photos.find(photo => photo.id === id)?.filename || '' })),
    fields: { world: fields.world, tags_text: fields.tagsText, note: fields.note },
  };
}
