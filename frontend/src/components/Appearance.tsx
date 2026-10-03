import { Button, Label, Radio, RadioGroup } from '@heroui/react';
import { themeOptions, type Preferences, type Theme, type Layout } from '../preferences';
import { Dialog } from './Dialog';

const layoutOptions: { value: Layout; title: string; detail: string }[] = [
  { value: 'grid', title: '整齐网格', detail: '统一画幅，一眼看全' },
  { value: 'masonry', title: '瀑布流', detail: '保留比例，高低错落' },
  { value: 'justified', title: '横排照片墙', detail: '保留比例，每排等高' },
];
export function Appearance({ isOpen, onClose, preferences, onChange, storageFailed }: {
  isOpen: boolean; onClose(): void; preferences: Preferences; onChange(patch: Partial<Preferences>): void; storageFailed: boolean;
}) {
  return <Dialog isOpen={isOpen} onClose={onClose} title="换一种相册外观" description="主题与照片布局可以自由组合，选好即刻生效。" size="lg" footer={<Button onPress={onClose}>完成</Button>}>
    <RadioGroup value={preferences.theme} onChange={value => onChange({ theme: value as Theme })} className="appearance-group"><Label>界面主题</Label>
      <div className="appearance-options">{themeOptions.map(option => <Radio key={option.value} value={option.value} className="appearance-choice">
        <Radio.Content><span className={`theme-preview ${option.value}`} aria-hidden="true"><i /><i /><i /></span><span className="choice-copy"><strong>{option.title}</strong><small>{option.detail}</small></span><Radio.Control><Radio.Indicator /></Radio.Control></Radio.Content>
      </Radio>)}</div>
    </RadioGroup>
    <RadioGroup value={preferences.layout} onChange={value => onChange({ layout: value as Layout })} className="appearance-group"><Label>照片布局</Label>
      <div className="appearance-options">{layoutOptions.map(option => <Radio key={option.value} value={option.value} className="appearance-choice">
        <Radio.Content><span className={`layout-preview preview-${option.value}`} aria-hidden="true"><i /><i /><i /><i /><i /><i /></span><span className="choice-copy"><strong>{option.title}</strong><small>{option.detail}</small></span><Radio.Control><Radio.Indicator /></Radio.Control></Radio.Content>
      </Radio>)}</div>
    </RadioGroup>
    <p className="appearance-hint">{storageFailed ? '浏览器无法保存偏好；本次选择仍然生效。' : '自动记住此浏览器的选择 · 收藏与整理记录照常保留'}</p>
  </Dialog>;
}
