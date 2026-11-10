// Black-box value comparison only. No timings and no rival source inspection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arrange } from '../packages/ui/dist/index.js';
import { chain } from '../packages/ui/tests/layout-corpus.js';

const root = resolve(import.meta.dirname, '..');
const external = process.argv.find((a) => a.startsWith('--yoga='))?.slice(7);
assert.ok(external, 'Supply --yoga=<absolute external yoga-layout package directory>');
const folder = resolve(external);
const rel = relative(root, folder);
assert.ok(isAbsolute(external) && (rel.startsWith('..') || isAbsolute(rel)), 'Install the rival outside this repository');
const manifest = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'yoga-layout');
assert.equal(manifest.version, '3.2.1');
const { default: yoga } = await import(pathToFileURL(resolve(folder, manifest.main)).href);
const cases = [1, 4, 8].map((depth) => ({ name: `nested-${depth}`, tree: chain(depth).root, width: 200, height: 100 }));
const leaf = (width, extra = {}) => ({style: {width, height: 20, ...extra}, children: [], rect: {}});
cases.push({name: 'grow-max', width: 400, height: 100,
  tree: {style: {direction: 'row'}, rect: {}, children: [leaf(0, {grow: 1, maxWidth: 50}), leaf(0, {grow: 1})]}});
cases.push({name: 'shrink-min', width: 400, height: 100,
  tree: {style: {direction: 'row'}, rect: {}, children: [leaf(300, {minWidth: 280}), leaf(300)]}});
const results = [];
for (const {name, tree, width, height} of cases) {
  let margoMeasures = 0, rivalMeasures = 0;
  const config = yoga.Config.create();
  config.setPointScaleFactor(0);
  const build = (node) => {
    const y = yoga.Node.create(config);
    y.setFlexDirection(yoga.FLEX_DIRECTION_ROW);
    y.setAlignItems(yoga.ALIGN_CENTER);
    y.setFlexShrink(1);
    const s = node.style;
    for (const [field, method] of Object.entries({width: 'setWidth', height: 'setHeight', grow: 'setFlexGrow', minWidth: 'setMinWidth', maxWidth: 'setMaxWidth'}))
      if (s[field] !== undefined) y[method](s[field]);
    if (node.measure) {
      const measure = node.measure;
      node.measure = (w) => {margoMeasures++; return measure(w);};
      y.setMeasureFunc((w) => {rivalMeasures++; return measure(w);});
    }
    node.children.forEach((c, i) => y.insertChild(build(c), i));
    return y;
  };
  const yr = build(tree);
  try {
    arrange(tree, {x: 0, y: 0, width, height});
    yr.calculateLayout(width, height, yoga.DIRECTION_LTR);
    let nodes = 0;
    const compare = (node, yn, x = 0, y = 0) => {
      const r = yn.getComputedLayout();
      const expected = [r.left + x, r.top + y, r.width, r.height];
      const actual = [node.rect.x, node.rect.y, node.rect.width, node.rect.height];
      assert.deepEqual(actual, expected, `${name}, node ${nodes}`);
      nodes++;
      node.children.forEach((c, i) => compare(c, yn.getChild(i), expected[0], expected[1]));
    };
    compare(tree, yr);
    results.push({name, nodes, identicalRects: true, margoMeasures, rivalMeasures});
  } finally { yr.freeRecursive(); config.free(); }
}
console.log(JSON.stringify({rival: `${manifest.name}@${manifest.version}`, timing: 'pending quiet rerun', results}, null, 2));
