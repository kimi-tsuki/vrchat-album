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
    throw Object.assign(new Error(error.error || error.message || `请求没有完成（${response.status}）`), { status:response.status });
  }
  return result as T;
}

interface CatalogPage extends AlbumCatalog { snapshot:string; next_offset:number|null; total_photos:number }
export async function pagedCatalog(onPage?: (catalog:AlbumCatalog)=>void, cancelled?:()=>boolean): Promise<AlbumCatalog> {
  for(let attempt=0;attempt<3;attempt++) {
    let offset=0; let snapshot=''; let photos:AlbumCatalog['photos']=[];
    try {
      while(true) {
        if(cancelled?.()) throw new Error('索引载入已取消。');
        const page=await request<CatalogPage>(`/api/catalog/page?offset=${offset}&limit=256${snapshot?`&snapshot=${encodeURIComponent(snapshot)}`:''}`);
        if(cancelled?.()) throw new Error('索引载入已取消。');
        if(snapshot && page.snapshot!==snapshot) throw new Error('索引分页不一致，请重新载入。');
        snapshot=page.snapshot;photos=photos.concat(page.photos);
        const complete=page.next_offset===null;
        const catalog={...page,photos,index_complete:complete};
        if(complete) return catalog;
        if(page.next_offset===null || page.next_offset<=offset) throw new Error('索引分页没有前进，请重试。');
        onPage?.(catalog);offset=page.next_offset;
      }
    } catch(e) { if(!(e instanceof Error && 'status' in e && e.status===409) || attempt===2) throw e; }
  }
  throw new Error('索引持续更新，请稍后重试。');
}

export const albumApi = {
  catalog: pagedCatalog,
  status: () => request<AlbumStatus>('/api/status'),
  settings: () => request<AlbumSettings>('/api/settings'),
  setSource: (source: string) => request<{ ok: boolean; source: string; source_revision: number }>('/api/settings/source', { source }),
  pickFolder: () => request<{ path: string | null; cancelled: boolean }>('/api/pick-folder', {}),
  edit: (ids: string[], changes: AnnotationChanges) => request<{ ok: boolean }>('/api/edit', { ids, ...changes }),
  scan: () => request<{ ok: boolean }>('/api/scan', {}),
  shutdown: () => request<{ ok: boolean }>('/api/shutdown', {}),
};

export type AlbumApi = typeof albumApi;
