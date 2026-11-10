import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMargoObjects, loadMargoObjects, parseMargoObjects } from '../dist/objects.js';
import { accessor, objectWorlds } from './object-truth.js';

const source = await readFile(new URL('./fixtures/objects.margo', import.meta.url));
const truth = JSON.parse(await readFile(new URL('./fixtures/objects-truth.json', import.meta.url), 'utf8'));

test('object actions keep parents, hidden empty pivots, constraints, parent inverse and negative scale', () => {
  const asset = decodeMargoObjects(source), { document } = asset;
  assert.equal(typeof loadMargoObjects, 'function');
  assert.equal(typeof parseMargoObjects, 'function');
  assert.deepEqual(document.animations.map(a => a.name).sort(), Object.keys(truth.clips).sort());
  for (const [name, parent] of Object.entries(truth.parents)) {
    const id = document.nodes.findIndex(n => n.name === name);
    const found = document.nodes.find(n => n.children?.includes(id))?.name ?? null;
    assert.equal(found, parent, name);
  }
  assert.equal(document.nodes.find(n => n.name === 'Child').extras.margo.properties['margo:label'], 'kept');
  let worst = 0, compared = 0;
  for (const clip of document.animations) {
    for (const sampler of clip.samplers) assert.ok(accessor(asset, sampler.input).every(Number.isFinite));
    for (const [frame, expected] of truth.clips[clip.name].entries()) {
      const worlds = objectWorlds(asset, clip, frame / 24);
      for (const [name, matrix] of Object.entries(expected)) {
        const actual = worlds.get(name);
        assert.ok(actual, name);
        matrix.forEach((value, i) => { worst = Math.max(worst, Math.abs(value - actual[i])); compared++; });
      }
    }
  }
  assert.ok(compared >= 1728);
  assert.ok(worst < 3e-6, `largest world matrix error from Blender ${worst}`);
});
