import { Button, Card } from '@heroui/react';
import type { AlbumHook } from '../useAlbum';
import { Field } from './Field';
import { Icon } from './Icon';

export function SourceForm({ album, setup = false }: { album: AlbumHook; setup?: boolean }) {
  const busy = album.sourceApplying || album.pickerPending || album.stopped;
  return <form className="source-form" onSubmit={event => { event.preventDefault(); void album.applySource(); }}>
    <div className="source-preview"><small>待使用的照片文件夹</small>{album.sourceDraft || '请先选择一个照片文件夹'}</div>
    <Button variant="secondary" onPress={() => { void album.pickFolder(); }} isDisabled={busy || !album.settings?.picker_available} isPending={album.pickerPending}><Icon name="folder" />选择其他文件夹</Button>
    <Field label="照片文件夹的完整路径" value={album.sourceDraft} onChange={album.setSourceDraft} placeholder="例如 D:\VRChatPhotos" description="也可以从资源管理器地址栏复制完整路径。原照片保留在原位。" isDisabled={busy} />
    {album.sourceMessage && <p className={`form-message${album.sourceError ? ' error' : ''}`} role="status">{album.sourceMessage}</p>}
    <div className="form-actions">{!setup && <Button variant="ghost" onPress={album.closeSource} isDisabled={busy}>取消</Button>}<Button type="submit" isPending={album.sourceApplying} isDisabled={busy || !album.sourceDraft.trim()}>{setup ? '开始整理' : '确认并开始整理'}</Button></div>
  </form>;
}

export function Setup({ album }: { album: AlbumHook }) {
  return <Card className="setup-card"><Card.Header><span className="setup-icon"><Icon name="folder" /></span><Card.Title>先选好照片，再开始漫游</Card.Title><Card.Description>选择存放 VRChat 照片的文件夹。相册会读取照片和子目录，准备预览，把回忆整理在一起。</Card.Description></Card.Header><Card.Content><SourceForm album={album} setup /></Card.Content></Card>;
}
