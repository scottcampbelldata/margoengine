// check:owners runs the entries (37, 481 cases, past the 208 a leaf may run) in leaves of eight. One leaf per entry,
// 70 leaves for 35 entries with the WebGL2 pass, ran past the gate's 10 minutes on 2026-11-18: each leaf paid its own
// dev server, browser and shader compiles. A leaf of eight took at most 79 s on the WebGL2 layer of the workstation
// (2026-11-18), well inside the leaf's 180 s limit, which never rises; the whole check took 468 s for 35 entries.
export const leafCases = 104;
// A 16 x 16 r32float ground for the coastal flow, made once per device the Water sees. The caller owns it (made in the
// dependency scope) and destroys it at cleanup.
const ground = (engine, dependency) => {
  const made = new Map();
  return {
    heightmap: () => {
      const device = engine.gpu;
      if (!made.has(device)) made.set(device, dependency(() => {
        const texture = device.createTexture({ size: [16, 16], format: 'r32float', usage: 4 | 2 });
        device.queue.writeTexture({ texture }, new Float32Array(256).fill(-1), { bytesPerRow: 64 }, [16, 16]);
        return texture;
      }));
      return made.get(device);
    },
    origin: [-8, -8], size: [16, 16],
    destroy() { for (const texture of made.values()) texture.destroy(); made.clear(); },
  };
};
import { PostStack } from '../../post/dist/stack.js';

const square = [[-2, -2], [2, -2], [2, 2], [-2, 2]];

export async function fixtures(load = (entry) => import(entry)) {
  const { Water } = await load('../dist/index.js');
  const { FFTOcean } = await load('../dist/fft.js');
  const { WaveQuery } = await load('../dist/query.js');
  const { Caustics } = await load('../dist/caustics.js');
  const { Ripples } = await load('../dist/ripples.js');
  const { WaterFlow } = await load('../dist/flow.js');
  const { WaterBodies } = await load('../dist/bodies.js');
  const { WaterScatter } = await load('../dist/scatter.js');
  const { WaterRain } = await load('../dist/rain.js');
  const { WaterReflection } = await load('../dist/reflector.js');
  const { Underwater } = await load('../dist/underwater.js');
  const { Rivers } = await load('../dist/rivers.js');
  const { Flood } = await load('../dist/flood.js');
  const { ParticleLiquid } = await load('../dist/liquid.js');
  const { ShipWakes } = await load('../dist/ships.js');
  const { BergFoam, Iceberg } = await load('../dist/ice.js');
  const { ShotSplash } = await load('../dist/splash.js');
  const small = { size: [16, 16], segments: 16 };
  const entries = [];
  const own = (name, make) => entries.push({ name, create({ engine }) {
    const plugin = make(engine);
    return { plugin, dispose: () => plugin.dispose() };
  } });
  own('Water', () => new Water(small));
  own('Water.attach', (engine) => Water.attach(engine, { ...small, whitecaps: 0.5 }));
  // Spray and the coastal flow run on a ground the caller made; the entry destroys it with the water.
  entries.push({ name: 'Water with terrain and spray', create({ engine, dependency }) {
    const terrain = ground(engine, dependency), plugin = new Water({ ...small, terrain, spray: true });
    return { plugin, dispose: () => plugin.dispose(), cleanup: () => terrain.destroy() };
  } });
  own('FFTOcean', () => new FFTOcean({ resolution: 16 }));
  own('FFTOcean.attach', (engine) => FFTOcean.attach(engine, { resolution: 16 }));
  own('ParticleLiquid.attach', (engine) => ParticleLiquid.attach(engine, {
    particles: { positions: new Float32Array([0, 0, 0, 0.1, 0, 0]) }, radius: 0.05, narrowBand: true }));
  // Effects on a surface the caller attached: the surface is a dependency the caller disposes.
  const on = (name, Surface, make) => entries.push({ name, create({ engine, scene, dependency }) {
    const surface = Surface === Water ? new Water(small) : new FFTOcean({ resolution: 16 });
    // The surface's own registrations (its shared scene-depth capture) belong to the caller too.
    const before = new Set(scene.plugins.values());
    dependency(() => scene.use(surface));
    const dependencies = [...scene.plugins.values()].filter((p) => !before.has(p));
    const plugin = make(engine, surface);
    return { plugin, dependencies, dispose: () => plugin.dispose(), cleanup: () => surface.dispose() };
  } });
  // Post effects made with new go into a PostStack the caller attaches, here two at once.
  on('PostStack of Caustics and Underwater', Water, (engine, surface) =>
    PostStack.attach(engine, [new Caustics({ surface, size: 16 }), new Underwater({ surface })]));
  on('PostStack of FFTOcean effects', FFTOcean, (engine, surface) =>
    PostStack.attach(engine, [new Caustics({ surface, size: 16 }), new Underwater({ surface })]));
  own('PostStack of ParticleLiquid', (engine) => PostStack.attach(engine,
    [new ParticleLiquid({ particles: { positions: new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]) }, radius: 0.05 })]));
  const post = new Set([Caustics, Underwater]);
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    const pick = (Kind, options) => (engine) => factory || post.has(Kind) ? Kind.attach(engine, options) : new Kind(options);
    on('WaterBodies' + suffix, Water, (engine, surface) =>
      pick(WaterBodies, { surface, bodies: [{ outline: square, level: 0.5 }], resolution: 16 })(engine));
    if (factory) on('Caustics.attach', Water, (engine, surface) => pick(Caustics, { surface, size: 16, heightRange: [-4, 0] })(engine));
    if (factory) on('Caustics.attach on FFTOcean', FFTOcean, (engine, surface) => pick(Caustics, { surface, size: 16 })(engine));
    on('Ripples' + suffix, Water, (engine, surface) => pick(Ripples, { surface })(engine));
    on('WaterFlow' + suffix, Water, (engine, surface) => pick(WaterFlow, { surface })(engine));
    on('WaterScatter' + suffix, Water, (engine, surface) => pick(WaterScatter, { surface })(engine));
    on('WaterRain' + suffix, Water, (engine, surface) => pick(WaterRain, { surface })(engine));
    // A moving ship with a lamp and a fixed lamp: the wake's uniform and trail buffer are its own.
    on('ShipWakes' + suffix, Water, (engine, surface) =>
      pick(ShipWakes, { surface, lamps: [{ position: [0, 4, 0] }],
        ships: [{ hull: { length: 4, beam: 1, draft: 0.3 }, path: (t) => [0, t], lamps: [{ position: [0, 2, 0] }] }] })(engine));
    // A floating box berg: the foam's uniform is its own.
    const cube = { positions: [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1],
      indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5] };
    on('BergFoam' + suffix, Water, (engine, surface) => pick(BergFoam, { surface, bergs: [new Iceberg({ mesh: cube })] })(engine));
    // A shot falling in: the foam's uniform is its own; the spray emitters are stand-ins with no GPU work.
    on('ShotSplash' + suffix, Water, (engine, surface) => pick(ShotSplash, { surface, particles: () => ({ options: {}, burst() {} }),
      source: [{ time: 0, position: [0, 0, 0], velocity: [0, -200, 0], radius: 0.08, density: 7200 }] })(engine));
    // A capture-only planar reflector that has not captured yet: the reflection keeps to its own resources.
    on('WaterReflection' + suffix, Water, (engine, surface) =>
      pick(WaterReflection, { surface, reflector: { texture: undefined, textureMatrix: undefined } })(engine));
    if (factory) on('Underwater.attach', Water, (engine, surface) => pick(Underwater, { surface })(engine));
    if (factory) on('Underwater.attach on FFTOcean', FFTOcean, (engine, surface) => pick(Underwater, { surface })(engine));
  }
  // Rivers registers no plugin of its own: it runs inside its Water's coastal flow, so the Water is part of the entry.
  for (const factory of [false, true]) entries.push({ name: 'Rivers' + (factory ? '.attach' : ''), create({ engine, dependency }) {
    const terrain = ground(engine, dependency), plugin = new Water({ ...small, terrain });
    const sources = [{ position: [0, 0], discharge: 2, radius: 1 }];
    const rivers = factory ? Rivers.attach(plugin, { sources }) : new Rivers(plugin, { sources, substeps: 2 });
    return { plugin, dispose: () => { rivers.dispose(); plugin.dispose(); }, cleanup: () => terrain.destroy() };
  } });
  // Flood runs inside the Water's coastal flow as its solver; the Water (with its terrain) is the caller's dependency.
  for (const factory of [false, true]) entries.push({ name: 'Flood' + (factory ? '.attach' : ''), create({ engine, scene, dependency }) {
    const terrain = ground(engine, dependency), surface = new Water({ ...small, terrain });
    const before = new Set(scene.plugins.values());
    dependency(() => scene.use(surface));
    const dependencies = [...scene.plugins.values()].filter((p) => !before.has(p));
    const options = { surface, walls: [{ from: [-4, 0], to: [4, 0], top: 1 }], obstacles: (x) => (x > 2 ? 1 : 0),
      sources: [{ position: [0, 0], discharge: 1 }] };
    const plugin = factory ? Flood.attach(engine, options) : new Flood(options);
    return { plugin, dependencies, dispose: () => plugin.dispose(), cleanup: () => { surface.dispose(); terrain.destroy(); } };
  } });
  // WaveQuery reads a rendered surface back: each render captures one, and an aborted capture lets go of its signal.
  for (const [label, Surface] of [['Water', Water], ['FFTOcean', FFTOcean]]) entries.push({ name: 'WaveQuery on ' + label,
  create({ engine }) {
    const plugin = Surface === Water ? new Water(small) : new FFTOcean({ resolution: 16 });
    return { plugin, dispose: () => plugin.dispose(), async check({ phase }) {
      if (phase !== 'render' || engine.sceneOf(plugin) === undefined) return;
      const query = await WaveQuery.capture(plugin);
      query.height?.(0, 0);
      const abort = new AbortController(), pending = WaveQuery.capture(plugin, { signal: abort.signal });
      abort.abort();
      await pending.then(() => {}, (error) => { if (error?.name !== 'AbortError' && error?.code !== 'aborted') throw error; });
    } };
  } });
  return entries;
}
