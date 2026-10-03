/* Apply saved appearance before the page paints, shared with the guide. */
(function () {
  'use strict';
  const preferenceKey = 'vrchat-album-view-preferences';
  const themes = Object.freeze(['warm-dark', 'paper-light', 'cool-blue']);
  const layouts = Object.freeze(['grid', 'masonry', 'justified']);

  function restoreAppearance() {
    let prefs = {};
    try {
      const value = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) prefs = value;
    } catch {}
    const theme = themes.includes(prefs.theme) ? prefs.theme : themes[0];
    const layout = layouts.includes(prefs.layout) ? prefs.layout : layouts[0];
    const root = document.documentElement;
    const changed = root.dataset.theme !== theme || root.dataset.layout !== layout;
    root.dataset.theme = theme;
    root.dataset.layout = layout;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'paper-light' ? 'light' : 'dark');
    if (changed) window.dispatchEvent(new CustomEvent('album-appearance-change', {detail: {theme, layout}}));
  }

  window.albumAppearance = Object.freeze({preferenceKey, themes, layouts});
  restoreAppearance();
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) restoreAppearance();
  });
  window.addEventListener('pageshow', restoreAppearance);
})();
