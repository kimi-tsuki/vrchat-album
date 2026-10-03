import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { albumApi, type AlbumApi } from './api';
import { buildCollections, dateNumber, localDateKey, scopeGroup, scopePhotos } from './collections';
import {
  catalogError, createDraft, EMPTY_FIELDS, EMPTY_FILTERS, fieldsFrom,
  filterPhotos, groupPhotos, orderPhotos, sidebarModel, sortPhotos, tagsFrom,
} from './model';
import type {
  AlbumCatalog, AlbumState, AnnotationChanges, AnnotationFields,
  BrowseMode, CollectionSelection, GroupMode, LibraryView, MemoryRange,
} from './types';

const SOURCE_CONFLICT = '另一个窗口更换了照片文件夹，这份草稿无法保存到当前相册。内容仍保留在这里；可先复制或导出，再明确放弃草稿并打开当前相册。';
const CONNECTION_ERROR = '暂时无法连接相册后台。请检查启动窗口是否还在运行。';
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export interface AlbumOptions {
  initialGroup?: GroupMode;
  initialBrowse?: BrowseMode;
  today?: string;
}

function initialState(options: AlbumOptions): AlbumState {
  const today = options.today && dateNumber(options.today) !== null ? options.today : localDateKey();
  return {
    catalog: null, settings: null, photos: [], filters: { ...EMPTY_FILTERS },
    group: options.initialGroup || 'world', browse: options.initialBrowse || 'worlds',
    view: 'photos', collection: null, today, memoryDate: today, memoryRange: 'day',
    limit: 180, selectMode: false, selected: new Set(), viewer: null, batch: null,
    sourceOpen: false, sourceDraft: '', sourceMessage: '', sourceError: false,
    sourceApplying: false, pickerPending: false, pendingSourceChange: false, draftText: '',
    loading: false, settingsLoading: false, disconnected: false, stopped: false,
    error: '', dismissedError: '', toast: '',
  };
}

/** External store keeps event handlers and in-flight requests on the same current snapshot. */
export class AlbumController {
  private state: AlbumState;
  private readonly listeners = new Set<() => void>();
  private sourceEpoch = 0;
  private lifecycle = 0;
  private alive = true;
  private statusLoading = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AlbumOptions = {}, private readonly api: AlbumApi = albumApi) {
    this.state = initialState(options);
  }

  getSnapshot = (): AlbumState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<AlbumState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private notify(message: string): void {
    clearTimeout(this.toastTimer);
    this.update({ toast: message });
    this.toastTimer = setTimeout(() => this.update({ toast: '' }), 3500);
  }

  private showError(message: string): void {
    this.update({ error: message === this.state.dismissedError ? '' : message });
  }

  private resetView(): void {
    this.update({
      photos: [], filters: { ...EMPTY_FILTERS }, limit: 180,
      view: 'photos', collection: null,
      selectMode: false, selected: new Set(), viewer: null, batch: null, draftText: '',
    });
  }

  private hasDraft(): boolean {
    return !!this.state.viewer?.dirty || !!this.state.batch;
  }

  private protectDraft(sourceRevision: number): boolean {
    if (this.state.catalog && sourceRevision !== this.state.catalog.source_revision && this.hasDraft()) {
      this.update({
        pendingSourceChange: true,
        disconnected: false,
        viewer: this.state.viewer ? { ...this.state.viewer, message: SOURCE_CONFLICT } : null,
        batch: this.state.batch ? { ...this.state.batch, error: SOURCE_CONFLICT } : null,
      });
      return true;
    }
    return this.state.pendingSourceChange;
  }

  private canChangeSource(): boolean {
    if (this.state.pendingSourceChange) {
      this.notify('先保留或明确放弃当前草稿，再更换照片文件夹。');
      return false;
    }
    if (this.state.viewer?.dirty) {
      this.update({ viewer: { ...this.state.viewer, message: '请先保存这段回忆，再更换照片文件夹；也可以继续编辑。' } });
      return false;
    }
    if (this.state.batch) {
      this.update({ batch: { ...this.state.batch, error: '请先保存这次整理，或返回相册后再更换照片文件夹。' } });
      return false;
    }
    return true;
  }

  private async annotationSourceCurrent(): Promise<boolean> {
    if (this.state.pendingSourceChange || !this.state.catalog) return false;
    const sourceRevision = this.state.catalog.source_revision;
    const status = await this.api.status();
    if (status.source_revision !== sourceRevision) {
      if (!this.protectDraft(status.source_revision)) {
        await this.refresh();
        this.notify('照片文件夹已更换，相册已更新，请重新选择照片。');
      }
      return false;
    }
    return !this.state.pendingSourceChange && this.state.catalog?.source_revision === sourceRevision;
  }

  private async recoverDraftConflict(): Promise<boolean> {
    try {
      const status = await this.api.status();
      return this.protectDraft(status.source_revision);
    } catch {
      return false;
    }
  }

  private patchPhotos(ids: readonly string[], changes: AnnotationChanges): void {
    const selected = new Set(ids);
    const photos = this.state.photos.map(photo => selected.has(photo.id) ? { ...photo, ...changes } : photo);
    const current = this.state.viewer;
    const photo = current && photos.find(item => item.id === current.id);
    this.update({
      photos,
      catalog: this.state.catalog ? { ...this.state.catalog, photos } : null,
      viewer: current && photo && !current.dirty ? { ...current, fields: fieldsFrom(photo) } : current,
    });
  }

  start = (): void => {
    this.alive = true;
    const lifecycle = ++this.lifecycle;
    this.statusLoading = false;
    this.update({ loading: false, settingsLoading: false });
    void Promise.all([this.loadSettings(true), this.refresh()]).then(() => {
      if (this.alive && lifecycle === this.lifecycle) this.schedulePoll();
    });
  };

  dispose = (): void => {
    this.alive = false;
    this.lifecycle++;
    clearTimeout(this.pollTimer);
    clearTimeout(this.toastTimer);
  };

  private schedulePoll(delay?: number): void {
    clearTimeout(this.pollTimer);
    if (!this.alive || this.state.stopped) return;
    this.pollTimer = setTimeout(() => void this.pollStatus(), delay ?? (this.state.catalog?.scanning ? 1000 : 20000));
  }

  pollStatus = async (): Promise<void> => {
    if (!this.alive || this.state.stopped) return;
    if (this.statusLoading || this.state.sourceApplying) {
      this.schedulePoll(1000);
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.schedulePoll(20000);
      return;
    }
    this.statusLoading = true;
    const epoch = this.sourceEpoch;
    const lifecycle = this.lifecycle;
    try {
      const status = await this.api.status();
      if (epoch !== this.sourceEpoch || lifecycle !== this.lifecycle || !this.alive) return;
      if (this.protectDraft(status.source_revision)) return;
      const catalog = this.state.catalog;
      if (!catalog || status.revision !== catalog.revision || status.source_revision !== catalog.source_revision ||
        status.configured !== catalog.configured || status.ready !== catalog.ready) {
        await this.refresh();
      } else {
        const next = { ...catalog, ...status };
        this.update({ catalog: next, disconnected: false });
        this.showError(catalogError(next));
      }
      if (!this.state.settings) await this.loadSettings();
    } catch {
      if (epoch === this.sourceEpoch && lifecycle === this.lifecycle && this.alive) {
        this.update({ disconnected: true });
        this.showError(CONNECTION_ERROR);
      }
    } finally {
      if (lifecycle === this.lifecycle) {
        this.statusLoading = false;
        this.schedulePoll();
      }
    }
  };

  refresh = async (_force = false): Promise<void> => {
    if (this.state.loading || this.state.stopped) return;
    this.update({ loading: true });
    const epoch = this.sourceEpoch;
    const lifecycle = this.lifecycle;
    try {
      const catalog = await this.api.catalog();
      if (epoch !== this.sourceEpoch || lifecycle !== this.lifecycle || !this.alive) return;
      if (this.protectDraft(catalog.source_revision)) return;
      const changed = this.state.catalog && catalog.source_revision !== this.state.catalog.source_revision;
      if (changed) {
        this.sourceEpoch++;
        this.resetView();
      }
      const photos = sortPhotos(catalog.photos);
      const ids = new Set(photos.map(photo => photo.id));
      const viewer = this.state.viewer;
      const viewingPhoto = viewer && photos.find(photo => photo.id === viewer.id);
      this.update({
        catalog: { ...catalog, photos }, photos,
        selected: new Set([...this.state.selected].filter(id => ids.has(id))),
        disconnected: false, pendingSourceChange: false,
        settings: this.state.settings ? {
          ...this.state.settings, configured: catalog.configured, source: catalog.source, source_revision: catalog.source_revision,
        } : null,
        viewer: viewer?.dirty ? viewer : viewer && viewingPhoto ? { ...viewer, fields: fieldsFrom(viewingPhoto) } : null,
      });
      this.showError(catalogError(catalog));
    } catch {
      if (epoch === this.sourceEpoch && lifecycle === this.lifecycle && this.alive) {
        this.update({ disconnected: true });
        this.showError(CONNECTION_ERROR);
      }
    } finally {
      if (lifecycle === this.lifecycle) this.update({ loading: false });
    }
  };

  loadSettings = async (resetDraft = false): Promise<void> => {
    if (this.state.settingsLoading || this.state.stopped) return;
    this.update({ settingsLoading: true });
    const lifecycle = this.lifecycle;
    const epoch = this.sourceEpoch;
    try {
      const settings = await this.api.settings();
      if (lifecycle !== this.lifecycle || epoch !== this.sourceEpoch || !this.alive) return;
      const message = !settings.configured && !settings.picker_available
        ? '这台电脑暂时无法打开文件夹选择窗口，请手动填写完整路径。'
        : !settings.configured && !settings.source_exists
          ? '默认照片文件夹还不存在。可以选择实际存放照片的文件夹，也可以手动填写路径。' : '';
      this.update({
        settings,
        sourceDraft: resetDraft || !this.state.sourceDraft ? settings.source || settings.default_source : this.state.sourceDraft,
        sourceMessage: message, sourceError: false,
      });
    } catch (error) {
      if (lifecycle === this.lifecycle && this.alive) this.showError(errorMessage(error));
    } finally {
      if (lifecycle === this.lifecycle) this.update({ settingsLoading: false });
    }
  };

  retry = async (): Promise<void> => {
    await Promise.all([this.loadSettings(true), this.refresh(true)]);
    this.schedulePoll();
  };

  setSearch = (search: string): void => this.setFilters({ search });
  setMonth = (month: string): void => { if (this.setView('photos')) this.setFilters({ month, world: '' }); };
  setWorld = (world: string): void => { if (this.setView('photos')) this.setFilters({ world, month: '' }); };
  setFavorites = (favorites: boolean): void => { if (this.setView('photos')) this.setFilters({ favorites, world: '', month: '' }); };
  private canNavigate(): boolean {
    if (this.state.pendingSourceChange || this.state.viewer?.dirty || this.state.viewer?.saving || this.state.batch) {
      this.notify('先保存或关闭当前整理窗口，再切换浏览范围。');
      return false;
    }
    return true;
  }
  setView = (view: LibraryView): boolean => {
    if (!this.canNavigate()) return false;
    if (view === this.state.view && !(view === 'collections' && this.state.collection)) return true;
    this.update({ view, collection: null, filters: { ...EMPTY_FILTERS }, limit: 180,
      selectMode: false, selected: new Set(), viewer: null });
    return true;
  };
  openCollection = (collection: CollectionSelection): void => {
    if (!this.canNavigate()) return;
    this.update({ view: 'collections', collection: { rule: { ...collection.rule }, title: collection.title, description: collection.description },
      filters: { ...EMPTY_FILTERS }, limit: 180, selectMode: false, selected: new Set(), viewer: null });
  };
  setMemoryDate = (memoryDate: string): void => {
    if (dateNumber(memoryDate) === null || !this.canNavigate()) return;
    this.update({ memoryDate, limit: 180, selected: new Set(), selectMode: false });
  };
  setMemoryRange = (memoryRange: MemoryRange): void => {
    if (!this.canNavigate()) return;
    this.update({ memoryRange, limit: 180, selected: new Set(), selectMode: false });
  };
  syncToday = (today = localDateKey()): void => {
    if (today === this.state.today || dateNumber(today) === null || this.state.viewer || this.state.batch) return;
    const followsToday = this.state.memoryDate === this.state.today;
    this.update({ today, memoryDate: followsToday ? today : this.state.memoryDate,
      ...(followsToday && this.state.view === 'memories' ? { limit: 180, selected: new Set(), selectMode: false } : {}) });
  };
  private visiblePhotos() {
    return orderPhotos(filterPhotos(scopePhotos(this.state.photos, this.state), this.state.filters), scopeGroup(this.state));
  }
  clearFilters = (): void => this.update({ filters: { ...EMPTY_FILTERS }, limit: 180 });
  private setFilters(patch: Partial<AlbumState['filters']>): void {
    this.update({ filters: { ...this.state.filters, ...patch }, limit: 180 });
  }
  setGroup = (group: GroupMode): void => this.update({ group });
  setBrowse = (browse: BrowseMode): void => this.update({ browse });
  loadMore = (): void => this.update({ limit: this.state.limit + 180 });

  toggleSelectMode = (): void => this.update({
    selectMode: !this.state.selectMode,
    selected: this.state.selectMode ? new Set() : this.state.selected,
  });
  toggleSelected = (id: string): void => {
    const selected = new Set(this.state.selected);
    if (selected.has(id)) selected.delete(id);
    else if (this.state.photos.some(photo => photo.id === id)) selected.add(id);
    this.update({ selected });
  };
  selectFiltered = (): void => this.update({ selected: new Set([
    ...this.state.selected, ...this.visiblePhotos().map(photo => photo.id),
  ]) });
  clearSelection = (): void => this.update({ selected: new Set() });

  openViewer = (id: string, order?: readonly string[]): void => {
    if (this.state.selectMode) { this.toggleSelected(id); return; }
    if (this.state.pendingSourceChange) return;
    const photo = this.state.photos.find(item => item.id === id);
    if (!photo) return;
    const sequence = order || this.visiblePhotos().map(item => item.id);
    if (!sequence.includes(id)) return;
    this.update({ viewer: { id, order: sequence, photo, fields: fieldsFrom(photo), dirty: false, saving: false, message: '' }, draftText: '' });
  };
  randomPhoto = (): void => {
    if (this.state.selectMode || !this.canNavigate()) return;
    const photos = this.visiblePhotos();
    if (!photos.length) return;
    this.openViewer(photos[Math.floor(Math.random() * photos.length)].id);
  };
  updateViewer = (patch: Partial<AnnotationFields>): void => {
    const viewer = this.state.viewer;
    if (!viewer) return;
    this.update({ viewer: {
      ...viewer, fields: { ...viewer.fields, ...patch }, dirty: true,
      message: this.state.pendingSourceChange ? SOURCE_CONFLICT : '尚未保存',
    } });
  };
  closeViewer = async (): Promise<boolean> => {
    if (this.state.pendingSourceChange && this.state.viewer?.dirty) return false;
    if (this.state.viewer?.dirty && !await this.saveViewer(false)) return false;
    this.update({ viewer: null, draftText: '' });
    return true;
  };
  discardViewerDraft = (): boolean => {
    const { viewer, photos, pendingSourceChange } = this.state;
    if (!viewer || viewer.saving || pendingSourceChange || photos.some(photo => photo.id === viewer.id)) return false;
    this.update({ viewer: null, draftText: '' });
    this.notify('已放弃这份草稿并返回相册');
    return true;
  };
  saveViewer = async (showMessage = true): Promise<boolean> => {
    const viewer = this.state.viewer;
    if (!viewer) return true;
    if (this.state.pendingSourceChange || viewer.saving) return false;
    const epoch = this.sourceEpoch;
    const changes = { world: viewer.fields.world.trim(), tags: tagsFrom(viewer.fields.tagsText), note: viewer.fields.note.trim() };
    this.update({ viewer: { ...viewer, saving: true, message: '保存中…' } });
    try {
      if (!await this.annotationSourceCurrent()) return false;
      await this.api.edit([viewer.id], changes);
      if (epoch !== this.sourceEpoch) return false;
      this.patchPhotos([viewer.id], changes);
      const current = this.state.viewer;
      if (current?.id === viewer.id) {
        const unchanged = current.fields === viewer.fields;
        this.update({ viewer: { ...current, dirty: !unchanged, message: unchanged ? showMessage ? '已保存' : '' : '尚未保存' } });
        return unchanged;
      }
      return true;
    } catch (error) {
      if (!await this.recoverDraftConflict() && this.state.viewer?.id === viewer.id) {
        this.update({ viewer: { ...this.state.viewer, message: errorMessage(error) } });
      }
      return false;
    } finally {
      if (this.state.viewer?.id === viewer.id) this.update({ viewer: { ...this.state.viewer, saving: false } });
    }
  };
  moveViewer = async (direction: number): Promise<void> => {
    if (this.state.pendingSourceChange) return;
    if (this.state.viewer?.dirty && !await this.saveViewer(false)) return;
    const order = this.state.viewer?.order || [];
    const current = this.state.viewer?.id;
    const ids = new Set(this.state.photos.map(photo => photo.id));
    const available = order.filter(id => ids.has(id));
    const index = available.indexOf(current || '');
    const next = index >= 0 ? available[index + direction] : undefined;
    if (next) this.openViewer(next, order);
  };

  toggleFavorite = async (id: string): Promise<void> => {
    const photo = this.state.photos.find(item => item.id === id);
    if (!photo || this.state.pendingSourceChange || this.state.stopped) return;
    const epoch = this.sourceEpoch;
    try {
      if (!await this.annotationSourceCurrent()) return;
      await this.api.edit([id], { favorite: !photo.favorite });
      if (epoch !== this.sourceEpoch) return;
      this.patchPhotos([id], { favorite: !photo.favorite });
      this.notify(photo.favorite ? '已取消星标' : '已收进我的星标');
    } catch (error) {
      if (!await this.recoverDraftConflict()) this.notify(errorMessage(error));
    }
  };

  openBatch = (ids: string[], label = '选中的照片', world = ''): void => {
    if (!ids.length || this.state.pendingSourceChange) return;
    const valid = new Set(this.state.photos.map(photo => photo.id));
    const selected = [...new Set(ids)].filter(id => valid.has(id));
    if (!selected.length) return;
    this.update({ batch: {
      ids: selected, label, fields: { ...EMPTY_FIELDS, world }, saving: false, error: '',
    }, draftText: '' });
  };
  openSession = async (sessionId: string): Promise<void> => {
    if (this.state.viewer?.dirty && !await this.saveViewer(false)) return;
    const photos = this.state.photos.filter(photo => photo.session_id === sessionId);
    const worlds = [...new Set(photos.map(photo => photo.world).filter(Boolean))];
    this.openBatch(photos.map(photo => photo.id), '这一场', worlds.length === 1 ? worlds[0] : '');
  };
  updateBatch = (patch: Partial<AnnotationFields>): void => {
    const batch = this.state.batch;
    if (batch) this.update({ batch: {
      ...batch, fields: { ...batch.fields, ...patch }, error: this.state.pendingSourceChange ? SOURCE_CONFLICT : '',
    } });
  };
  closeBatch = (): boolean => {
    if (this.state.pendingSourceChange && this.state.batch) return false;
    this.update({ batch: null, draftText: '' });
    return true;
  };
  saveBatch = async (): Promise<boolean> => {
    const batch = this.state.batch;
    if (!batch || this.state.pendingSourceChange || batch.saving) return false;
    const changes: AnnotationChanges = {};
    if (batch.fields.world.trim()) changes.world = batch.fields.world.trim();
    if (batch.fields.tagsText.trim()) changes.tags = tagsFrom(batch.fields.tagsText);
    if (batch.fields.note.trim()) changes.note = batch.fields.note.trim();
    if (!Object.keys(changes).length) {
      this.update({ batch: { ...batch, error: '先填写世界名称、标签或备注中的一项。' } });
      return false;
    }
    const epoch = this.sourceEpoch;
    this.update({ batch: { ...batch, saving: true, error: '' } });
    try {
      if (!await this.annotationSourceCurrent()) return false;
      await this.api.edit(batch.ids, changes);
      if (epoch !== this.sourceEpoch) return false;
      this.patchPhotos(batch.ids, changes);
      const current = this.state.batch;
      if (current?.fields !== batch.fields) {
        if (current) this.update({ batch: { ...current, error: '上一次整理已保存，当前改动尚未保存。' } });
        return false;
      }
      this.closeBatch();
      this.notify(`已整理 ${batch.ids.length} 张照片`);
      return true;
    } catch (error) {
      if (!await this.recoverDraftConflict() && this.state.batch) {
        this.update({ batch: { ...this.state.batch, error: errorMessage(error) } });
      }
      return false;
    } finally {
      if (this.state.batch) this.update({ batch: { ...this.state.batch, saving: false } });
    }
  };

  openSource = (): boolean => {
    if (!this.state.settings || this.state.pickerPending || this.state.sourceApplying || this.state.stopped || !this.canChangeSource()) return false;
    this.update({
      sourceOpen: !!(this.state.catalog?.configured ?? this.state.settings.configured),
      sourceDraft: this.state.catalog?.source || this.state.settings.source || this.state.settings.default_source,
      sourceMessage: this.state.settings.picker_available ? '' : '无法打开选择窗口时，可以手动填写完整路径。',
      sourceError: false,
    });
    return true;
  };
  closeSource = (): void => {
    if (!this.state.pickerPending && !this.state.sourceApplying) this.update({ sourceOpen: false });
  };
  setSourceDraft = (sourceDraft: string): void => this.update({ sourceDraft, sourceMessage: '确认后将使用这个照片文件夹。', sourceError: false });
  pickFolder = async (): Promise<void> => {
    if (this.state.pickerPending || this.state.sourceApplying || this.state.stopped || !this.state.settings?.picker_available) return;
    this.update({ pickerPending: true, sourceError: false, sourceMessage: '请在电脑上的文件夹窗口中选择照片目录。窗口可能在浏览器后面；按取消会保留当前选择。' });
    try {
      const result = await this.api.pickFolder();
      this.update(result.cancelled || !result.path
        ? { sourceMessage: '已取消选择，照片文件夹没有更改。' }
        : { sourceDraft: result.path, sourceMessage: '文件夹已选好，确认后开始整理。' });
    } catch (error) {
      this.update({ sourceError: true, sourceMessage: `${errorMessage(error)} 可以手动填写完整路径后再试。` });
    } finally {
      this.update({ pickerPending: false });
    }
  };
  applySource = async (): Promise<boolean> => {
    if (this.state.sourceApplying || this.state.pickerPending || this.state.stopped || !this.canChangeSource()) return false;
    const source = this.state.sourceDraft.trim();
    if (!source) {
      this.update({ sourceError: true, sourceMessage: '请选择一个照片文件夹，或填写它的完整路径。' });
      return false;
    }
    this.update({ sourceApplying: true, sourceError: false, sourceMessage: '正在确认照片文件夹…' });
    try {
      const result = await this.api.setSource(source);
      this.sourceEpoch++;
      this.resetView();
      const old = this.state.catalog;
      const catalog: AlbumCatalog = {
        app: old?.app || 'vrchat-local-album-v1', version: old?.version || '', data: old?.data || '',
        source: result.source, source_revision: result.source_revision, revision: -1,
        configured: true, ready: false, scanning: true, scan_phase: 'discovering',
        processed: 0, discovered: 0, error: null, scan_errors: [], photos: [],
        duplicates: 0, total_files: 0, last_scan: null,
      };
      this.update({
        catalog, sourceOpen: false, sourceDraft: result.source,
        settings: this.state.settings ? {
          ...this.state.settings, configured: true, source: result.source, source_exists: true, source_revision: result.source_revision,
        } : null,
        pendingSourceChange: false, dismissedError: '', error: '', disconnected: false,
        sourceMessage: '照片文件夹已保存，开始整理。',
      });
      this.notify('照片文件夹已保存，开始整理');
      await this.refresh(true);
      this.schedulePoll(1000);
      return true;
    } catch (error) {
      this.update({ sourceError: true, sourceMessage: errorMessage(error) });
      return false;
    } finally {
      this.update({ sourceApplying: false });
    }
  };

  scan = async (): Promise<void> => {
    if (!this.state.catalog?.configured || this.state.catalog.scanning || this.state.stopped || this.state.sourceApplying) return;
    try {
      await this.api.scan();
      if (this.state.catalog) this.update({ catalog: {
        ...this.state.catalog, scanning: true, scan_phase: 'discovering', processed: 0, discovered: 0, error: null,
      }, dismissedError: '', error: '' });
      this.notify('开始检查相册中的新照片');
      this.schedulePoll(1000);
    } catch (error) {
      this.showError(errorMessage(error));
    }
  };
  shutdown = async (): Promise<boolean> => {
    try {
      await this.api.shutdown();
      clearTimeout(this.pollTimer);
      this.update({ stopped: true, disconnected: false });
      this.notify('整理记录已保存，后台已停止');
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    }
  };

  annotationDraft = () => {
    const { batch, viewer, catalog, photos } = this.state;
    const draftPhotos = viewer?.photo && !photos.some(photo => photo.id === viewer.id) ? [...photos, viewer.photo] : photos;
    return createDraft(catalog, draftPhotos, batch?.ids || (viewer ? [viewer.id] : []), batch?.fields || viewer?.fields || EMPTY_FIELDS, batch ? 'batch' : 'photo');
  };
  copyDraft = async (): Promise<boolean> => {
    const draftText = JSON.stringify(this.annotationDraft(), null, 2);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(draftText);
      this.notify('草稿已复制，内容仍保留在这里');
      return true;
    } catch {
      this.update({ draftText });
      this.notify('请复制草稿文字，或使用导出草稿 JSON');
      return false;
    }
  };
  exportDraft = (): void => {
    const blob = new Blob([JSON.stringify(this.annotationDraft(), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vrchat-album-draft-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.notify('已导出文字草稿，照片与草稿内容仍保留');
  };
  discardDraftAndRefresh = async (): Promise<void> => {
    if (!this.state.pendingSourceChange) return;
    this.update({ pendingSourceChange: false, viewer: null, batch: null, draftText: '' });
    await this.refresh(true);
    this.schedulePoll(0);
    this.notify('已放弃这份草稿，正在打开当前相册');
  };
  dismissError = (): void => this.update({ dismissedError: this.state.error, error: '' });
  dismissToast = (): void => this.update({ toast: '' });
  wake = (): void => this.schedulePoll(0);

  readonly actions = {
    refresh: this.refresh, retry: this.retry, loadSettings: this.loadSettings,
    setSearch: this.setSearch, setMonth: this.setMonth, setWorld: this.setWorld,
    setFavorites: this.setFavorites, clearFilters: this.clearFilters,
    setView: this.setView, openCollection: this.openCollection, setMemoryDate: this.setMemoryDate,
    setMemoryRange: this.setMemoryRange, randomPhoto: this.randomPhoto,
    setGroup: this.setGroup, setBrowse: this.setBrowse, loadMore: this.loadMore,
    toggleSelectMode: this.toggleSelectMode, toggleSelected: this.toggleSelected,
    selectFiltered: this.selectFiltered, clearSelection: this.clearSelection,
    openViewer: this.openViewer, closeViewer: this.closeViewer, updateViewer: this.updateViewer,
    discardViewerDraft: this.discardViewerDraft,
    saveViewer: this.saveViewer, moveViewer: this.moveViewer, toggleFavorite: this.toggleFavorite,
    openBatch: this.openBatch, openSession: this.openSession, updateBatch: this.updateBatch,
    closeBatch: this.closeBatch, saveBatch: this.saveBatch,
    openSource: this.openSource, closeSource: this.closeSource, setSourceDraft: this.setSourceDraft,
    pickFolder: this.pickFolder, applySource: this.applySource, scan: this.scan, shutdown: this.shutdown,
    annotationDraft: this.annotationDraft, copyDraft: this.copyDraft, exportDraft: this.exportDraft,
    discardDraftAndRefresh: this.discardDraftAndRefresh, dismissError: this.dismissError, dismissToast: this.dismissToast,
  };
}

export function useAlbum(options: AlbumOptions = {}) {
  const [controller] = useState(() => new AlbumController(options));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    const visibility = () => { if (!document.hidden) { controller.syncToday(); controller.wake(); } };
    const clock = setInterval(() => controller.syncToday(), 60_000);
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(clock); controller.dispose(); document.removeEventListener('visibilitychange', visibility); };
  }, [controller]);
  const scoped = useMemo(() => scopePhotos(state.photos, state), [state.photos, state.view, state.collection, state.memoryDate, state.memoryRange, state.today]);
  const galleryGroup = scopeGroup(state);
  const filtered = useMemo(
    () => orderPhotos(filterPhotos(scoped, state.filters), galleryGroup),
    [scoped, state.filters, galleryGroup],
  );
  const groups = useMemo(() => groupPhotos(filtered, galleryGroup, state.limit), [filtered, galleryGroup, state.limit]);
  const collections = useMemo(() => buildCollections(state.photos, state.today), [state.photos, state.today]);
  const sidebar = useMemo(() => sidebarModel(state.photos), [state.photos]);
  const viewerId = state.viewer?.id;
  const viewerSnapshot = state.viewer?.photo;
  const currentViewerPhoto = useMemo(() => state.photos.find(photo => photo.id === viewerId) || null, [state.photos, viewerId]);
  const viewerPhoto = currentViewerPhoto || viewerSnapshot || null;
  const viewerMissing = !!viewerId && !currentViewerPhoto;
  const viewerOrder = useMemo(() => {
    const available = new Set(state.photos.map(photo => photo.id));
    return (state.viewer?.order || []).filter(id => available.has(id));
  }, [state.photos, state.viewer?.order]);
  const viewerIndex = viewerOrder.indexOf(viewerId || '');
  const sessionId = viewerPhoto?.session_id;
  const sessionCount = useMemo(() => sessionId ? state.photos.filter(photo => photo.session_id === sessionId).length : 0, [state.photos, sessionId]);
  return {
    ...state, ...controller.actions, scoped, filtered, groups, sidebar, collections, galleryGroup,
    viewerPhoto, viewerMissing, viewerIndex, viewerCount: viewerOrder.length, sessionCount,
    configured: state.catalog?.configured ?? state.settings?.configured ?? false,
    hasFilters: !!(state.filters.month || state.filters.world || state.filters.favorites || state.filters.search),
  };
}

export type AlbumHook = ReturnType<typeof useAlbum>;
