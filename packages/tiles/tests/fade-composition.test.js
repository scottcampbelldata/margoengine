import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesFade } from '../dist/fade.js';
const make = () => ({ parent: null, children: [], refine: 'REPLACE', renderable: { visible: false } });
test('fade updates both a layered highlight copy and its saved extension, including after disposal', async () => {
  let time = 0,
    select;
  const root = make(),
    child = make();
  child.parent = root;
  root.children = [child];
  const renderer = {
    tileset: {
      root,
      on(_event, fn) {
        select = fn;
        return () => {};
      },
    },
    last: { selected: [] },
  };
  const fade = new TilesFade({ duration: 1, clock: () => time }).attach(renderer),
    primitive = { extension: undefined };
  await fade.decorate({ kind: 'model', tile: root, model: { primitives: [primitive] }, content: {} });
  await fade.decorate({ kind: 'points', tile: child, cloud: { material: {} }, content: {} });
  select({ selected: [root] });
  const saved = primitive.extension;
  primitive.extension = { ...saved, factors: saved.factors.slice() };
  select({ selected: [child] });
  time = 0.5;
  select({ selected: [child] });
  assert.deepEqual([...saved.factors.subarray(0, 2)], [0.5, 1]);
  assert.deepEqual([...primitive.extension.factors.subarray(0, 2)], [0.5, 1]);
  fade.dispose();
  primitive.extension = saved;
  assert.deepEqual([...primitive.extension.factors.subarray(0, 2)], [0, 1]);
});
test('pending preceding decoration is released if fade is disposed, and tile cleanup is idempotent', async () => {
  let finish,
    released = 0;
  const pending = new Promise((resolve) => (finish = resolve)),
    fade = new TilesFade({ decorate: () => pending }),
    tile = make();
  const work = fade.decorate({ kind: 'model', tile, model: { primitives: [] }, content: {} });
  fade.dispose();
  finish({
    bytes: 0,
    dispose() {
      released++;
    },
  });
  await assert.rejects(work, /disposed/);
  assert.equal(released, 1);
  const other = new TilesFade({
    decorate: () => ({
      bytes: 0,
      dispose() {
        released++;
      },
    }),
  });
  const decoration = await other.decorate({ kind: 'model', tile, model: { primitives: [] }, content: {} });
  decoration.dispose();
  decoration.dispose();
  assert.equal(released, 2);
  other.dispose();
});
