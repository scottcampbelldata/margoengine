// Owner/lifetime fixture for @margoengine/creative. Every engine plugin the package makes is an entry, built the two
// ways a user builds it (`new X()` used on the scene, and `X.attach(engine)`): the GPU leaf particles, toon shading, the
// compute-culled grass field, terrain-rooted grass, the starfield and the orbit atmosphere; the two painterly post
// effects only run in a PostStack, so `attach` joins the scene's (and takes it with them) and a `new` effect goes to a
// stack the app makes. Planet, which decodes its maps with createImageBitmap, is an entry in the browser leaves only
// (Node, the CPU model, has no such call). The three render targets (HDR scene target, cube/array/3d texture target
// and its depth variant) are not plugins: each holds textures of the engine's device, so each is tied to a plugin
// registration that releases it, as `ownedByEngine` does for any such object.
// PostProcessing is an entry built three ways: `new`, `attach` and inside a PostStack (each view keeps its own state since
// KB-CREATIVE-POSTVIEW1). Not entries: grass-settings (numbers and a target interface), the shaders and the hashing/maths
// helpers hold nothing with a lifetime.
// check:owners runs one browser leaf per entry: the 21 entries are 273 cases, past the 208 a leaf may hold, and the orbit
// atmosphere alone takes about 130 s on the WebGL2 layer (the Hillaire tables compile on both devices of every case),
// so no two of them fit the leaf's 180 s limit together, which never rises.
export const leafPerEntry = true;
import { ownedByEngine } from '../../../tests/support/owner-shell.js';
import { PostStack } from '../../post/dist/stack.js';

export async function fixtures(load = (entry) => import(entry)) {
  // The grass field and the planet read the canvas format from `navigator.gpu`, which a page with WebGPU always has and the
  // CPU model's Node does not (xr's fixture adds its own the same way). The format is the one the model's context draws in.
  if (!globalThis.navigator.gpu)
    Object.defineProperty(globalThis.navigator, 'gpu', {
      configurable: true,
      value: { getPreferredCanvasFormat: () => 'bgra8unorm' },
    });
  const { GPUParticles } = await load('../dist/particles.js');
  const { ToonShading } = await load('../dist/toon.js');
  const { GrassField } = await load('../dist/grass.js');
  const { createTerrainGrass } = await load('../dist/grass-terrain.js');
  const { Planet } = await load('../dist/planet.js');
  const { Stars } = await load('../dist/stars.js');
  const { OrbitAtmosphere } = await load('../dist/planet-atmosphere.js');
  const { PostProcessing } = await load('../dist/post.js');
  const { Painterly } = await load('../dist/paint.js');
  const { AnisotropicPainterly } = await load('../dist/paint-aniso.js');
  const { HDRRenderTarget, TextureRenderTarget } = await load('../dist/targets.js');
  const { DepthTextureRenderTarget } = await load('../dist/targets-depth.js');
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      create({ engine }) {
        const plugin = make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  for (const [name, Plugin, options] of [
    ['GPUParticles', GPUParticles, { count: 64 }],
    ['ToonShading', ToonShading, { bands: 3 }],
    ['GrassField', GrassField, { blades: 512, area: [8, 8] }],
    ['Stars', Stars, undefined],
    ['OrbitAtmosphere', OrbitAtmosphere, { radius: 1 }],
  ]) {
    own(name, (engine) =>
      name === 'Stars' ? new Plugin() : name === 'GrassField' ? new Plugin({ engine }, options) : new Plugin(options),
    );
    own(`${name}.attach`, (engine) => Plugin.attach(engine, options));
  }
  own('PostProcessing', () => new PostProcessing());
  own('PostProcessing.attach', (engine) => PostProcessing.attach(engine));
  own('PostProcessing in a PostStack', () => new PostStack([new PostProcessing()]));
  // The painterly effects only run inside a PostStack: `attach` joins the scene's stack (or makes one) and takes it out
  // again, and a `new` effect is handed to a stack the app makes.
  for (const [name, Effect] of [
    ['Painterly', Painterly],
    ['AnisotropicPainterly', AnisotropicPainterly],
  ]) {
    own(`${name}.attach`, (engine) => Effect.attach(engine, { radius: 2 }));
    own(`${name} in a PostStack`, () => new PostStack([new Effect({ radius: 2 })]));
  }
  entries.push({
    name: 'createTerrainGrass',
    async create({ engine }) {
      const plugin = await createTerrainGrass(engine, {
        count: 64,
        area: [8, 8],
        bounds: [-4, -4, 4, 4],
        colorMap: { width: 1, height: 1, data: new Float32Array([0.2, 0.4, 0.6, 1]) },
      });
      return { plugin, dispose: () => plugin.dispose() };
    },
  });
  // Planet loads its maps from a fetch the app passes in (a one-pixel PNG, served from memory) and decodes them with
  // createImageBitmap, which a browser has and the CPU model's Node does not: this entry runs in the browser leaves only.
  if (typeof createImageBitmap === 'function') {
    const pixel = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    entries.push({
      name: 'Planet.attach',
      async create({ engine }) {
        const plugin = await Planet.attach(engine, {
          dayMap: 'day.png',
          nightMap: 'night.png',
          fetch: async () => new Response(pixel),
        });
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  }
  // A render target is made on the app's device and is the app's to dispose; the plugin registration stands for the
  // owner's scope, so the harness checks the texture is destroyed when the owner lets go.
  const target = (name, make) =>
    entries.push({
      name,
      create({ engine, scene }) {
        const value = make(engine.gpu);
        return ownedByEngine(scene, name, () => value.dispose());
      },
    });
  target('HDRRenderTarget', (gpu) => new HDRRenderTarget(gpu, 64, 32, 1));
  target('TextureRenderTarget', (gpu) => new TextureRenderTarget(gpu, { kind: 'cube', width: 16 }));
  target(
    'DepthTextureRenderTarget',
    (gpu) => new DepthTextureRenderTarget(gpu, { kind: 'array', width: 16, depthOrLayers: 2 }),
  );
  return entries;
}
