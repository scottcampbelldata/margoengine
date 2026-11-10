// Shared regression check for the plugin scene owner class (docs/integration-fixtures.md, "Scene owner"): a plugin
// attached to a second scene must leave THAT scene on dispose, and a plugin of the same name in the active scene must
// stay. The old one-argument `engine.removePlugin(name)` failed both halves. Runs on tests/support/review56-engine.js
// (a real EngineKernel on a recording device); `stubDevice` fills in the device calls a plugin's setup makes that the
// recording device leaves out, each returning an inert object.
import assert from 'node:assert/strict';
import { engine } from './review56-engine.js';

/** An inert GPU object: every property is another inert callable, never a thenable. */
export function inert() {
  const fn = function () {
    return inert();
  };
  return new Proxy(fn, {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (key === 'width' || key === 'height' || key === 'depthOrArrayLayers' || key === 'size') return 1;
      if (!(key in target)) target[key] = inert();
      return target[key];
    },
  });
}

/** Adds every `create*` and `begin*` call `gpu` lacks (and a few reads), each answering with an inert object. */
export function stubDevice(gpu) {
  // review56-engine.js puts this global back after the test, as it does the usage flags.
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  for (const name of [
    'createComputePipeline',
    'createBindGroupLayout',
    'createPipelineLayout',
    'createQuerySet',
    'importExternalTexture',
    'pushErrorScope',
  ])
    gpu[name] ??= () => inert();
  gpu.createComputePipelineAsync ??= async () => inert();
  gpu.popErrorScope ??= async () => null;
  gpu.onuncapturederror ??= null;
  const encoder = gpu.createCommandEncoder;
  gpu.createCommandEncoder = (d) =>
    Object.assign(inert(), { beginComputePass: () => inert(), copyBufferToBuffer() {}, clearBuffer() {} }, encoder(d));
  gpu.queue.onSubmittedWorkDone ??= async () => {};
  gpu.queue.copyExternalImageToTexture ??= () => {};
  return gpu;
}

/**
 * Attaches `make(e)` to a second scene, puts a decoy of the same name in the active scene, disposes the plugin and
 * checks that it left its own scene and the decoy stayed attached and undisposed. Returns the engine for more checks.
 */
export async function assertLeavesOwnScene(t, make, { before } = {}) {
  const e = await engine(t);
  stubDevice(e.gpu);
  const owner = e.createScene('scene-owner');
  await before?.(e, owner);
  const plugin = await make(e, owner);
  if (e.sceneOf(plugin) !== owner) owner.use(plugin);
  assert.ok(e.sceneOf(plugin) === owner, `${plugin.name} attached to the second scene`);
  let decoyDisposed = 0;
  const decoy = { name: plugin.name, setup() {}, dispose: () => void decoyDisposed++ };
  e.use(decoy);
  // Identity checks, not deepEqual: a failure message that printed the engine would take seconds to format.
  plugin.dispose();
  assert.ok(e.sceneOf(plugin) === undefined, `${plugin.name} left the scene it joined`);
  assert.equal(owner.plugins.has(plugin.name), false, `${plugin.name} is gone from its own scene`);
  assert.ok(e.scene.plugins.get(plugin.name) === decoy, `the active scene's ${plugin.name} stays attached`);
  assert.equal(decoyDisposed, 0, `the active scene's ${plugin.name} was not disposed`);
  return e;
}

let boots = 0;
/** Runs `attach()` (a package's `X.attach(engine, ...)`) while `scene` is active, so it joins `scene`; returns its result. */
export function attachIn(scene, attach) {
  let made;
  scene.use({ name: `scene-owner-boot-${++boots}`, setup: () => void (made = attach()) });
  return made;
}
