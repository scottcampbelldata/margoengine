import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacyMToon } from '../src/mtoon-legacy.ts';
const bytes = readFileSync(new URL('../../../examples/assets/vrm/AliciaSolid_vrm-0.51.vrm', import.meta.url)),
  document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
const materials = document.extensions.VRM.materialProperties;
const expected = JSON.parse(
  readFileSync(
    new URL('../../../docs/whitepaper/results/batch213-mtoon-rival-latest-public-values.json', import.meta.url),
  ),
).rows;
function compare(actual, reference) {
  for (const [key, value] of Object.entries(reference)) {
    if (!(key in actual)) continue;
    if (Array.isArray(value)) {
      for (let k = 0; k < value.length; k++) assert.ok(Math.abs(actual[key][k] - value[k]) < 1e-12, key);
    } else if (typeof value === 'number') assert.ok(Math.abs(actual[key] - value) < 1e-12, key);
    else assert.deepEqual(actual[key], value, key);
  }
}
test('all real Alicia migration constants match current public-loader observations', () => {
  for (const material of materials) {
    const before = structuredClone(material),
      value = legacyMToon(material),
      reference = expected.find((row) => row.name === material.name);
    assert.ok(reference);
    compare(value.definition, reference);
    assert.deepEqual(material, before);
  }
});
test('controlled legacy transition, colour, GI, outline and UV controls match current public-loader observations', () => {
  const material = structuredClone(materials[0]);
  Object.assign(material.floatProperties, {
    _OutlineWidthMode: 2,
    _OutlineWidth: 0.123,
    _UvAnimScrollX: 0.2,
    _UvAnimScrollY: 0.3,
    _UvAnimRotation: 0.75,
    _ShadeShift: -0.6,
    _ShadeToony: 0.4,
    _IndirectLightIntensity: 0.37,
    _RimFresnelPower: 2.7,
    _RimLift: -0.1,
  });
  material.vectorProperties._RimColor = [0.2, 0.5, 0.8, 1];
  compare(
    legacyMToon(material).definition,
    JSON.parse(
      readFileSync(
        new URL('../../../docs/whitepaper/results/batch213-mtoon-rival-controlled-public-values.json', import.meta.url),
      ),
    ).rows[0],
  );
});
test('legacy colour constants retain gamma-2.2 conversion and HDR emission', () => {
  const material = structuredClone(materials[0]);
  material.vectorProperties._Color = [0.2, 0.5, 0.8, 0.7];
  material.vectorProperties._EmissionColor = [2, 0.5, 0.25, 1];
  const value = legacyMToon(material),
    row = JSON.parse(
      readFileSync(
        new URL('../../../docs/whitepaper/results/batch213-mtoon-rival-base-public-values.json', import.meta.url),
      ),
    ).rows[0];
  assert.deepEqual(value.base, [...row.color, row.opacity]);
  assert.deepEqual(value.emission, row.emissive);
});

test('legacy queue defaults and post-conversion numeric limits are explicit', () => {
  const material = structuredClone(materials[0]);
  material.renderQueue = -1;
  assert.equal(legacyMToon(material).queue, 2000);
  material.vectorProperties._EmissionColor = [1e38, 0, 0, 1];
  assert.throws(() => legacyMToon(material), RangeError);
});
