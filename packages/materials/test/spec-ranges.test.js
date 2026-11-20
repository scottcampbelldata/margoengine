// Values the glTF extensions allow, and float32 overflow the uniforms would carry as Infinity or NaN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial, packGeometry } from '../dist/index.js';

// KHR_materials_specular: specularColorFactor has no maximum ("allowed to be set to values greater than [1, 1, 1]");
// the shader clamps F0 to 1. The setter capped each component at 1, so such a material could not be made.
test('specularColor takes components above 1, as KHR_materials_specular allows', () => {
  const material = new PbrMaterial({ specularColor: [2, 4, 25] });
  assert.deepEqual(material.specularColor, [2, 4, 25]);
  assert.ok(material.extensions.includes('specular'));
  material.specularColor = '#ffffff';
  assert.deepEqual(material.specularColor, [1, 1, 1]);
  assert.throws(() => (material.specularColor = [-1, 0, 0]), RangeError);
  assert.throws(() => (material.specularColor = [1e39, 0, 0]), RangeError);
});

// KHR_materials_iridescence: "The iridescenceThicknessMinimum value MAY be greater than iridescenceThicknessMaximum".
test('iridescenceThicknessRange takes a minimum above the maximum', () => {
  const material = new PbrMaterial({ iridescence: 1, iridescenceThicknessRange: [400, 100] });
  assert.deepEqual(material.iridescenceThicknessRange, [400, 100]);
  assert.throws(() => (material.iridescenceThicknessRange = [-1, 100]), RangeError);
  assert.throws(() => (material.iridescenceThicknessRange = [100, -1]), RangeError);
});

// A plane with a tiny normal is normalised by dividing d by |n|: [1e-30, 0, 0, 1e10] gave d = 1e40, Infinity in the
// float32 uniform, so the shader compared against Infinity and NaN.
test('a clipping plane whose normalised distance overflows float32 is refused', () => {
  const material = new PbrMaterial();
  assert.throws(() => (material.clippingPlanes = [[1e-30, 0, 0, 1e10]]), RangeError);
  material.clippingPlanes = [[1e-30, 0, 0, 1e-31]];
  assert.ok(Math.abs(material.clippingPlanes[0][3] - 0.1) < 1e-9);
});

// A NaN tangent has a NaN length, which read as "no tangent", so the mesh drew with a zero frame instead of refusing.
test('packGeometry refuses NaN tangents like every other attribute', () => {
  const base = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  };
  assert.throws(() => packGeometry({ ...base, tangents: [Number.NaN, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1] }), RangeError);
  assert.throws(() => packGeometry({ ...base, tangents: [1, 0, 0, Number.NaN, 1, 0, 0, 1, 1, 0, 0, 1] }), RangeError);
  const none = packGeometry({ ...base, tangents: new Float32Array(12) });
  assert.deepEqual([...none.vertices.subarray(8, 12)], [0, 0, 0, 0]);
});

// glTF COLOR_0 may be UNSIGNED_SHORT normalised. Only Uint8 colours were scaled, so a Uint16Array packed 65535 as the
// colour, which the shader multiplied into base colour 65535 times too bright.
test('packGeometry normalises Uint16Array colours like glTF UNSIGNED_SHORT', () => {
  const base = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
  const p = packGeometry({ ...base, colors: new Uint16Array([65535, 0, 32768, 65535, 0, 65535, 0, 0, 0, 0, 0, 0]) });
  assert.deepEqual([...p.vertices.slice(16, 20)], [1, 0, Math.fround(32768 / 65535), 1]);
  assert.deepEqual([...p.vertices.slice(36, 40)], [0, 1, 0, 0]);
});
