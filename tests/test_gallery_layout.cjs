/* Pure geometry checks; no browser, photo directory or backend is required. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'gallery-layout.js'), 'utf8'), context);
const {ratioOf, masonry, justified} = context.albumLayouts;
const epsilon = 1e-7;

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), message);
}

function verifyGeometry(result, items, width) {
  assert.equal(result.positions.length, items.length, 'Every input photo keeps its position in the result array');
  assert.ok(Number.isFinite(result.height) && result.height >= 0, 'The gallery has a finite nonnegative height');
  const boxes = result.positions.map((position, index) => {
    for (const property of ['left', 'top', 'width', 'mediaHeight']) {
      assert.ok(Number.isFinite(position[property]), `Photo ${index} has finite ${property}`);
    }
    assert.ok(position.left >= -epsilon && position.top >= -epsilon, 'A photo starts inside the gallery');
    assert.ok(position.width > 0 && position.mediaHeight > 0, 'Photo dimensions remain positive');
    assert.ok(position.left + position.width <= width + epsilon, 'A photo stays inside the viewport width');
    close(position.width / position.mediaHeight, ratioOf(items[index].ratio), 'The input sequence and image proportions are preserved');
    if (index) assert.ok(position.top + epsilon >= result.positions[index - 1].top, 'Later photos do not jump ahead of previous rows');
    const footer = Number(items[index].footerHeight);
    const bottom = position.top + position.mediaHeight + (Number.isFinite(footer) && footer >= 0 ? footer : 0);
    assert.ok(bottom <= result.height + epsilon, 'The gallery reserves room for the caption');
    return {...position, right: position.left + position.width, bottom};
  });
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const horizontal = Math.min(boxes[a].right, boxes[b].right) - Math.max(boxes[a].left, boxes[b].left);
      const vertical = Math.min(boxes[a].bottom, boxes[b].bottom) - Math.max(boxes[a].top, boxes[b].top);
      assert.ok(horizontal <= epsilon || vertical <= epsilon, `Photo and caption boxes ${a} and ${b} do not overlap`);
    }
  }
}

test('missing or unusable proportions fall back to 4:3', () => {
  for (const value of [undefined, null, '', 0, -1, NaN, Infinity, -Infinity, 'unknown']) close(ratioOf(value), 4 / 3);
  close(ratioOf('1.5'), 1.5);
  close(ratioOf(1 / 40), 1 / 40);
});

test('empty groups reserve no space', () => {
  for (const result of [masonry([], 320, 19, 216), justified([], 320, 19, 220)]) {
    assert.equal(result.positions.length, 0);
    assert.equal(result.height, 0);
  }
});

const ratios = [4 / 3, 2 / 3, 1, 16 / 9, 3 / 4, 40, 1 / 40, undefined, 0, NaN];
const mixed = Array.from({length: 67}, (_, index) => ({ratio: ratios[index % ratios.length], footerHeight: [24, 39, 58][index % 3]}));
for (const width of [284, 320, 375, 760, 1160, 1900]) {
  test(`mixed images fit a ${width}px gallery in both layouts`, () => {
    const before = structuredClone(mixed);
    verifyGeometry(masonry(mixed, width, 19, 216), mixed, width);
    verifyGeometry(justified(mixed, width, 19, 220), mixed, width);
    assert.deepEqual(mixed, before, 'Layout does not modify the catalog or caption data');
  });
}

test('masonry includes different caption heights when choosing the next column', () => {
  const items = [{ratio: 1, footerHeight: 140}, {ratio: 1, footerHeight: 15}, {ratio: 1, footerHeight: 30}];
  const result = masonry(items, 500, 20, 216);
  verifyGeometry(result, items, 500);
  close(result.positions[2].left, result.positions[1].left);
  assert.ok(result.positions[2].top >= result.positions[1].mediaHeight + items[1].footerHeight + 20);
});

test('a short final row is not enlarged to fill the gallery', () => {
  for (const items of [[{ratio: 0.5, footerHeight: 35}], [{ratio: 0.75, footerHeight: 35}, {ratio: 1.25, footerHeight: 40}]]) {
    const result = justified(items, 1160, 19, 220);
    verifyGeometry(result, items, 1160);
    for (const position of result.positions) close(position.mediaHeight, 220);
    const last = result.positions.at(-1);
    assert.ok(last.left + last.width < 1160, 'Unused last-row space remains empty');
  }
  const items = Array.from({length: 5}, () => ({ratio: 1, footerHeight: 30}));
  const result = justified(items, 600, 20, 200);
  verifyGeometry(result, items, 600);
  assert.ok(result.positions.at(-1).top > 0, 'The fixture contains more than one row');
  close(result.positions.at(-1).mediaHeight, 200);
});

test('a very wide final image shrinks to the available width', () => {
  const items = [{ratio: 40, footerHeight: 35}];
  const result = justified(items, 320, 19, 220);
  verifyGeometry(result, items, 320);
  close(result.positions[0].width, 320);
  assert.ok(result.positions[0].mediaHeight < 220);
});

test('very narrow images cannot create a row with more gaps than available space', () => {
  const items = Array.from({length: 36}, () => ({ratio: 0.0001, footerHeight: 35}));
  for (const width of [320, 375, 1160]) verifyGeometry(justified(items, width, 19, 220), items, width);
});
