import { afterEach, describe, expect, it, vi } from 'vitest';
import { albumApi, request } from './api';

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
