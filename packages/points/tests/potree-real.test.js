// Real PotreeConverter output: parts of the sample folders of the Potree repository (tests/fixtures/NOTICE.md). The whole
// folders, and a real BROTLI folder that cannot ship here, run through tests/potree-check.mjs (docs/whitepaper/reproduce.md).
// Each cloud.js is JSON despite its name, so it is stored as cloud.js.json, out of reach of the JavaScript lint.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PotreeSource } from '../dist/potree.js';

const signal = new AbortController().signal,
  folder = (name) => async (url) => {
    try {
      const file = String(url).slice(1).replace(/^cloud.js$/, 'cloud.js.json');
      return new Response(await readFile(new URL(`fixtures/potree/${name}/${file}`, import.meta.url)));
    } catch {
      return new Response('', { status: 404 });
    }
  },
  named = (source, name) => {
    let node = source.root;
    for (const digit of name.slice(1)) {
      const index = Number(digit);
      node = node.children[((index >> 2) & 1) | (index & 2) | ((index & 1) << 2)];
    }
    return node;
  },
  inside = (node, data) => {
    const b = node.bounds,
      pad = (b[3] - b[0]) * 1e-3;
    assert.equal(data.positions.length, node.count * 3);
    for (let i = 0; i < node.count; i++)
      for (let a = 0; a < 3; a++) {
        const v = data.positions[i * 3 + a];
        assert.ok(v >= b[a] - pad && v <= b[a + 3] + pad, `point ${i} of ${node.id} in its cube`);
      }
  };

test('Potree 1.7: leaves the hierarchy lists with 0 points read every point of their files', async () => {
  const source = await PotreeSource.open('/cloud.js', { fetch: folder('lion-1.7') });
  assert.equal(source.version, '1.7');
  for (const [name, count] of [['r', 10548], ['r5', 2219], ['r10', 19], ['r11', 2]]) {
    const node = named(source, name);
    inside(node, await source.load(node, signal));
    assert.equal(node.count, count, name);
  }
});

test('Potree 1.4: LAZ nodes in one folder, with the hierarchy in cloud.js, and no reader passed', async () => {
  const source = await PotreeSource.open('/cloud.js', { fetch: folder('lion-1.4-laz') });
  assert.equal(source.version, '1.4');
  for (const [name, count] of [['r', 5202], ['r5', 124], ['r7', 36]]) {
    const node = named(source, name);
    assert.equal(node.count, count);
    const data = await source.load(node, signal);
    inside(node, data);
    assert.equal(data.attributes.intensity.length, count);
  }
});
