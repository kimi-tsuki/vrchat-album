import { afterEach, describe, expect, it, vi } from 'vitest';
import { albumApi, request, pagedCatalog } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('album API requests', () => {
  it('sends annotation values as same-origin JSON with cache disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await albumApi.edit(['synthetic-id'], { world: '合成世界', tags: ['测试'], note: '测试备注' });
    expect(fetchMock).toHaveBeenCalledWith('/api/edit', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['synthetic-id'], world: '合成世界', tags: ['测试'], note: '测试备注' }),
    });
  });

  it('preserves the backend error message instead of treating a failed write as saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '合成错误：照片文件夹已更改' }), { status: 400 })));
    await expect(albumApi.edit(['synthetic-id'], { note: '测试' })).rejects.toThrow('合成错误：照片文件夹已更改');
  });

  it('reports an invalid response when a restarted server returns a non-JSON page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>unavailable</html>', { status: 503 })));
    await expect(request('/api/catalog')).rejects.toThrow('后台没有返回有效数据');
  });
});

it('loads pages of a consistent snapshot and reports partial progress', async()=>{
  const first={photos:[{id:'a'}],snapshot:'1:2',next_offset:1,total_photos:2};const second={...first,photos:[{id:'b'}],next_offset:null};
  const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(first))).mockResolvedValueOnce(new Response(JSON.stringify(second)));
  vi.stubGlobal('fetch',fetchMock);const progress=vi.fn();const result=await pagedCatalog(progress);
  expect(result.photos.map(p=>p.id)).toEqual(['a','b']);expect(result.index_complete).toBe(true);expect(progress.mock.calls[0][0].index_complete).toBe(false);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/catalog/page?offset=1&limit=256&snapshot=1%3A2');
});
it('restarts pagination after an index changes instead of combining snapshots',async()=>{
  const old={photos:[{id:'old'}],snapshot:'1:1',next_offset:1,total_photos:2};const current={photos:[{id:'new'}],snapshot:'1:2',next_offset:null,total_photos:1};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(old))).mockResolvedValueOnce(new Response(JSON.stringify({error:'changed'}),{status:409})).mockResolvedValueOnce(new Response(JSON.stringify(current))));
  expect((await pagedCatalog()).photos.map(p=>p.id)).toEqual(['new']);
});
