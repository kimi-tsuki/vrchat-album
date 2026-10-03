import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAppearance, parsePreferences, type Theme } from './preferences';

afterEach(() => vi.unstubAllGlobals());

const themeCases: [Theme, 'light' | 'dark'][] = [
  ['warm-dark', 'dark'], ['paper-light', 'light'], ['cool-blue', 'dark'],
  ['glass', 'dark'], ['mist-purple', 'dark'], ['monochrome', 'light'],
];

describe('saved appearance compatibility', () => {
  it('retains valid settings from the previous frontend', () => {
    expect(parsePreferences('{"theme":"paper-light","layout":"justified","group":"session","browse":"months"}')).toEqual({theme:'paper-light',layout:'justified',group:'session',browse:'months'});
  });
  it.each(themeCases)('restores the saved %s theme without resetting layout or browsing', theme => {
    const raw = JSON.stringify({ theme, layout: 'masonry', group: 'date', browse: 'months', futureSetting: true });
    expect(parsePreferences(raw)).toEqual({ theme, layout: 'masonry', group: 'date', browse: 'months' });
  });
  it.each([null, 'broken', 'null', '[]', '{"theme":"other","layout":"other"}'])('recovers invalid browser settings: %s', raw => {
    expect(parsePreferences(raw)).toEqual({theme:'warm-dark',layout:'grid',group:'world',browse:'worlds'});
  });
});

describe('HeroUI appearance mode', () => {
  it.each(themeCases)('applies %s with the correct %s color scheme', (theme, colorScheme) => {
    const root = { dataset: {} as Record<string, string>, style: { colorScheme: '' }, classList: { toggle: vi.fn() } };
    vi.stubGlobal('document', { documentElement: root });
    applyAppearance({ theme, layout: 'justified', group: 'world', browse: 'worlds' });
    expect(root.dataset).toEqual({ theme, layout: 'justified' });
    expect(root.style.colorScheme).toBe(colorScheme);
    expect(root.classList.toggle).toHaveBeenCalledWith('dark', colorScheme === 'dark');
  });
});
