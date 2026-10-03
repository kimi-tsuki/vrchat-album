import { describe, expect, it } from 'vitest';
import { createDraft, EMPTY_FILTERS, filterPhotos, groupPhotos, orderPhotos, sidebarModel, tagsFrom, worldKey, worldName } from './model';
import type { AlbumCatalog, Photo } from './types';

function syntheticPhoto(id: string, overrides: Partial<Photo> = {}): Photo {
  return {
    id, filename: `VRChat_2026-10-03_12-00-${id}.png`, captured_at: '2026-10-03T12:00:00',
    date: '2026-10-03', month: '2026-10', width: 400, height: 300,
    world: '合成世界', world_id: 'wrld_synthetic', tags: [], note: '', favorite: false,
    copies: 1, date_source: 'filename', thumb_url: `/api/photo/${id}/thumb`,
    original_url: `/api/photo/${id}/original`, session_id: '2026-10-03T12:00:00',
    session_label: '2026-10-03 12:00', ...overrides,
  };
}

describe('album filtering and grouping', () => {
  it('searches annotations, filenames, world IDs, dates and session labels without changing originals', () => {
    const photos = [syntheticPhoto('a', { tags: ['夕阳'], note: '测试回忆' }), syntheticPhoto('b', { world_id: 'wrld_SECOND' })];
    for (const query of ['夕阳', '测试回忆', '12-00-a', '2026-10-03 12:00']) {
      expect(filterPhotos(photos, { ...EMPTY_FILTERS, search: query })[0].id).toBe('a');
    }
    expect(filterPhotos(photos, { ...EMPTY_FILTERS, search: 'WRLD_second' }).map(photo => photo.id)).toEqual(['b']);
    expect(photos[0].tags).toEqual(['夕阳']);
  });

  it('combines favorite, month and world filters', () => {
    const photos = [syntheticPhoto('a', { favorite: true }), syntheticPhoto('b'), syntheticPhoto('c', { favorite: true, month: '2026-09' })];
    expect(filterPhotos(photos, { search: '', favorites: true, month: '2026-10', world: 'wrld_synthetic' }).map(photo => photo.id)).toEqual(['a']);
  });

  it('keeps named worlds before unknown worlds and viewer order identical to gallery order', () => {
    const photos = [
      syntheticPhoto('unknown', { world: '', world_id: '', captured_at: '2026-10-03T16:00:00' }),
      syntheticPhoto('named-old', { captured_at: '2026-10-03T10:00:00' }),
      syntheticPhoto('unnamed', { world: '', world_id: 'wrld_unnamed', captured_at: '2026-10-03T15:00:00' }),
      syntheticPhoto('named-new', { world: '另一个合成世界', world_id: 'wrld_other', captured_at: '2026-10-03T12:00:00' }),
    ];
    const ordered = orderPhotos(photos, 'world');
    expect(ordered.map(photo => photo.id)).toEqual(['named-new', 'named-old', 'unnamed', 'unknown']);
    expect(groupPhotos(photos, 'world').flatMap(group => group.photos).map(photo => photo.id)).toEqual(ordered.map(photo => photo.id));
    expect(worldKey(photos[0])).toBe('__unknown__');
    expect(worldName(photos[0])).toBe('未记录世界');
  });

  it('paginates photos while retaining full group counts', () => {
    const photos = Array.from({ length: 192 }, (_, index) => syntheticPhoto(String(index).padStart(3, '0')));
    const groups = groupPhotos(photos, 'world', 180);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(192);
    expect(groups[0].photos).toHaveLength(180);
    expect(groupPhotos(photos, 'world', 360)[0].photos).toHaveLength(192);
  });

  it('groups sessions independently of world names and date groups in descending capture order', () => {
    const photos = [syntheticPhoto('a'), syntheticPhoto('b', { world: '另一个世界', world_id: 'wrld_other' }), syntheticPhoto('c', {
      date: '2026-10-02', captured_at: '2026-10-02T12:00:00', session_id: '2026-10-02T12:00:00', session_label: '2026-10-02 12:00',
    })];
    expect(groupPhotos(photos, 'session').map(group => group.count)).toEqual([2, 1]);
    expect(groupPhotos(photos, 'date').map(group => group.key)).toEqual(['2026-10-03', '2026-10-02']);
    expect(groupPhotos(photos, 'session')[0].meta).toContain('合成世界');
  });

  it('counts sidebar worlds by stable world ID and excludes the truly unknown bucket', () => {
    const photos = [syntheticPhoto('a', { favorite: true }), syntheticPhoto('b'), syntheticPhoto('c', { world: '', world_id: '' })];
    const sidebar = sidebarModel(photos);
    expect(sidebar.total).toBe(3);
    expect(sidebar.favorites).toBe(1);
    expect(sidebar.worldCount).toBe(1);
    expect(sidebar.worlds[0].count).toBe(2);
    expect(sidebar.months[0]).toMatchObject({ key: '2026-10', count: 3 });
  });

  it('accepts Chinese and English separators and removes repeated tags', () => {
    expect(tagsFrom(' 日落，朋友; 日落； 测试\n朋友, ')).toEqual(['日落', '朋友', '测试']);
  });

  it('exports raw unsaved annotation text with the source revision and photo identity', () => {
    const photo = syntheticPhoto('a');
    const draft = createDraft({ source: 'synthetic/photos', source_revision: 7 } as AlbumCatalog, [photo], ['a'], {
      world: '  未保存世界  ', tagsText: '标签，标签', note: '草稿\n内容',
    }, 'photo', new Date('2026-10-03T12:00:00Z'));
    expect(draft.source_revision).toBe(7);
    expect(draft.fields.world).toBe('  未保存世界  ');
    expect(draft.fields.tags_text).toBe('标签，标签');
    expect(draft.photos).toEqual([{ id: 'a', filename: photo.filename }]);
    expect(draft.exported_at).toBe('2026-10-03T12:00:00.000Z');
  });
});
