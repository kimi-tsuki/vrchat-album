import type { AlbumCatalog, AlbumSettings, AlbumStatus, AnnotationChanges } from './types';

export async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('后台没有返回有效数据，请重新运行启动文件。');
  }
  if (!response.ok) {
    const error = result && typeof result === 'object' ? result as { error?: string; message?: string } : {};
    throw new Error(error.error || error.message || `请求没有完成（${response.status}）`);
  }
  return result as T;
}

export const albumApi = {
  catalog: () => request<AlbumCatalog>('/api/catalog'),
  status: () => request<AlbumStatus>('/api/status'),
  settings: () => request<AlbumSettings>('/api/settings'),
  setSource: (source: string) => request<{ ok: boolean; source: string; source_revision: number }>('/api/settings/source', { source }),
  pickFolder: () => request<{ path: string | null; cancelled: boolean }>('/api/pick-folder', {}),
  edit: (ids: string[], changes: AnnotationChanges) => request<{ ok: boolean }>('/api/edit', { ids, ...changes }),
  scan: () => request<{ ok: boolean }>('/api/scan', {}),
  shutdown: () => request<{ ok: boolean }>('/api/shutdown', {}),
};

export type AlbumApi = typeof albumApi;
