// The merge gate's coupling guard: a framework solver with no coupling-harness test is refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { solversIn, unguarded } from '../scripts/check-coupling.mjs';

test('finds the solvers a source declares', () => {
  assert.deepEqual(
    solversIn(`
export class Ocean implements Solver<OceanParams> { describe() {} }
class Helper {}
export const wind: Solver = make();
const sail = { describe } satisfies Solver;
const other: SolverHost = host;`),
    ['Ocean', 'wind', 'sail'],
  );
});

test('a solver passes only when a test that runs the harness names it', () => {
  const sources = [['packages/ocean/src/ocean.ts', 'export class Ocean implements Solver {}']];
  assert.deepEqual(unguarded(sources, []), ['packages/ocean/src/ocean.ts: Ocean']);
  assert.deepEqual(unguarded(sources, [['t.test.js', "import { Ocean } from '../dist/index.js';"]]), [
    'packages/ocean/src/ocean.ts: Ocean',
  ]);
  assert.deepEqual(
    unguarded(sources, [
      ['t.test.js', "import { seekEqualsContinuous } from '../../../physics/tests/coupling/harness.js';\nnew Ocean();"],
    ]),
    [],
  );
  assert.deepEqual(
    unguarded(sources, [['t.test.js', "import { seekEqualsContinuous } from './harness.js';\nnew OceanWaves();"]]),
    ['packages/ocean/src/ocean.ts: Ocean'],
    'a longer name that contains it does not count',
  );
});
