export type GroupMode = 'world' | 'date' | 'session';
export type BrowseMode = 'worlds' | 'months';

export interface Photo {
  id: string;
  filename: string;
  captured_at: string;
  date: string;
  month: string;
  width: number;
  height: number;
  world: string;
  world_id: string;
  tags: string[];
  note: string;
  favorite: boolean;
  copies: number;
  date_source: 'filename' | 'metadata' | 'modified';
  thumb_url: string;
  original_url: string;
  session_id: string;
  session_label: string;
}

export interface ScanError {
  path?: string;
  message?: string;
}

export interface AlbumStatus {
  app: string;
  version: string;
  source: string;
  data: string;
  configured: boolean;
  source_revision: number;
  ready: boolean;
  scanning: boolean;
  scan_phase: string;
  error: string | null;
  scan_errors: ScanError[];
  last_scan: string | null;
  processed: number;
  discovered: number;
  revision: number;
  total_files: number;
  duplicates: number;
}

export interface AlbumCatalog extends AlbumStatus {
  photos: Photo[];
}

export interface AlbumSettings {
  configured: boolean;
  source: string;
  source_exists: boolean;
  default_source: string;
  picker_available: boolean;
  source_revision: number;
}

export interface PhotoFilters {
  month: string;
  world: string;
  favorites: boolean;
  search: string;
}

export interface AnnotationFields {
  world: string;
  tagsText: string;
  note: string;
}

export interface AnnotationChanges {
  world?: string;
  tags?: string[];
  note?: string;
  favorite?: boolean;
}

export interface ViewerState {
  id: string;
  photo?: Photo;
  fields: AnnotationFields;
  dirty: boolean;
  saving: boolean;
  message: string;
}

export interface BatchState {
  ids: string[];
  label: string;
  fields: AnnotationFields;
  saving: boolean;
  error: string;
}

export interface AnnotationDraft {
  format: 'vrchat-album-annotation-draft';
  format_version: 1;
  exported_at: string;
  source: string;
  source_revision: number | null;
  mode: 'batch' | 'photo';
  photos: Array<{ id: string; filename: string }>;
  fields: { world: string; tags_text: string; note: string };
}

export interface AlbumState {
  catalog: AlbumCatalog | null;
  settings: AlbumSettings | null;
  photos: Photo[];
  filters: PhotoFilters;
  group: GroupMode;
  browse: BrowseMode;
  limit: number;
  selectMode: boolean;
  selected: ReadonlySet<string>;
  viewer: ViewerState | null;
  batch: BatchState | null;
  sourceOpen: boolean;
  sourceDraft: string;
  sourceMessage: string;
  sourceError: boolean;
  sourceApplying: boolean;
  pickerPending: boolean;
  pendingSourceChange: boolean;
  draftText: string;
  loading: boolean;
  settingsLoading: boolean;
  disconnected: boolean;
  stopped: boolean;
  error: string;
  dismissedError: string;
  toast: string;
}
