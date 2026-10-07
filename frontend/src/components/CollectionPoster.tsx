import { Button } from '@heroui/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CollectionDisplay } from '../types';
import type { SmartCollection } from '../collections';
import { Icon } from './Icon';

export function CollectionPoster({ collection, display, frames, onOpen, onSettings, onPin, busy = false, preview = false }: {
  collection: SmartCollection; display: CollectionDisplay; frames: string[];
  onOpen?(): void; onSettings?(): void; onPin?(): void; busy?: boolean; preview?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [frame, setFrame] = useState({ current: 0, previous: -1 });
  const signature = frames.join('|');
  const playing = display.slideshow && frames.length > 1 && visible && !hidden && !reduced && !paused && !hovered;
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { threshold: 0.12 });
    if (root.current) observer.observe(root.current);
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(preference.matches);
    const visibility = () => setHidden(document.hidden);
    preference.addEventListener('change', motion); document.addEventListener('visibilitychange', visibility);
    return () => { observer.disconnect(); preference.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { setFrame({ current: 0, previous: -1 }); }, [signature]);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    let candidate = frame.current;
    let pending: HTMLImageElement | undefined;
    const timer = window.setInterval(() => {
      candidate = (candidate + 1) % frames.length;
      const next = candidate;
      pending = new Image();
      pending.onload = () => { if (!cancelled) setFrame(current => ({ current: next, previous: current.current })); };
      pending.src = frames[next];
    }, display.interval * 1000);
    return () => { cancelled = true; clearInterval(timer); if (pending) pending.onload = null; };
  }, [playing, signature, frame.current, display.interval]); // URLs are represented by signature.
  const current = frames[frame.current] || frames[0];
  const previous = frames[frame.previous];
  return <article ref={root} className={`collection-poster${display.pinned ? ' is-featured' : ''}${preview ? ' is-preview' : ''}${playing ? ' is-playing' : ''}`}
    onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={() => setHovered(false)}
    style={{ '--slide-duration': `${display.interval}s`, '--cover-position': `${display.position}%` } as CSSProperties}>
    <div className="poster-art" aria-hidden="true">
      {previous && previous !== current && <img className="poster-previous" src={previous} alt="" decoding="async" />}
      {current ? <img key={current} className="poster-current" src={current} alt="" loading="lazy" decoding="async" /> : <div className="poster-placeholder"><Icon name="album" /></div>}
    </div>
    <button className="poster-open" disabled={preview} onClick={onOpen} aria-label={`打开合集 ${collection.title}，${collection.count} 张`}>
      <span className="poster-kicker">{display.pinned ? '精选置顶 / FEATURED STORY' : collection.category}</span>
      <span className="poster-copy"><span className="poster-title">{collection.title}</span><span className="poster-description">{collection.description}</span>
        <span className="poster-meta"><span>{collection.count.toLocaleString()} 张照片</span><span>{collection.sessions} 场漫游</span>{collection.favorites > 0 && <span>★ {collection.favorites}</span>}</span>
        <span className="poster-enter">打开这段回忆 <Icon name="right" /></span>
      </span>
    </button>
    {!preview && <div className="poster-actions"><Button isIconOnly size="sm" variant="ghost" aria-label={`${display.pinned ? '取消置顶' : '置顶'} ${collection.title}`} aria-pressed={display.pinned} isDisabled={busy} onPress={onPin}><Icon name="pin" /></Button><Button isIconOnly size="sm" variant="ghost" aria-label={`合集设置 ${collection.title}`} onPress={onSettings}><Icon name="settings" /></Button></div>}
    {display.slideshow && frames.length > 1 && <div className="poster-playback">
      <span className="poster-dots" aria-hidden="true">{frames.map((src, i) => <i key={src} className={i === frame.current ? 'active' : ''}><b key={`${frame.current}:${playing}`} /></i>)}</span>
      <Button isIconOnly size="sm" variant="ghost" aria-label={`${paused ? '播放' : '暂停'} ${collection.title} 封面幻灯片`} isDisabled={reduced} onPress={() => setPaused(value => !value)}><Icon name={paused || reduced ? 'play' : 'pause'} /></Button>
    </div>}
  </article>;
}
