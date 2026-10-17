import test from 'node:test';
import assert from 'node:assert/strict';
import { Material } from '../dist/index.js';

test('Material side selects a single live face mode and preserves the doubleSided alias', () => {
  const material = new Material({ side: 'back', doubleSided: true });
  assert.equal(material.side, 'back');
  assert.equal(material.settings[2], 2);
  assert.equal(material.doubleSided, false);
  material.side = 'double';
  assert.equal(material.settings[2], 1);
  assert.equal(material.doubleSided, true);
  material.side = 'front';
  assert.equal(material.settings[2], 0);
  material.side = 'back';
  material.doubleSided = true;
  assert.equal(material.side, 'double');
  material.doubleSided = false;
  assert.equal(material.side, 'front');
  material.settings[2] = 2;
  assert.equal(material.side, 'back');
});

test('Material side defaults to the legacy doubleSided option', () => {
  assert.equal(new Material().side, 'front');
  assert.equal(new Material({ doubleSided: false }).side, 'front');
  assert.equal(new Material({ doubleSided: true }).side, 'double');
  assert.equal(new Material({ side: 'front', doubleSided: true }).doubleSided, false);
});

test('Material validates side without silently accepting an invalid legacy option', () => {
  for (const side of ['outside', '', null, 0, true]) assert.throws(() => new Material({ side }), TypeError);
  assert.throws(() => new Material({ side: 'back', doubleSided: 'true' }), TypeError);
  const material = new Material({ side: 'back' });
  for (const side of ['outside', undefined, null, 2, false]) {
    assert.throws(() => {
      material.side = side;
    }, TypeError);
    assert.equal(material.side, 'back');
  }
});
