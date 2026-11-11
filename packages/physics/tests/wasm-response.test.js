// Physics.load({wasm}) with a fetched Response: refused when it is not Rapier's build, compiled when it is, also from a
// server that does not label it application/wasm. Own file: the first load that succeeds is the app's solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Physics } from '../dist/index.js';
import { emptyWasm, lookAlikeWasm } from './wasm-fixtures.js';

const wasm = await readFile(new URL('../dist/rapier3d.wasm', import.meta.url));
const respond = (body, type) => new Response(body, { headers: { 'content-type': type } });

test('a Response holding foreign Wasm or an error status is refused; Rapier\'s Wasm loads under any content type', async () => {
  for (const body of [emptyWasm, lookAlikeWasm])
    for (const type of ['application/wasm', 'application/octet-stream'])
      await assert.rejects(Physics.load({ wasm: respond(body, type) }), { name: 'MargoError', code: 'failed' });
  await assert.rejects(Physics.load({ wasm: new Response('gone', { status: 404, statusText: 'Not Found' }) }), (error) => {
    assert.equal(error.code, 'failed');
    assert.match(error.message, /404 Not Found/);
    return true;
  });
  assert.throws(() => new Physics(null), { code: 'state' }, 'nothing loaded yet');

  await Physics.load({ wasm: respond(wasm, 'application/octet-stream') });
  const physics = new Physics(null, { gravity: [0, -10, 0], interpolate: false }),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(body.position[1] < -4.9 && body.position[1] > -5.1, `fell to ${body.position[1]}`);
  physics.dispose();
});
