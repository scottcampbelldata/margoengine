import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalShader, surfaceTintPBR, transmissiveShader } from '../src/shader.ts';
import { instancedShader, rowsShader } from '../src/instanced-shader.ts';
import { wgslFunction } from '../../../tests/support/wgsl-eval.js';
import { wgslModule } from '../../materials/tests/support/wgsl-subset.js';

const source = surfaceTintPBR(transmissiveShader(physicalShader()));
function tint(matrix, { normal = [0, 0, 1], direction = [0, 0, -1], ior = 1.5, attenuation = [0.25, 0.5, 1] } = {}) {
  const shader = wgslModule(wgslFunction(source, 'margoVolumeTint'), {
    f: { eye: [0, 0, 0, 1], ext: [0, ior, attenuation[2], 0], coordsB: [0, 0, attenuation[0], attenuation[1]] },
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
