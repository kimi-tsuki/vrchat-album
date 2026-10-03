import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterElements } from './motion';

afterEach(() => vi.unstubAllGlobals());

function environment(reduced = false) {
  const listeners = new Set<() => void>();
  const preference = {
    matches: reduced,
    addEventListener: vi.fn((_name: string, callback: () => void) => listeners.add(callback)),
    removeEventListener: vi.fn((_name: string, callback: () => void) => listeners.delete(callback)),
  };
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, matchMedia: () => preference });
  return { preference, change: () => listeners.forEach(callback => callback()) };
}
function card(top = 100, left = 100) {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  const element = { animate, getBoundingClientRect: () => ({ top, bottom: top + 160, left, right: left + 200, width: 200, height: 160 }) };
  return { element: element as unknown as HTMLElement, animate, cancel };
}

describe('bounded and accessible motion', () => {
  it('caps staggered entrances and skips cards outside the viewport', () => {
    environment();
    const cards = Array.from({ length: 30 }, () => card());
    const below = card(900);
    const beside = card(100, 1300);
    const cleanup = enterElements([below.element, beside.element, ...cards.map(item => item.element)], true);
    expect(below.animate).not.toHaveBeenCalled();
    expect(beside.animate).not.toHaveBeenCalled();
    expect(cards.filter(item => item.animate.mock.calls.length)).toHaveLength(12);
    expect(cards[11].animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ delay: 132, fill: 'backwards' }));
    cleanup();
    expect(cards[0].cancel).toHaveBeenCalledOnce();
  });
  it('leaves content visible and unanimated when reduced motion is enabled', () => {
    const { preference } = environment(true);
    const item = card();
    const cleanup = enterElements([item.element]);
    expect(item.animate).not.toHaveBeenCalled();
    cleanup();
    expect(preference.removeEventListener).toHaveBeenCalledOnce();
  });
  it('cancels running animations immediately if the system switches to reduced motion', () => {
    const { preference, change } = environment();
    const item = card();
    const cleanup = enterElements([item.element]);
    preference.matches = true;
    change();
    expect(item.cancel).toHaveBeenCalledOnce();
    cleanup();
    const calls = item.cancel.mock.calls.length;
    change();
    expect(item.cancel).toHaveBeenCalledTimes(calls);
  });
  it('degrades without changing content when browser animation APIs are unavailable', () => {
    environment();
    const item = card();
    item.element.animate = undefined as unknown as HTMLElement['animate'];
    expect(() => enterElements([item.element])()).not.toThrow();
    vi.stubGlobal('window', undefined);
    expect(() => enterElements([card().element])()).not.toThrow();
  });
});
