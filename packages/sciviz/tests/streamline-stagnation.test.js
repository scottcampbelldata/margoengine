import test from 'node:test';
import assert from 'node:assert/strict';
import { streamline } from '@margoengine/sciviz/maths';

// Analytical sink dx/dt=-x, dy/dt=-y: a positive x seed approaches zero monotonically and never crosses it.
// The normalized direction is discontinuous at the sink; fixed arc-length RK4 must not publish a zero-progress
// step repeatedly or a spurious orbit. This regression is deliberately failing in the job 3 checkpoint.
test('streamline approaching an analytical stagnation point terminates without repeated or reversed steps', () => {
  const line = streamline({ dims: [2, 2, 1], bounds: [-1, 1, -1, 1, 0, 0],
    u: [1, -1, 1, -1], v: [1, 1, -1, -1] }, [0.13, 0, 0],
    { step: 0.1, maxSteps: 100, minSpeed: 1e-9, direction: 'forward' });
  for (let i = 3; i < line.positions.length; i += 3) {
    assert(line.positions[i] >= 0, 'a streamline cannot cross the equilibrium');
    assert(line.positions[i] < line.positions[i - 3], `zero or reversed progress at sample ${i / 3}`);
    assert.equal(line.positions[i + 1], 0);
  }
  assert(line.positions.length / 3 < 101, 'stagnation terminates before the step budget is exhausted');
});
