import assert from 'node:assert/strict';
import test from 'node:test';
import { PlantMotion } from '../dist/plant-motion.js';

const root = (x, z, height = 1) => ({ xz: [x, z], height });
const options = { origin: [-0.5, -0.5], cellSize: 1, readSway: () => new Float64Array(26) };

test('PlantMotion refuses ambiguous root bindings and accepts sites straddling a cell boundary', () => {
  assert.throws(() => new PlantMotion({ ...options, roots: [root(-0.4, 0.2), root(0.4, -0.2)] }), /one root per cell/);
  assert.throws(() => new PlantMotion({ ...options, roots: [root(0, 0, 0)] }), /height/);
  assert.throws(() => new PlantMotion({ ...options, origin: [Infinity, 0], roots: [root(0, 0)] }), /origin/);
  const motion = new PlantMotion({ ...options, roots: [root(-0.50001, 0), root(-0.49999, 0)] });
  motion.dispose();
});
