import { useLayoutEffect, useRef, type RefObject } from 'react';

const easing = 'cubic-bezier(.22, 1, .36, 1)';

/** Animate only visible surfaces; never hide content when motion is unavailable. */
export function enterElements(elements: readonly HTMLElement[], stagger = false): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations: Animation[] = [];
  const cancel = () => animations.forEach(animation => animation.cancel());
  if (!preference.matches) {
    const visible = elements.filter(element => {
      if (typeof element.animate !== 'function') return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight &&
        box.right > 0 && box.left < window.innerWidth;
    }).slice(0, stagger ? 12 : 1);
    visible.forEach((element, index) => {
      animations.push(element.animate([
        { opacity: 0, transform: `translate3d(0, ${stagger ? 12 : 8}px, 0)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ], { duration: stagger ? 320 : 260, delay: stagger ? Math.min(index * 22, 132) : 0, easing, fill: 'backwards' }));
    });
  }
  const onPreference = () => { if (preference.matches) cancel(); };
  preference.addEventListener('change', onPreference);
  return () => { preference.removeEventListener('change', onPreference); cancel(); };
}

/** Keep mounted controls and drafts intact; list updates animate newly added cards only. */
export function useEntrance(ref: RefObject<HTMLElement | null>, key: string, selector?: string) {
  const seen = useRef(new WeakSet<HTMLElement>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !key) return;
    if (!selector) return enterElements([root]);
    const elements = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const added = elements.filter(element => !seen.current.has(element));
    elements.forEach(element => seen.current.add(element));
    return enterElements(added, true);
  }, [ref, key, selector]);
}
