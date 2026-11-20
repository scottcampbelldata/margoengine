// A clone or copy holds its features as a material of its own. clone() shared the feature list without joining it, so
// an eye's user count missed the clone (the clone leaving freed the original's buffers) and alphaHash's raised
// alphaTest stayed on a clone after the feature left; copy() spliced into the frozen feature list and threw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial } from '../dist/index.js';
import { alphaHash } from '../dist/alpha-hash.js';
import { eye } from '../dist/eye.js';

test('a clone that drops alphaHash gives back its alphaTest like the original', () => {
  const hash = alphaHash({ cutoff: 0.4 }),
    material = new PbrMaterial({ features: [hash] });
  assert.ok(Math.abs(material.alphaTest - 0.4) < 1e-7);
  const clone = material.clone();
  clone.features = [];
  assert.equal(clone.alphaTest, 0, 'the clone gives back the alphaTest the feature raised');
  material.features = [];
  assert.equal(material.alphaTest, 0);
});

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

test("a clone that drops an eye leaves the original's eye buffers alone", () => {
  const destroyed = [],
    device = {
      createBuffer: () => ({ destroy: () => destroyed.push(1) }),
      queue: { writeBuffer() {} },
    },
    feature = eye(),
    material = new PbrMaterial({ features: [feature] });
  feature.bindings(device);
  const clone = material.clone();
  clone.features = [];
  assert.equal(destroyed.length, 0, 'the original still draws the eye');
  material.features = [];
  assert.equal(destroyed.length, 1, 'the last user frees it');
});

test('copy() takes the source features and their state, and lets go of its own', () => {
  const hash = alphaHash({ cutoff: 0.3 }),
    source = new PbrMaterial({ features: [hash] }),
    target = new PbrMaterial({ features: [alphaHash({ cutoff: 0.6 })] });
  target.copy(source);
  assert.deepEqual(target.features, [hash]);
  assert.ok(Math.abs(target.alphaTest - 0.3) < 1e-7);
  target.features = [];
  assert.equal(target.alphaTest, 0, 'the copy gives back the alphaTest the feature raised');
  const plain = new PbrMaterial({ features: [alphaHash()] });
  plain.copy(new PbrMaterial());
  assert.deepEqual([plain.features, plain.alphaTest], [[], 0]);
});
