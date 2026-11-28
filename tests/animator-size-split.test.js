// KB-SIZE-SPLINEANATOMY1: spline IK moves no limb, so its bundle must not carry the anatomical limb solver. It did
// (2,826 to 6,390 B gzip at c17577b174) while the limb tools shared a closure with the world-space bone tools.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bundleBytes } from '../scripts/measure-size.js';

const bundle = async (name) =>
  String(await bundleBytes(fileURLToPath(new URL(`../packages/animator/dist/${name}.js`, import.meta.url))));
// A message only solveLimbIK throws; minifying keeps string literals.
const LIMB_SOLVER = 'solveLimbIK needs a hinge with a range';

test('spline IK carries none of the anatomical limb solver; the solvers that move limbs do', async () => {
  assert.ok(!(await bundle('spline-ik')).includes(LIMB_SOLVER), 'spline-ik bundles solveLimbIK again');
  for (const name of ['warping', 'fbik']) assert.ok((await bundle(name)).includes(LIMB_SOLVER), `${name}: no marker`);
});
