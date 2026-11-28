import assert from 'node:assert/strict';
import test from 'node:test';
import { panorama } from '../panorama.js';

const at = ({ width, data }, x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3));

test('an outdoor sky has no workshop panels: every azimuth of a row reflects the same light (KB-FILM-ENVPANELS1)', () => {
  const sky = { zenith: [0.11, 0.065, 0.04], horizon: [0.2, 0.115, 0.065], ground: [0.018, 0.016, 0.016] };
  const map = panorama(true, sky);
  for (const y of [8, 60, 110, 127, 140, 200]) {
    const first = at(map, 0, y);
    for (let x = 0; x < map.width; x += 7) assert.deepEqual(at(map, x, y), first);
  }
  // Warm overhead like the overcast it stands for, dark below the skyline.
  const top = at(map, 0, 0),
    bottom = at(map, 0, map.height - 1);
  assert.ok(top[0] > top[2] * 2, 'the overcast reflects orange, never the workshop blue');
  assert.ok(bottom[0] < 0.03);
});

test('the workshop panorama keeps its panels for the films shot on the set', () => {
  const map = panorama(true);
  const row = 256 * (0.5 - 0.32 / Math.PI) | 0,
    values = Array.from({ length: map.width }, (_, x) => at(map, x, row)[2]);
  assert.ok(Math.max(...values) > 4 * Math.min(...values));
});
