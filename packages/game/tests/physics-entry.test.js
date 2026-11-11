import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Vite copies a module's `new URL('./rapier3d.wasm', import.meta.url)` file when it reads the module, before
// tree-shaking, so a root that re-exported Physics put Rapier's Wasm into every game build, physics or not.
// The physics names live on the kit's physics subpath instead.
async function emitted(code) {
  const out = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    // An app build: library mode would inline the Wasm instead of emitting it.
    build: { write: false, target: 'es2022', rollupOptions: { input: 'app', preserveEntrySignatures: 'strict' } },
    plugins: [{ name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) }],
  });
  return out.output.map((file) => file.fileName).filter((file) => /\.wasm$|draco|basis/i.test(file));
}

test('the game kit root emits no Wasm and its physics entry emits exactly rapier3d.wasm', { timeout: 120000 }, async () => {
  assert.deepEqual(await emitted("export { createStage, Shadows, Input } from '@margoengine/game';"), []);
  const physics = await emitted("export { Physics, PhysicsBody, CharacterController } from '@margoengine/game/physics';");
  assert.equal(physics.length, 1, physics.join(', '));
  assert.match(physics[0], /^assets\/rapier3d-[\w-]+\.wasm$/);
});

test('the game kit root no longer names the physics classes', async () => {
  const kit = await import('@margoengine/game');
  for (const name of ['Physics', 'PhysicsBody', 'CharacterController']) assert.equal(name in kit, false, name);
  const physics = await import('@margoengine/game/physics');
  assert.equal(physics.Physics, (await import('@margoengine/physics')).Physics);
});
