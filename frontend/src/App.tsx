import { Button, Card, Input, Label, ListBox, ProgressBar, Select, Spinner, Tabs, TextField } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import { useAlbum } from './useAlbum';
import type { AlbumHook } from './useAlbum';
import { usePreferences } from './preferences';
import type { GroupMode, BrowseMode, LibraryView } from './types';
import { monthText } from './model';
import { Appearance } from './components/Appearance';
import { Gallery } from './components/Gallery';
import { Dialog } from './components/Dialog';
import { Field } from './components/Field';
import { Icon } from './components/Icon';
import { Setup, SourceForm } from './components/SourceForm';
import { DraftActions, Viewer } from './components/Viewer';
import { Collections, MemoryControls } from './components/Discover';
import { useEntrance } from './motion';
import { Recovery } from './components/Recovery';
import { Journal } from './components/Journal';
import { Similar } from './components/Similar';
import { CollectionEditor } from './components/CustomCollections';
import type { CustomCollection } from './types';

const repository = 'https://github.com/kimi-tsuki/vrchat-album';
const groupOptions: { id: GroupMode; label: string }[] = [{id:'world',label:'世界'},{id:'date',label:'日期'},{id:'session',label:'场次'}];
const viewOptions: { id: LibraryView; label: string }[] = [{id:'photos',label:'相册'},{id:'memories',label:'那年今日'},{id:'collections',label:'合集'},{id:'similar',label:'相似照片'},{id:'journal',label:'漫游足迹'}];

function ModeTabs<T extends string>({ options, selected, onChange, label, className = '' }: {
  options: { id: T; label: string }[]; selected: T; onChange(value: T): void; label: string; className?: string;
}) {
  return <Tabs selectedKey={selected} onSelectionChange={key => onChange(String(key) as T)} className={className}><Tabs.ListContainer><Tabs.List aria-label={label}>{options.map(option => <Tabs.Tab id={option.id} key={option.id}>{option.label}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer></Tabs>;
}

function BrowseSelect({ album }: { album: AlbumHook }) {
  const worlds = album.browse === 'worlds';
  const options = worlds ? album.sidebar.worlds : album.sidebar.months;
  return <Select aria-label={worlds ? '筛选世界' : '筛选月份'} selectedKey={(worlds ? album.filters.world : album.filters.month) || 'all'} onSelectionChange={key => worlds ? album.setWorld(key === 'all' ? '' : String(key)) : album.setMonth(key === 'all' ? '' : String(key))}>
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="all" textValue={worlds ? '全部世界' : '全部月份'}><Label>{worlds ? '全部世界' : '全部月份'}</Label><ListBox.ItemIndicator /></ListBox.Item>{options.map(option => <ListBox.Item key={option.key} id={option.key} textValue={option.name}><Label>{option.name} · {option.count}</Label><ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}

function ScanProgress({ album }: { album: AlbumHook }) {
  const c = album.catalog;
  if (!c?.scanning || !album.configured) return null;
  const discovering = c.scan_phase === 'discovering';
  const count = discovering ? `已找到 ${c.discovered.toLocaleString()} 个照片文件` : `已处理 ${c.processed.toLocaleString()} / ${c.discovered.toLocaleString()} 个文件`;
  return <Card className="scan-progress"><Card.Header><Card.Title>{discovering ? '正在查找照片' : '正在准备你的相册'}</Card.Title><span>{count}</span></Card.Header><Card.Content>
    <ProgressBar aria-label="照片扫描进度" isIndeterminate={discovering || !c.discovered} value={Math.min(c.processed,c.discovered)} maxValue={c.discovered || 1}><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track></ProgressBar>
    <p>{c.ready ? '已有照片可以继续查看，新照片整理完成后会自动出现。' : '正在读取照片信息、合并完全相同的副本并准备缩略图，原照片保留在原位。'}</p>
  </Card.Content></Card>;
}

function EmptyGallery({ album }: { album: AlbumHook }) {
  let title = '这里还没有照片';
  let detail = '确认照片目录正确，新照片整理后会自动出现。';
  let label = '更换照片文件夹';
  let action: () => unknown = album.openSource;
  if (album.hasFilters) {
    title = '暂时没有找到这些回忆'; detail = '换个关键词，或清除筛选再看看。'; label = '清除筛选'; action = album.clearFilters;
  } else if (album.view === 'memories') {
    title = album.memoryRange === 'day' ? '这个日期还没有往年记录' : '这个月份还没有往年记录';
    detail = '回忆只来自此前年份。可以换个日期，或回到相册看看最近的照片。';
    label = album.memoryRange === 'day' ? '看看往年这个月' : '回到相册';
    action = album.memoryRange === 'day' ? () => album.setMemoryRange('month') : () => album.setView('photos');
  } else if (album.collection) {
    title = '这册暂时没有照片'; detail = '标注或照片变化后，合集会自动更新。可以看看其他合集。'; label = '返回合集'; action = () => album.setView('collections');
  }
  return <div className="empty"><Icon name="album" /><h2>{title}</h2><p>{detail}</p><Button variant="secondary" onPress={() => { action(); }}>{label}</Button></div>;
}

export function App() {
  const prefs = usePreferences();
  const album = useAlbum({ initialGroup: prefs.preferences.group, initialBrowse: prefs.preferences.browse });
  const [recovery,setRecovery]=useState(false);
  const [collectionEdit, setCollectionEdit] = useState<CustomCollection | null | undefined>(undefined);
  const [appearance, setAppearance] = useState(false);
  const [stop, setStop] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && album.selectMode && !album.viewer && !album.batch && !album.sourceOpen && !appearance && !stop) album.toggleSelectMode();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [album.selectMode, album.viewer, album.batch, album.sourceOpen, appearance, stop, album.toggleSelectMode]);
  const c = album.catalog;
  const path = c?.source || album.settings?.source || album.settings?.default_source || '尚未选择照片文件夹';
  const busy = album.sourceApplying || album.pickerPending || album.stopped;
  const browseOptions: { id: BrowseMode; label: string }[] = [{id:'worlds',label:'世界'},{id:'months',label:'月份'}];
  const setGroup = (group: GroupMode) => { album.setGroup(group); prefs.updatePreferences({ group }); };
  const setBrowse = (browse: BrowseMode) => { album.setBrowse(browse); prefs.updatePreferences({ browse }); };
  const title = album.view === 'journal' ? '把漫游写成故事' : album.view === 'similar' ? '挑出最喜欢的那一张' : album.view === 'memories' ? '那年今日，再看一眼' : album.view === 'collections' ? album.collection?.title || '把回忆汇成一册' : album.filters.world ? album.sidebar.worlds.find(world => world.key === album.filters.world)?.name || '这个世界' : album.filters.month ? monthText(album.filters.month) : album.filters.favorites ? '最想再看一眼的瞬间' : '所有的漫游瞬间';
  const specialView = album.view === 'similar' || album.view === 'journal';
  const collectionIndex = album.view === 'collections' && !album.collection;
  const narrowed = album.hasFilters || album.view === 'memories' || !!album.collection;
  const contentRef = useRef<HTMLDivElement>(null);
  useEntrance(contentRef, JSON.stringify([album.configured, c?.ready, album.view, album.collection?.rule,
    album.view === 'memories' ? [album.memoryDate, album.memoryRange] : null,
    album.filters.world, album.filters.month, album.filters.favorites,
    album.galleryGroup, prefs.preferences.layout]));
  const sourceButton = <Button variant="outline" size="sm" onPress={album.openSource} isDisabled={busy || !album.settings}><Icon name="folder" />{album.configured ? '更换照片文件夹' : '选择照片文件夹'}</Button>;
  const syncText = album.stopped ? '后台已停止 · 重新运行启动文件即可继续' : album.disconnected ? '连接中断 · 重新运行启动文件后会自动恢复' : !album.configured ? '选好照片文件夹，再开始整理' : c?.scanning ? c.ready ? '正在检查新照片，已有照片可以继续查看…' : '第一次整理中 · 完成后自动显示相册' : c?.ready ? `${narrowed ? '找到' : '已整理'} ${narrowed ? album.filtered.length : album.photos.length} 张照片 · 自动检查新照片${c.last_scan ? ` · ${c.last_scan.slice(11,16)} 更新` : ''}` : c?.error ? '整理暂未完成 · 可以重试扫描或更换目录' : '正在准备相册…';
  return <div className="album-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-icon"><Icon name="album" /></span><div><div className="brand-name">漫游相册</div><div className="brand-sub">VRCHAT MEMORIES</div></div></div>
      <Button variant="ghost" className={`nav-button${album.view === 'photos' && !album.filters.favorites ? ' active' : ''}`} onPress={() => album.setFavorites(false)}><Icon name="album" />所有照片<span className="nav-count">{album.sidebar.total}</span></Button>
      <Button variant="ghost" className={`nav-button${album.view === 'photos' && album.filters.favorites ? ' active' : ''}`} onPress={() => album.setFavorites(true)}><Icon name="star" />我的星标<span className="nav-count">{album.sidebar.favorites}</span></Button>
      <p className="sidebar-label">走过的地方与时间</p><ModeTabs options={browseOptions} selected={album.browse} onChange={setBrowse} label="浏览方式" className="sidebar-tabs" />
      <nav className="sidebar-list" aria-label={album.browse === 'worlds' ? '世界筛选' : '月份筛选'}>{(album.browse === 'worlds' ? album.sidebar.worlds : album.sidebar.months).map(item => <Button key={item.key} variant="ghost" size="sm" className={(album.browse === 'worlds' ? album.filters.world : album.filters.month) === item.key ? 'active' : ''} onPress={() => album.browse === 'worlds' ? album.setWorld(album.filters.world === item.key ? '' : item.key) : album.setMonth(album.filters.month === item.key ? '' : item.key)}><span className="sidebar-item-dot" /><span className="sidebar-item-name">{item.name}</span><span className="nav-count">{item.count}</span></Button>)}</nav>
      <div className="source-box"><div className="source-heading"><Icon name="folder" />照片在你的电脑上</div><p className="source-path">{path}</p>{sourceButton}<p>原照片只读 · 整理记录保存在本机</p></div>
    </aside>
    <main className="album-main"><header className="page-header"><div><p className="eyebrow">COLLECT MOMENTS, KEEP WANDERING</p><h1 key={title}>{title}{album.filters.favorites && (album.filters.world || album.filters.month) ? ' · 星标' : ''}</h1><p className="subtitle">每一张照片，都是一段曾经抵达的时光。</p></div><div className="header-actions">
      <Button variant="outline" onPress={() => setAppearance(true)}><Icon name="palette" />外观</Button><Button variant="outline" onPress={() => { void album.scan(); }} isDisabled={!album.configured || c?.scanning || busy}><Icon name="refresh" />{c?.scanning ? '扫描中…' : '重新扫描'}</Button><Button variant="outline" onPress={()=>setRecovery(true)} isDisabled={!album.configured || busy || album.pendingSourceChange || !!album.viewer || !!album.batch}>整理记录与恢复</Button><a className="button button--outline" href="/api/export" download><Icon name="download" />导出记录</a><a className="button button--outline" href="/guide" target="_blank" rel="noopener noreferrer"><Icon name="info" />使用指南</a><a className="button button--outline" href={repository} target="_blank" rel="noopener noreferrer" title="前往仓库，登录 GitHub 后点击 Star"><Icon name="github" />Star on GitHub</a>
    </div></header>
    {album.configured && <ModeTabs options={viewOptions} selected={album.view} onChange={view => { album.setView(view); }} label="相册功能" className="library-tabs" />}
    <div className="mobile-nav">{album.view === 'photos' && <><Button size="sm" variant={album.filters.favorites ? 'secondary' : 'primary'} onPress={() => album.setFavorites(false)}>全部</Button><Button size="sm" variant={album.filters.favorites ? 'primary' : 'secondary'} onPress={() => album.setFavorites(true)}><Icon name="star" />星标</Button><Button size="sm" variant="outline" onPress={() => setBrowse(album.browse === 'worlds' ? 'months' : 'worlds')}>{album.browse === 'worlds' ? '世界' : '月份'}</Button><BrowseSelect album={album} /></>}<p className="source-path">{path}</p>{sourceButton}</div>
    {album.error && <div className="notice error" role="alert"><Icon name="info" /><p>{album.error}</p><Button isIconOnly variant="ghost" aria-label="关闭错误提示" onPress={album.dismissError}><Icon name="close" /></Button></div>}
    {album.stopped && <div className="notice"><Icon name="info" /><p>后台已停止。照片和整理记录已保留，下次运行启动文件就能继续浏览。</p></div>}
    {!album.settings && !c && <div className="empty"><Spinner /><p>正在连接你的本地相册…</p><Button variant="secondary" onPress={() => { void album.retry(); }}>重新连接</Button></div>}
    {!album.configured && album.settings && <Setup album={album} />}
    {album.configured && <>
      <div className="stats"><div className="stat"><strong>{c?.ready ? album.sidebar.total : '—'}</strong><span>漫游瞬间</span></div><div className="stat"><strong>{c?.ready ? album.sidebar.worldCount : '—'}</strong><span>留下足迹的世界</span></div><div className="stat"><strong>{album.sidebar.latestDate.replaceAll('-',' / ') || '等待整理'}</strong><span>最近的回忆</span></div></div>
      <div ref={contentRef} className="album-content">
      {album.view === 'memories' && <MemoryControls album={album} />}
      {album.view === 'collections' && album.collection && <div className="collection-detail"><Button size="sm" variant="outline" onPress={() => album.setView('collections')}><Icon name="left" />返回合集</Button><p>{album.collection.description} · 这册共 {album.scoped.length} 张照片</p>{album.collection.rule.kind === 'custom' && <Button variant="secondary" size="sm" onPress={()=>setCollectionEdit(album.collection?.rule.kind === 'custom' ? album.collection.rule.value : null)}>编辑合集</Button>}</div>}
      {!collectionIndex && !specialView && <div className="toolbar"><TextField aria-label="搜索照片" value={album.filters.search} onChange={album.setSearch} className="search-field"><div className="search-input-wrap"><Icon name="search" /><Input placeholder="搜索世界、日期、标签或回忆…" />{album.filters.search && <Button isIconOnly size="sm" variant="ghost" className="search-clear" aria-label="清空搜索" onPress={() => album.setSearch('')}><Icon name="close" /></Button>}</div></TextField><div className="toolbar-right">{album.view !== 'memories' && <><span className="group-label">分组</span><ModeTabs options={groupOptions} selected={album.group} onChange={setGroup} label="照片分组" className="group-tabs" /></>}<Button size="sm" variant="outline" onPress={album.randomPhoto} isDisabled={!album.filtered.length || album.selectMode}><Icon name="shuffle" />随便看看</Button><Button variant={album.selectMode ? 'secondary' : 'outline'} onPress={album.toggleSelectMode}><Icon name="check" />{album.selectMode ? '完成选择' : '选择'}</Button></div></div>}
      <div className="sync-line"><span className={`sync-dot${c?.scanning ? ' scanning' : ''}`} /><span>{syncText}</span>{album.hasFilters && <Button variant="ghost" size="sm" onPress={album.clearFilters}>清除筛选</Button>}</div><ScanProgress album={album} />
      {specialView ? album.view === 'journal' ? <Journal album={album}/> : <Similar album={album} /> : collectionIndex ? c?.ready ? <><Button variant="secondary" onPress={() => setCollectionEdit(null)}>新建自定义合集</Button><Collections album={album} /></> : !c?.scanning && <div className="empty"><Spinner /><p>正在准备合集…</p></div> : album.filtered.length ? <Gallery preserveOrder={album.collection?.rule.kind === 'custom'} photos={album.filtered} allPhotos={album.photos} limit={album.limit} group={album.galleryGroup} layout={prefs.preferences.layout} selected={album.selected} selectMode={album.selectMode} onOpen={photo => album.openViewer(photo.id)} onSelect={photo => album.toggleSelected(photo.id)} onFavorite={photo => { void album.toggleFavorite(photo.id); }} onBatch={ids => { const session = album.photos.find(photo => photo.id === ids[0])?.session_id; if (session) void album.openSession(session); }} onMore={album.loadMore} /> : c?.ready ? <EmptyGallery album={album} /> : !c?.scanning && <div className="empty"><Spinner /><p>正在准备相册…</p></div>}
      </div>
    </>}
    <footer className="page-footer"><span>{!!c?.duplicates && `${c.duplicates} 张完全相同的照片已合并显示 · `}所有原文件均保留{c?.version && ` · v${c.version}`}</span><div className="project-links"><a href={repository} target="_blank" rel="noopener noreferrer"><Icon name="github" />GitHub 项目</a><a href={repository} target="_blank" rel="noopener noreferrer" title="打开仓库后登录 GitHub，点击 Star 支持项目"><Icon name="star" />Star on GitHub</a><Button variant="ghost" size="sm" onPress={() => setStop(true)} isDisabled={album.stopped}>停止后台</Button></div></footer><p className="project-hint">喜欢这个相册？前往 GitHub 仓库并点击 Star 支持项目。</p>
    </main>
    {album.selectMode && <div className="batch-bar"><Button size="sm" variant="secondary" isDisabled={!album.selected.size} onPress={()=>setCollectionEdit(null)}>选图建合集</Button><span className="batch-count">已选 <strong>{album.selected.size}</strong> 张</span><Button variant="ghost" size="sm" onPress={album.selectFiltered}>全选筛选结果</Button><Button variant="ghost" size="sm" onPress={album.clearSelection}>取消选择</Button><Button size="sm" onPress={() => album.openBatch([...album.selected])} isDisabled={!album.selected.size}><Icon name="edit" />批量整理</Button></div>}
    {collectionEdit !== undefined && <CollectionEditor album={album} initial={collectionEdit || undefined} onClose={()=>setCollectionEdit(undefined)}/> }
    {recovery && <Recovery album={album} onClose={()=>setRecovery(false)}/>}
    <Viewer album={album} />
    <Dialog isOpen={!!album.batch} onClose={() => { album.closeBatch(); }} title="为这些照片，留下共同的回忆" description={`为${album.batch?.label || '选中的照片'}（${album.batch?.ids.length || 0} 张）填写共同信息。留空的项目保持原样。`} isBusy={album.batch?.saving} footer={<><Button variant="ghost" onPress={() => { album.closeBatch(); }} isDisabled={album.pendingSourceChange || album.batch?.saving}>取消</Button><Button type="submit" form="batch-edit-form" isPending={album.batch?.saving} isDisabled={album.pendingSourceChange}>保存整理</Button></>}>
      {album.batch && <><form id="batch-edit-form" className="field-stack" onSubmit={event => { event.preventDefault(); void album.saveBatch(); }}><Field label="共同的世界名称" value={album.batch.fields.world} onChange={world => album.updateBatch({world})} maxLength={200} isDisabled={album.batch.saving} /><Field label="共同的标签" value={album.batch.fields.tagsText} onChange={tagsText => album.updateBatch({tagsText})} description="用逗号分隔；填写后替换这些照片的标签" isDisabled={album.batch.saving} /><Field label="共同的备注" value={album.batch.fields.note} onChange={note => album.updateBatch({note})} multiline maxLength={4000} isDisabled={album.batch.saving} /></form>{album.batch.error && <p className="form-message error" role="alert">{album.batch.error}</p>}<DraftActions album={album} /></>}
    </Dialog>
    <Dialog isOpen={album.sourceOpen} onClose={album.closeSource} title="更换照片文件夹" description="确认新目录后开始整理。收藏与标注跟随同一张照片保留，原照片只读。" isBusy={album.sourceApplying || album.pickerPending}><SourceForm album={album} /></Dialog>
    <Dialog isOpen={stop} onClose={() => setStop(false)} title="停止相册后台？" description="整理记录会保留。下次运行启动文件即可继续浏览。" isBusy={stopBusy} footer={<><Button variant="ghost" onPress={() => setStop(false)}>继续浏览</Button><Button variant="danger" onPress={async () => { setStopBusy(true); if (await album.shutdown()) setStop(false); setStopBusy(false); }}>停止后台</Button></>}><p className="form-message">关闭这个网页不会自动停止后台。</p></Dialog>
    <Appearance isOpen={appearance} onClose={() => setAppearance(false)} {...prefs} onChange={prefs.updatePreferences} />
    {album.toast && <div className="toast" role="status">{album.toast}</div>}
  </div>;
}
