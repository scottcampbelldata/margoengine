// KHR_materials_ior allows ior 0: "Setting IOR to zero permanently switches the material into a special
// specular-glossiness backwards compatibility mode": an infinite index, Fresnel 1 at every angle, dispersion with no
// effect, and later updates of the value ignored. Material, materialLobes and transmission refused 0 (RangeError), so
// such a glTF material could not be made, and the loader's materials route threw on it with lobes or transmission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial, materialLobes, transmission } from '../dist/index.js';

test('Material takes ior 0 as the specular-glossiness mode and keeps it', () => {
  const material = new PbrMaterial({ ior: 0 });
  assert.equal(material.ior, 0);
  assert.ok(material.extensions.includes('ior'));
  material.ior = 1.5;
  assert.equal(material.ior, 0, 'the mode cannot be toggled');
  const plain = new PbrMaterial();
  plain.ior = 1.33;
  assert.equal(plain.ior, 1.33);
  assert.throws(() => (plain.ior = 0.5), RangeError);
  assert.throws(() => new PbrMaterial({ ior: -0.5 }), RangeError);
});

test('lobes and transmission take ior 0 as an infinite index', () => {
  const lobes = materialLobes({ ior: 0, specular: { factor: 1 } });
  // ((0 - 1) / (0 + 1))^2 = 1: the dielectric F0 the lobes start from.
  assert.match(lobes.declarations ?? '', /vec3f\(1\.0\)\*material\.specular\.rgb/);
  assert.throws(() => materialLobes({ ior: 0.5 }), RangeError);
  const glass = transmission({ factor: 1, ior: 0, opaqueColor: {} });
  // 1e30 in float32: F0 ((n - 1) / (n + 1))^2 rounds to 1 and 1 / n to 0, so no light leaves the far side.
  assert.equal(glass.factors[1], Math.fround(1e30));
  assert.throws(() => transmission({ factor: 1, ior: 0.5, opaqueColor: {} }), RangeError);
});
