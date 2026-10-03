/* Execute the shared preference script with an isolated DOM/storage boundary. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'theme-preferences.js'), 'utf8');
const preferenceKey = 'vrchat-album-view-preferences';

function page(initial, {blocked = false, hasMeta = true} = {}) {
  let stored = initial;
  const dataset = {};
  const meta = {};
  const events = [];
  const listeners = new Map();
  const context = vm.createContext({
    document: {
      documentElement: {dataset},
      querySelector: () => hasMeta ? {setAttribute(name, value) {meta[name] = value;}} : null,
    },
    localStorage: {
      getItem(key) {
        assert.equal(key, preferenceKey);
        if (blocked) throw new Error('Browser storage disabled');
        return stored;
      },
      setItem() {assert.fail('Restoring appearance must not overwrite existing preferences');},
    },
    window: {
      addEventListener(name, handler) {listeners.set(name, handler);},
      dispatchEvent(event) {events.push({type: event.type, theme: event.detail.theme, layout: event.detail.layout});},
    },
    CustomEvent: class CustomEvent {
      constructor(type, options) {this.type = type; this.detail = options.detail;}
    },
  });
  vm.runInContext(source, context);
  return {dataset, meta, events, api: context.window.albumAppearance,
    update(value) {stored = value;},
    event(type, details = {}) {assert.ok(listeners.has(type)); listeners.get(type)(details);},
    stored() {return stored;},
  };
}

test('old grouping preferences retain their stored data and use the default appearance', () => {
  const stored = JSON.stringify({group: 'session', browse: 'months'});
  const result = page(stored);
  assert.deepEqual(result.dataset, {theme: 'warm-dark', layout: 'grid'});
  assert.equal(result.meta.content, 'dark');
  assert.equal(result.stored(), stored);
  assert.equal(result.events.length, 1);
});

test('all supported combinations restore before the album UI is created', () => {
  for (const theme of ['warm-dark', 'paper-light', 'cool-blue']) {
    for (const layout of ['grid', 'masonry', 'justified']) {
      const result = page(JSON.stringify({theme, layout, group: 'date'}));
      assert.deepEqual(result.dataset, {theme, layout});
      assert.equal(result.meta.content, theme === 'paper-light' ? 'light' : 'dark');
      assert.deepEqual(result.events, [{type: 'album-appearance-change', theme, layout}]);
    }
  }
});

test('damaged, non-object and unsupported preferences fall back safely', () => {
  for (const stored of [undefined, null, '{broken', 'null', '[]', '42', '"dark"', '{"theme":"other","layout":"columns"}']) {
    const result = page(stored);
    assert.deepEqual(result.dataset, {theme: 'warm-dark', layout: 'grid'});
    assert.equal(result.meta.content, 'dark');
  }
  assert.deepEqual(page('{"theme":"paper-light","layout":"other"}').dataset, {theme: 'paper-light', layout: 'grid'});
  assert.deepEqual(page('{"theme":"other","layout":"masonry"}').dataset, {theme: 'warm-dark', layout: 'masonry'});
});

test('disabled storage and a guide without a color-scheme meta still load', () => {
  const blocked = page('{"theme":"paper-light"}', {blocked: true});
  assert.deepEqual(blocked.dataset, {theme: 'warm-dark', layout: 'grid'});
  const guide = page('{"theme":"paper-light","layout":"masonry"}', {hasMeta: false});
  assert.deepEqual(guide.dataset, {theme: 'paper-light', layout: 'masonry'});
});

test('a preference storage event updates a second page, unrelated keys do not', () => {
  const result = page('{"theme":"warm-dark","layout":"grid"}');
  result.events.length = 0;
  result.update('{"theme":"paper-light","layout":"justified"}');
  result.event('storage', {key: 'unrelated'});
  assert.deepEqual(result.dataset, {theme: 'warm-dark', layout: 'grid'});
  assert.equal(result.events.length, 0);
  result.event('storage', {key: preferenceKey});
  assert.deepEqual(result.dataset, {theme: 'paper-light', layout: 'justified'});
  assert.equal(result.meta.content, 'light');
  assert.deepEqual(result.events, [{type: 'album-appearance-change', theme: 'paper-light', layout: 'justified'}]);
  result.event('storage', {key: preferenceKey});
  assert.equal(result.events.length, 1, 'The same preferences do not trigger repeated album layout work');
});

test('clearing storage returns open pages to the default appearance', () => {
  const result = page('{"theme":"cool-blue","layout":"masonry"}');
  result.update(null);
  result.event('storage', {key: null});
  assert.deepEqual(result.dataset, {theme: 'warm-dark', layout: 'grid'});
  assert.equal(result.meta.content, 'dark');
});

test('back-forward restoration reads current saved preferences again', () => {
  const result = page('{"theme":"warm-dark","layout":"grid"}');
  result.events.length = 0;
  result.update('{"theme":"cool-blue","layout":"justified"}');
  result.event('pageshow', {persisted: true});
  assert.deepEqual(result.dataset, {theme: 'cool-blue', layout: 'justified'});
  assert.equal(result.meta.content, 'dark');
  assert.equal(result.events.length, 1);
});
