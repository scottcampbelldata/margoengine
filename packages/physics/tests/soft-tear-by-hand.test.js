// An edge torn by a call (`SoftBody.tearEdge`) is a tear like one the step finds: the next step announces it to `onTear`
// listeners and, with `splitOnTear: 'all'`, parts a cloth along it. Before, only a cell torn by a call was reported; an edge
// torn by hand was left joined and unannounced until the step itself tore something.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

test('an edge torn by hand is announced and parts a cloth', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    soft = await SoftBodies.attach(physics);
  soft.splitOnTear = 'all';
  const cloth = soft.create(SoftBodyDesc.cloth([0, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 6, 4)),
    heard = [];
  soft.onTear((event) => heard.push(event));
  physics.step();
  // Every edge between columns 2 and 3 (particle (i, j) is i * 4 + j).
  const pairs = cloth.edges();
  for (let e = 0; e < pairs.length / 2; e++) {
    const a = Math.floor(pairs[2 * e] / 4),
      b = Math.floor(pairs[2 * e + 1] / 4);
    if (Math.min(a, b) === 2 && Math.max(a, b) === 3) cloth.tearEdge(e);
  }
  physics.step();
  assert.equal(heard.length, 1);
  assert.equal(soft.list().length, 2);
  assert.deepEqual(
    soft
      .list()
      .map((b) => b.numParticles())
      .sort(),
    [12, 12],
  );
});
