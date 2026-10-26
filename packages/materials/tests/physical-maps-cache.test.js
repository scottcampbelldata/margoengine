// gltf-pro derives each material's shader every frame (draw-memo.ts), so the physical-maps specialization must not
// rebuild its text each time: regular expressions over the whole PBR shader were 28% of a 400-sphere physical frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalMapsShader } from '../src/physical-maps.ts';
import { physicalShader } from '../../gltf-pro/src/shader.ts';

test('the physical-maps shader is derived once per source and slot plan', () => {
  const source = physicalShader(),
    slots = Array.from({ length: 18 }, (_, k) => (k === 0 ? [0, 0] : null)),
    first = physicalMapsShader(source, 2, slots);
  // A cached derivation edits no text: count the string edits of a second call.
  const { replace, replaceAll } = String.prototype;
  let edits = 0;
  String.prototype.replace = function (...args) {
    edits++;
    return replace.apply(this, args);
  };
  String.prototype.replaceAll = function (...args) {
    edits++;
    return replaceAll.apply(this, args);
  };
  let again;
  try {
    again = physicalMapsShader(source, 2, slots.slice());
  } finally {
    String.prototype.replace = replace;
    String.prototype.replaceAll = replaceAll;
  }
  assert.equal(again, first);
  assert.equal(edits, 0, 'the second call reuses the first derivation');
  const other = physicalMapsShader(source, 2, slots.map((slot, k) => (k === 4 ? [1, 0] : slot)));
  assert.notEqual(other, first, 'another slot plan derives its own');
  assert.match(other, /margoPhysicalMap1/);
  assert.notEqual(physicalMapsShader(source, 3, slots), first, 'another group derives its own');
});
