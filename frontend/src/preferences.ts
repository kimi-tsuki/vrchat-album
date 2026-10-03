import { useEffect, useState } from 'react';

export const preferenceKey = 'vrchat-album-view-preferences';
export const themes = ['warm-dark', 'paper-light', 'cool-blue'] as const;
export const layouts = ['grid', 'masonry', 'justified'] as const;
export type Theme = typeof themes[number];
export type Layout = typeof layouts[number];
export type GroupMode = 'world' | 'date' | 'session';
export type BrowseMode = 'worlds' | 'months';
export interface Preferences { theme: Theme; layout: Layout; group: GroupMode; browse: BrowseMode }
const defaults: Preferences = { theme: 'warm-dark', layout: 'grid', group: 'world', browse: 'worlds' };

export function parsePreferences(raw: string | null): Preferences {
  let value: Partial<Preferences> = {};
  try { const parsed: unknown = JSON.parse(raw || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } catch { /* Browser data may be damaged. */ }
  return {
    theme: themes.includes(value.theme as Theme) ? value.theme! : defaults.theme,
    layout: layouts.includes(value.layout as Layout) ? value.layout! : defaults.layout,
    group: ['world', 'date', 'session'].includes(value.group || '') ? value.group! : defaults.group,
    browse: ['worlds', 'months'].includes(value.browse || '') ? value.browse! : defaults.browse,
  };
}

export function readPreferences(): Preferences {
  try { return parsePreferences(localStorage.getItem(preferenceKey)); } catch { return { ...defaults }; }
}

export function applyAppearance(prefs: Preferences) {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.layout = prefs.layout;
  document.documentElement.classList.toggle('dark', prefs.theme !== 'paper-light');
  document.documentElement.style.colorScheme = prefs.theme === 'paper-light' ? 'light' : 'dark';
}

export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => { applyAppearance(preferences); }, [preferences]);
  useEffect(() => {
    const restore = () => setPreferences(readPreferences());
    const onStorage = (event: StorageEvent) => { if (event.key === preferenceKey || event.key === null) restore(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', restore);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('pageshow', restore); };
  }, []);
  function updatePreferences(patch: Partial<Preferences>) {
    const next = { ...preferences, ...patch };
    applyAppearance(next);
    setPreferences(next);
    try {
      let existing = {};
      try { const raw = JSON.parse(localStorage.getItem(preferenceKey) || '{}'); if (raw && typeof raw === 'object' && !Array.isArray(raw)) existing = raw; } catch { /* Replace damaged data. */ }
      localStorage.setItem(preferenceKey, JSON.stringify({ ...existing, ...next }));
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
  }
  return { preferences, updatePreferences, storageFailed };
}
