import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// The physics kernel is a blueprint inside the package's JavaScript, so no game build, physics or not, emits a Wasm file for it.
async function emitted(code) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    // An app build: library mode would inline the Wasm instead of emitting it.
    build: { write: false, target: 'es2022', rollupOptions: { input: 'app', preserveEntrySignatures: 'strict' } },
    plugins: [
      { name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) },
    ],
  });
  return out.output.map((file) => file.fileName).filter((file) => /\.wasm$|draco|basis/i.test(file));
}

test('neither the game kit root nor its physics entry emits a Wasm file', { timeout: 120000 }, async () => {
  assert.deepEqual(await emitted("export { createStage, Shadows, Input } from '@margoengine/game';"), []);
  assert.deepEqual(
    await emitted("export { Physics, PhysicsBody, CharacterController } from '@margoengine/game/physics';"),
    [],
  );
});

test('the game kit root no longer names the physics classes', async () => {
  const kit = await import('@margoengine/game');
  for (const name of ['Physics', 'PhysicsBody', 'CharacterController']) assert.equal(name in kit, false, name);
  const physics = await import('@margoengine/game/physics');
  assert.equal(physics.Physics, (await import('@margoengine/physics')).Physics);
});
