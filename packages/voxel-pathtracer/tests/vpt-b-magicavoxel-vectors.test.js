// MagicaVoxel dictionaries with short or empty vector values (audit vpt-b, 2026-11-24): a `_focus` or `_angle` with
// fewer than three numbers gave a camera of NaN, and an empty `_inf _angle` put the sun on the horizon instead of at
// the default 50, 50. Missing components now take the key's default, as a missing key does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { magicaVoxelCamera, magicaVoxelLighting } from '../dist/index.js';

const finite = (v) => v.every(Number.isFinite);

test('a short rCAM _focus or _angle keeps the camera finite, the missing parts at their defaults', () => {
  const short = magicaVoxelCamera({ _focus: '1 2', _angle: '30', _radius: '50' }),
    full = magicaVoxelCamera({ _focus: '1 2 0', _angle: '30 0 0', _radius: '50' });
  for (const k of ['position', 'target', 'up']) {
    assert.ok(finite(short[k]), `${k} ${short[k]}`);
    assert.deepEqual(short[k], full[k]);
  }
  const iso = magicaVoxelCamera({ _mode: 'iso', _angle: '10' });
  assert.ok(finite(iso.position) && finite(iso.up));
});

test('an empty or short _inf _angle reads the missing angles as the default 50, 50', () => {
  const sun = (angle) =>
    magicaVoxelLighting([{ _type: '_inf', ...(angle === undefined ? {} : { _angle: angle }) }]).environment
      .sunDirection;
  assert.deepEqual(sun(''), sun(undefined));
  assert.deepEqual(sun('50'), sun(undefined));
  assert.deepEqual(sun('30'), sun('30 50'));
});
