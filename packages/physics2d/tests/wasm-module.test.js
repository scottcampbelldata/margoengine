// Physics2D.load({wasm}) with a compiled WebAssembly.Module: a foreign module is refused, Rapier's loads. Own file: the
// first load that succeeds is the app's solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Physics2D } from '../dist/index.js';
import { emptyWasm, lookAlikeWasm } from './wasm-fixtures.js';

test('a compiled module that is not Rapier\'s is refused; Rapier\'s compiled module loads', async () => {
  for (const bytes of [emptyWasm, lookAlikeWasm])
    await assert.rejects(Physics2D.load({ wasm: new WebAssembly.Module(bytes) }), { name: 'MargoError', code: 'failed' });
  assert.throws(() => new Physics2D(null), { code: 'state' });

  const module = await WebAssembly.compile(await readFile(new URL('../dist/rapier2d.wasm', import.meta.url)));
  await Physics2D.load({ wasm: module });
  const physics = new Physics2D(null, { gravity: [0, 10], pixelsPerMeter: 1, interpolate: false }),
    body = physics.addBody(null, { colliders: { shape: 'circle', radius: 1 } });
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(body.position[1] > 4.9 && body.position[1] < 5.1, `fell to ${body.position[1]}`);
  physics.dispose();
});
