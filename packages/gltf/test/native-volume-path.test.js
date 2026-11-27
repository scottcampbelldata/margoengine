import test from 'node:test';
import assert from 'node:assert/strict';
import { extendedPlan, extendedShader, physicalShader, surfaceTintPBR, transmissiveShader } from '../src/shader.ts';
import { extendedMaterials } from '../dist/extended.js';
import { instancedShader, rowsShader } from '../src/instanced-shader.ts';
import { wgslFunction } from '../../../tests/support/wgsl-eval.js';
import { wgslModule } from '../../materials/tests/support/wgsl-subset.js';

const source = surfaceTintPBR(transmissiveShader(physicalShader()));
function tint(
  matrix,
  {
    normal = [0, 0, 1],
    direction = [0, 0, -1],
    ior = 1.5,
    attenuation = [0.25, 0.5, 1],
    opticalDepth = attenuation.map((c) => -Math.log(c)),
    thicknessTexel,
  } = {},
) {
  const depth = opticalDepth.map((c) => (c === Infinity ? -1 : c));
  // A thickness map's texel (G) stands in for the sample of extendedShader's margoThickness.
  const thickness =
    thicknessTexel === undefined
      ? wgslFunction(source, 'margoThickness')
      : `fn margoThickness(i:Out)->f32 {return ${thicknessTexel.toFixed(6)};}`;
  const shader = wgslModule(`${thickness}\n${wgslFunction(source, 'margoVolumeTint')}`, {
    f: { eye: [0, 0, 0, 1], ext: [0, ior, depth[2], 0], coordsB: [0, 0, depth[0], depth[1]] },
  });
  return shader.call('margoVolumeTint', { position: direction, normal }, { n: normal }, matrix);
}
const matrix = (x, y, z) => [
  [x, 0, 0],
  [0, y, 0],
  [0, 0, z],
];
const close = (a, b) => a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 2e-6, `${a} != ${b}`));

test('native volume attenuation converts mesh thickness to world length', () => {
  for (const scale of [0.25, 0.5, 1, 1.5, 2]) {
    close(tint(matrix(scale, scale, scale)), [0.25 ** scale, 0.5 ** scale, 1]);
  }
});

test('native volume exponentiates after a world scale recovers an underflowed mesh-space tint', () => {
  for (const thickness of [200, 1200])
    close(
      tint(matrix(1, 1, 1 / thickness), { opticalDepth: [Math.log(4) * thickness, Math.log(2) * thickness, 0] }),
      [0.25, 0.5, 1],
    );
});

test('native volume attenuation follows a refracted slab path, including rotations, shear and reflection', () => {
  const direction = [0.6, 0, -0.8];
  const depth = 4 / Math.sqrt(1 - (0.6 / 1.5) ** 2);
  const expected = [0.25 ** depth, 0.5 ** depth, 1];
  for (const m of [
    matrix(2, 3, 4),
    matrix(-2, 3, 4),
    [
      [2, 0, 0],
      [1, 3, 0],
      [0.5, 0.25, 4],
    ],
  ])
    close(tint(m, { direction }), expected);
  close(
    tint(
      [
        [0, 0, -2],
        [0, 3, 0],
        [4, 0, 0],
      ],
      { normal: [1, 0, 0], direction: [-0.8, 0, -0.6] },
    ),
    expected,
  );
});

test('white and black channels and a grazing index-matched ray retain their limits', () => {
  close(tint(matrix(1, 1, 1), { attenuation: [0, 1, 0.5] }), [0, 1, 0.5]);
  close(tint(matrix(1, 1, 1), { ior: 1, direction: [1, 0, 0], attenuation: [0.5, 1, 0] }), [0, 1, 0]);
});

test('native volume tint uses each instance transform; whole-uniform retention prevents row batching', () => {
  const instanced = surfaceTintPBR(instancedShader(transmissiveShader(physicalShader())));
  assert.match(instanced, /o\.volume0=margoI\[0\]\.xyz/);
  assert.match(instanced, /margoVolumeTint\(i,s,mat3x3f\(i\.volume0,i\.volume1,i\.volume2\)\)/);
  assert.doesNotMatch(instanced, /margoVolumeTint\(i,s,mat3x3f\(f\.model/);
  const rows = rowsShader(instanced, 16);
  assert.equal(rows, undefined, 'texture-dependent tint retains the whole material uniform');
});

test('KHR_materials_volume thicknessTexture: its G channel scales thicknessFactor in the native tint (KB4000)', () => {
  // thickness = thicknessFactor x thicknessTexture.g: a texel of 0.5 at factor 2 attenuates as factor 1 does.
  for (const texel of [0.25, 0.5, 1])
    close(tint(matrix(1, 1, 1), { opticalDepth: [Math.log(4) * 2, Math.log(2) * 2, 0], thicknessTexel: texel }), [
      0.25 ** (2 * texel),
      0.5 ** (2 * texel),
      1,
    ]);
  // A texel of 0 is a thin wall: nothing attenuates, an opaque (black) channel included; any thickness keeps it black.
  close(tint(matrix(1, 1, 1), { attenuation: [0, 0.5, 1], thicknessTexel: 0 }), [1, 1, 1]);
  close(tint(matrix(1, 1, 1), { attenuation: [0, 0.5, 1], thicknessTexel: 0.01 }), [0, 0.5 ** 0.01, 1]);
});

test('a transmissive volume with a thicknessTexture binds slot 20 and the native tint samples its G channel', () => {
  const thicknessTexture = { index: 3 };
  const parsed = extendedMaterials.parse({
    KHR_materials_transmission: { transmissionFactor: 1 },
    KHR_materials_volume: {
      thicknessFactor: 2,
      thicknessTexture,
      attenuationColor: [0.5, 0.5, 0.5],
      attenuationDistance: 1,
    },
  });
  assert.ok(parsed, 'a thickness map needs the extended shader, which binds slot 20');
  assert.equal(parsed.maps[7], thicknessTexture);
  assert.deepEqual(
    Object.values(parsed.features).filter(Boolean),
    [],
    'no other extended feature switches on for a thickness map',
  );
  // Without transmission no volume is entered, so no map binds (diffuse transmission without scatter reads none).
  assert.equal(extendedMaterials.parse({ KHR_materials_volume: { thicknessFactor: 2, thicknessTexture } }), undefined);
  const maps = Array.from({ length: 21 }, (_, k) => (k === 20 ? thicknessTexture : undefined));
  const plan = extendedPlan(maps, parsed.features);
  const shader = surfaceTintPBR(transmissiveShader(extendedShader(plan)));
  const slot = plan.slots[20];
  assert.ok(slot >= 0);
  assert.ok(
    wgslFunction(shader, 'margoThickness').includes(
      `return textureSample(margoMap${slot},margoSampler${slot},uv(i,20)).g;`,
    ),
  );
  assert.equal(shader.split('fn margoThickness(').length, 2, 'one margoThickness: the default is not added');
  // The physical shader without slot 20 reads the factor alone.
  assert.match(wgslFunction(source, 'margoThickness'), /return 1\.0;/);
  // KB4000 step 4: the transmission pass's volume path (thicknessFactor x s.th) takes the map's G too; s.th was fixed at 1,
  // so the pass absorbed through the whole factor where the map thins it (AttenuationTest's Thickness Texture row).
  assert.ok(
    extendedShader(plan).includes(`s.th=textureSample(margoMap${slot},margoSampler${slot},uv(i,20)).g;`),
    'the surface thickness reads the map',
  );
  const unmapped = extendedPlan([], { iridescence: true });
  assert.ok(extendedShader(unmapped).includes('s.th=vec4f(1).g;'), 'without a map the thickness is 1');
});
