import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlbumApi } from './api';
import { AlbumController } from './useAlbum';
import type { AlbumCatalog, AlbumSettings, Photo } from './types';

function photo(id: string, overrides: Partial<Photo> = {}): Photo {
  return {
    id, filename: `synthetic-${id}.png`, captured_at: '2026-10-03T12:00:00', date: '2026-10-03', month: '2026-10',
    width: 400, height: 300, world: '合成世界', world_id: 'wrld_synthetic', tags: [], note: '', favorite: false,
    copies: 1, date_source: 'filename', thumb_url: `/thumb/${id}`, original_url: `/original/${id}`,
    session_id: 'synthetic-session', session_label: '2026-10-03 12:00', ...overrides,
  };
}

function catalog(overrides: Partial<AlbumCatalog> = {}): AlbumCatalog {
  return {
    app: 'vrchat-album', version: 'test', source: 'synthetic/photos', data: 'synthetic/data',
    configured: true, source_revision: 1, ready: true, scanning: false, scan_phase: 'idle', error: null,
    scan_errors: [], last_scan: '2026-10-03T12:00:00', processed: 2, discovered: 2, revision: 1,
    total_files: 2, duplicates: 0, photos: [photo('a'), photo('b')], ...overrides,
  };
}

function mockApi(initial = catalog()) {
  const settings: AlbumSettings = {
    configured: true, source: initial.source, source_exists: true, default_source: 'synthetic/default',
    picker_available: false, source_revision: initial.source_revision,
  };
  return {
    catalog: vi.fn<AlbumApi['catalog']>().mockResolvedValue(initial),
    status: vi.fn<AlbumApi['status']>().mockResolvedValue(initial),
    settings: vi.fn<AlbumApi['settings']>().mockResolvedValue(settings),
    setSource: vi.fn<AlbumApi['setSource']>().mockResolvedValue({ ok: true, source: 'synthetic/new', source_revision: 2 }),
    pickFolder: vi.fn<AlbumApi['pickFolder']>().mockResolvedValue({ path: null, cancelled: true }),
    edit: vi.fn<AlbumApi['edit']>().mockResolvedValue({ ok: true }),
    scan: vi.fn<AlbumApi['scan']>().mockResolvedValue({ ok: true }),
    shutdown: vi.fn<AlbumApi['shutdown']>().mockResolvedValue({ ok: true }),
  };
}

const controllers: AlbumController[] = [];
function controller(api: AlbumApi = mockApi()) {
  const instance = new AlbumController({}, api);
  controllers.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of controllers.splice(0)) instance.dispose();
  vi.restoreAllMocks();
});

describe('typed album controller', () => {
  it('selects only collection members across pagination and clears the selection when navigating to another scope', async () => {
    const photos = Array.from({ length: 192 }, (_, index) => photo(`p${String(index).padStart(3, '0')}`, { tags: ['collection'] }));
    const api = mockApi(catalog({ photos: [...photos, photo('outside')] }));
    const album = controller(api);
    await album.refresh();
    album.openCollection({ title: '测试合集', description: '', rule: { kind: 'tag', value: 'collection' } });
    album.toggleSelectMode(); album.selectFiltered();
    expect(album.getSnapshot().selected.size).toBe(192);
    expect(album.getSnapshot().selected.has('outside')).toBe(false);
    album.setView('memories');
    expect(album.getSnapshot().selected.size).toBe(0);
    expect(album.getSnapshot().selectMode).toBe(false);
    expect(album.getSnapshot().collection).toBeNull();
  });

  it('keeps the original collection viewer order after saving a tag that removes the current photo from the collection', async () => {
    const api = mockApi(catalog({ photos: [photo('a', { tags: ['friends'] }), photo('b', { tags: ['friends'] }), photo('outside')] }));
    const album = controller(api);
    await album.refresh();
    album.openCollection({ title: '朋友', description: '', rule: { kind: 'tag', value: 'friends' } });
    album.openViewer('b');
    expect(album.getSnapshot().viewer?.order).toEqual(['b', 'a']);
    album.updateViewer({ tagsText: 'another' });
    await album.moveViewer(1);
    expect(album.getSnapshot().viewer?.id).toBe('a');
    expect(album.getSnapshot().viewer?.order).toEqual(['b', 'a']);
    expect(album.getSnapshot().photos.find(item => item.id === 'b')?.tags).toEqual(['another']);
  });

  it('uses only historical photos in the memory viewer and random picks can reach collection photos past the first page', async () => {
    const api = mockApi(catalog({ photos: [photo('past', { date: '2025-10-03', captured_at: '2025-10-03T12:00:00' }), photo('now')] }));
    const album = controller(api);
    await album.refresh(); album.setView('memories'); album.setMemoryDate('2026-10-03');
    album.openViewer('past');
    expect(album.getSnapshot().viewer?.order).toEqual(['past']);
    await album.closeViewer();
    const many = Array.from({ length: 192 }, (_, index) => photo(`p${String(index).padStart(3, '0')}`, { tags: ['group'] }));
    api.catalog.mockResolvedValue(catalog({ photos: [...many, photo('outside')] }));
    await album.refresh();
    album.openCollection({ title: '随机测试', description: '', rule: { kind: 'tag', value: 'group' } });
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    album.randomPhoto();
    expect(album.getSnapshot().viewer?.id).toBe('p000');
    expect(album.getSnapshot().viewer?.order).toHaveLength(192);
  });

  it('protects dirty annotations and batch drafts when changing collection or memory scope', async () => {
    const album = controller();
    await album.refresh(); album.openViewer('a'); album.updateViewer({ note: 'keep me' });
    expect(album.setView('memories')).toBe(false);
    album.openCollection({ title: '其他合集', description: '', rule: { kind: 'favorites' } });
    expect(album.getSnapshot().viewer?.fields.note).toBe('keep me');
    expect(album.getSnapshot().view).toBe('photos');
    await album.closeViewer(); album.openBatch(['a']);
    const before = album.getSnapshot().memoryDate;
    album.setMemoryDate('2024-01-01');
    expect(album.getSnapshot().memoryDate).toBe(before);
    expect(album.getSnapshot().batch?.ids).toEqual(['a']);
  });

  it('follows the local day while preserving a manually chosen anniversary and pauses rollover during editing', async () => {
    const album = new AlbumController({ today: '2026-12-31' }, mockApi());
    controllers.push(album);
    album.setView('memories'); album.syncToday('2027-01-01');
    expect(album.getSnapshot().memoryDate).toBe('2027-01-01');
    album.setMemoryDate('2026-02-28'); album.syncToday('2027-01-02');
    expect(album.getSnapshot().memoryDate).toBe('2026-02-28');
    await album.refresh(); album.setView('photos'); album.openViewer('a');
    album.syncToday('2027-01-03');
    expect(album.getSnapshot().today).toBe('2027-01-02');
    await album.closeViewer(); album.syncToday('2027-01-03');
    expect(album.getSnapshot().today).toBe('2027-01-03');
  });

  it('resets discovery scopes after changing the photo source instead of retaining a stale collection', async () => {
    const api = mockApi(); const album = controller(api);
    await album.loadSettings(); await album.refresh();
    album.openCollection({ title: '旧目录', description: '', rule: { kind: 'world', value: 'wrld_synthetic' } });
    api.catalog.mockResolvedValue(catalog({ source_revision: 2, source: 'synthetic/other', photos: [photo('new')] }));
    await album.refresh();
    expect(album.getSnapshot().view).toBe('photos');
    expect(album.getSnapshot().collection).toBeNull();
    expect(album.getSnapshot().photos.map(item => item.id)).toEqual(['new']);
  });
  it('preserves dirty viewer annotations when a background refresh updates the photo', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ note: '未保存的回忆' });
    api.catalog.mockResolvedValue(catalog({ revision: 2, photos: [photo('a', { note: '后台的新内容' }), photo('b')] }));
    await album.refresh();
    expect(album.getSnapshot().viewer?.fields.note).toBe('未保存的回忆');
    expect(album.getSnapshot().viewer?.dirty).toBe(true);
    expect(album.getSnapshot().photos.find(item => item.id === 'a')?.note).toBe('后台的新内容');
  });

  it('preserves an identifiable viewer draft after the edited photo disappears and requires explicit discard', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ note: '照片移走后仍要保留的回忆' });
    expect(album.discardViewerDraft()).toBe(false);
    api.catalog.mockResolvedValue(catalog({ revision: 2, photos: [photo('b')] }));
    await album.refresh();
    expect(album.getSnapshot().viewer?.photo).toMatchObject({ id: 'a', filename: 'synthetic-a.png' });
    expect(album.getSnapshot().viewer?.fields.note).toBe('照片移走后仍要保留的回忆');
    expect(album.annotationDraft()).toMatchObject({
      photos: [{ id: 'a', filename: 'synthetic-a.png' }], fields: { note: '照片移走后仍要保留的回忆' },
    });
    expect(api.edit).not.toHaveBeenCalled();
    expect(album.discardViewerDraft()).toBe(true);
    expect(album.getSnapshot().viewer).toBeNull();
  });

  it('does not allow the missing-photo discard action to bypass a source-conflict draft', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ note: '受保护的草稿' });
    api.catalog.mockResolvedValue(catalog({ revision: 2, photos: [photo('b')] }));
    await album.refresh();
    api.status.mockResolvedValue(catalog({ source_revision: 2, photos: [photo('new')] }));
    await album.pollStatus();
    expect(album.getSnapshot().pendingSourceChange).toBe(true);
    expect(album.discardViewerDraft()).toBe(false);
    expect(album.getSnapshot().viewer?.fields.note).toBe('受保护的草稿');
  });

  it('blocks writes and closure after another window switches the source, retaining exportable viewer draft', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ world: '未保存的世界', tagsText: '测试，保留', note: '草稿内容' });
    api.status.mockResolvedValue(catalog({ source: 'synthetic/other', source_revision: 2 }));
    expect(await album.saveViewer()).toBe(false);
    expect(album.getSnapshot().pendingSourceChange).toBe(true);
    expect(await album.closeViewer()).toBe(false);
    expect(api.edit).not.toHaveBeenCalled();
    expect(album.annotationDraft()).toMatchObject({ source: 'synthetic/photos', source_revision: 1, fields: { note: '草稿内容' } });
    api.catalog.mockResolvedValue(catalog({ source: 'synthetic/other', source_revision: 2, photos: [photo('new')] }));
    await album.discardDraftAndRefresh();
    expect(album.getSnapshot().pendingSourceChange).toBe(false);
    expect(album.getSnapshot().viewer).toBeNull();
    expect(album.getSnapshot().photos.map(item => item.id)).toEqual(['new']);
  });

  it('retains a batch draft when a poll observes an external directory change', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openBatch(['a', 'b']);
    album.updateBatch({ note: '批量草稿' });
    api.status.mockResolvedValue(catalog({ source_revision: 3 }));
    await album.pollStatus();
    expect(album.getSnapshot().pendingSourceChange).toBe(true);
    expect(album.closeBatch()).toBe(false);
    expect(await album.saveBatch()).toBe(false);
    expect(album.annotationDraft()).toMatchObject({ mode: 'batch', fields: { note: '批量草稿' } });
    expect(api.edit).not.toHaveBeenCalled();
  });

  it('resets filters, pagination, selection and a clean viewer after an external directory change', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.setSearch('合成');
    album.setMonth('2026-10');
    album.loadMore();
    album.openViewer('a');
    album.toggleSelectMode();
    album.toggleSelected('a');
    api.catalog.mockResolvedValue(catalog({ source_revision: 2, photos: [photo('new')] }));
    await album.refresh();
    const state = album.getSnapshot();
    expect(state.filters).toEqual({ month: '', world: '', favorites: false, search: '' });
    expect(state.limit).toBe(180);
    expect(state.selected.size).toBe(0);
    expect(state.selectMode).toBe(false);
    expect(state.viewer).toBeNull();
  });

  it('saves dirty annotations before moving through the same ordered photos shown by the gallery', async () => {
    const api = mockApi(catalog({ photos: [photo('a', { world_id: 'wrld_a', world: '先看', captured_at: '2026-10-03T13:00:00' }), photo('b')] }));
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ world: '新世界', tagsText: '朋友，朋友;测试', note: '  合成回忆  ' });
    await album.moveViewer(1);
    expect(api.edit).toHaveBeenCalledWith(['a'], { world: '新世界', tags: ['朋友', '测试'], note: '合成回忆' });
    expect(album.getSnapshot().viewer?.id).toBe('b');
    expect(album.getSnapshot().photos.find(item => item.id === 'a')?.note).toBe('合成回忆');
  });

  it('does not close a viewer if more text is typed while a save is in flight', async () => {
    const api = mockApi();
    let finish!: (value: { ok: boolean }) => void;
    api.edit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ note: '第一段' });
    const closing = album.closeViewer();
    await Promise.resolve();
    await Promise.resolve();
    album.updateViewer({ note: '第一段加上后续内容' });
    finish({ ok: true });
    expect(await closing).toBe(false);
    expect(album.getSnapshot().viewer?.fields.note).toBe('第一段加上后续内容');
    expect(album.getSnapshot().viewer?.dirty).toBe(true);
  });

  it('leaves blank batch fields unchanged and does not submit an empty batch', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openBatch(['a', 'b']);
    expect(await album.saveBatch()).toBe(false);
    expect(api.edit).not.toHaveBeenCalled();
    album.updateBatch({ tagsText: ' 新标签，新标签 ' });
    expect(await album.saveBatch()).toBe(true);
    expect(api.edit).toHaveBeenCalledWith(['a', 'b'], { tags: ['新标签'] });
    expect(album.getSnapshot().photos[0].world).toBe('合成世界');
    expect(album.getSnapshot().batch).toBeNull();
  });

  it('updates favorites without replacing unsaved viewer fields', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    album.openViewer('a');
    album.updateViewer({ note: '不要丢掉的草稿' });
    await album.toggleFavorite('a');
    expect(api.edit).toHaveBeenCalledWith(['a'], { favorite: true });
    expect(album.getSnapshot().photos.find(item => item.id === 'a')?.favorite).toBe(true);
    expect(album.getSnapshot().viewer?.fields.note).toBe('不要丢掉的草稿');
  });

  it('selects all filtered photos, including photos beyond the first page, and keeps selections on search changes', async () => {
    const api = mockApi(catalog({ photos: Array.from({ length: 192 }, (_, index) => photo(`p${index}`)) }));
    const album = controller(api);
    await album.refresh();
    album.toggleSelectMode();
    album.selectFiltered();
    expect(album.getSnapshot().selected.size).toBe(192);
    album.setSearch('不会匹配');
    expect(album.getSnapshot().selected.size).toBe(192);
    album.toggleSelectMode();
    expect(album.getSnapshot().selected.size).toBe(0);
  });

  it('survives React StrictMode effect teardown and immediate restart without waiting for a later poll', async () => {
    const api = mockApi();
    let firstCatalog!: (value: AlbumCatalog) => void;
    let firstSettings!: (value: AlbumSettings) => void;
    api.catalog.mockImplementationOnce(() => new Promise(resolve => { firstCatalog = resolve; }));
    api.settings.mockImplementationOnce(() => new Promise(resolve => { firstSettings = resolve; }));
    const album = controller(api);
    album.start();
    album.dispose();
    album.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(album.getSnapshot().catalog?.ready).toBe(true);
    expect(album.getSnapshot().settings?.configured).toBe(true);
    firstCatalog(catalog({ source: 'synthetic/stale', source_revision: 99 }));
    firstSettings({ configured: false, source: 'synthetic/stale', source_exists: false, default_source: '', picker_available: false, source_revision: 99 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(album.getSnapshot().catalog?.source).toBe('synthetic/photos');
    expect(album.getSnapshot().settings?.source).toBe('synthetic/photos');
  });

  it('shows connection failure and restores the catalog on a later successful retry', async () => {
    const api = mockApi();
    api.catalog.mockRejectedValueOnce(new Error('offline'));
    const album = controller(api);
    await album.refresh();
    expect(album.getSnapshot().disconnected).toBe(true);
    await album.retry();
    expect(album.getSnapshot().disconnected).toBe(false);
    expect(album.getSnapshot().error).toBe('');
  });

  it('ignores an old in-flight catalog after a confirmed source change', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.loadSettings(true);
    let completeOld!: (value: AlbumCatalog) => void;
    api.catalog.mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve; }));
    const oldRefresh = album.refresh();
    album.setSourceDraft('synthetic/new');
    expect(await album.applySource()).toBe(true);
    completeOld(catalog({ photos: [photo('stale')] }));
    await oldRefresh;
    expect(album.getSnapshot().catalog?.source).toBe('synthetic/new');
    expect(album.getSnapshot().photos).toEqual([]);
    api.catalog.mockResolvedValue(catalog({ source: 'synthetic/new', source_revision: 2, photos: [photo('current')] }));
    await album.refresh();
    expect(album.getSnapshot().photos.map(item => item.id)).toEqual(['current']);
  });

  it('does not mistake an old status response for another source change after an external refresh', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    let completeOld!: (value: AlbumCatalog) => void;
    api.status.mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve; }));
    const oldPoll = album.pollStatus();
    api.catalog.mockResolvedValue(catalog({ source: 'synthetic/external', source_revision: 2, photos: [photo('current')] }));
    await album.refresh();
    album.openViewer('current');
    album.updateViewer({ note: '当前目录的新草稿' });
    completeOld(catalog());
    await oldPoll;
    expect(album.getSnapshot().pendingSourceChange).toBe(false);
    expect(album.getSnapshot().catalog?.source).toBe('synthetic/external');
    expect(album.getSnapshot().viewer?.fields.note).toBe('当前目录的新草稿');
  });

  it('stops polling and fetching after an explicit successful shutdown', async () => {
    const api = mockApi();
    const album = controller(api);
    await album.refresh();
    expect(await album.shutdown()).toBe(true);
    await album.refresh();
    await album.pollStatus();
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(api.status).not.toHaveBeenCalled();
    expect(album.getSnapshot().stopped).toBe(true);
  });
});

it('shows the first page without allowing incomplete whole-library selection',async()=>{
  const api=mockApi();let complete!:()=>void;const gate=new Promise<void>(resolve=>{complete=resolve;});
  api.catalog.mockImplementationOnce(async onPage=>{onPage?.(catalog({photos:[photo('a')],index_complete:false,total_photos:2}));await gate;return catalog({index_complete:true,total_photos:2});});
  const album=controller(api);const pending=album.refresh();
  expect(album.getSnapshot().photos.length).toBe(1);album.toggleSelectMode();album.selectFiltered();
  expect(album.getSnapshot().selectMode).toBe(false);expect(album.getSnapshot().selected.size).toBe(0);
  expect(album.setView('collections')).toBe(false);complete();await pending;album.toggleSelectMode();album.selectFiltered();expect(album.getSnapshot().selected.size).toBe(2);
});
