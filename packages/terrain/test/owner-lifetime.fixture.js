import { PbrMaterial, box } from '../../core/dist/index.js';

// Small terrains whose textures the terrain makes from the caller's callback on each device it sees (it owns them).
const n = 17;
const layers = [0, 1, 2, 3].map((i) => ({ height: [-100 + i, 100], slope: [0, 1], scale: 0.25 }));
const array = (device, rgba, count = 4) => {
  const texture = device.createTexture({ size: [1, 1, count], format: 'rgba8unorm', usage: 6 });
  device.queue.writeTexture({ texture }, new Uint8Array(Array.from({ length: count }, () => rgba).flat()),
    { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, count]);
  return texture;
};
const options = (weights = false) => ({
  size: [32, 32], origin: [-16, -16], heightScale: 4, resolution: 16, levels: 3, layers,
  textures(device) {
    const heightmap = device.createTexture({ size: [n, n], format: 'r32float', usage: 15 });
    device.queue.writeTexture({ texture: heightmap }, new Float32Array(n * n).map((_, i) => 0.1 * Math.sin(i)),
      { bytesPerRow: n * 4 }, [n, n]);
    const colors = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
    device.queue.writeTexture({ texture: colors }, new Uint8Array(16).fill(140), { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 4]);
    if (!weights) return { heightmap, layers: colors };
    const weight = device.createTexture({ size: [n, n], format: 'rgba8unorm', usage: 15 });
    device.queue.writeTexture({ texture: weight }, new Uint8Array(n * n * 4).map((_, i) => (i % 4 ? 0 : 255)),
      { bytesPerRow: n * 4 }, [n, n]);
    return { heightmap, layers: colors, weights: [weight, weight] };
  },
});
const color = {
  sand: [0.8, 0.7, 0.5], meadow: [[0.2, 0.5, 0.1], [0.3, 0.6, 0.2]], stone: [0.5, 0.5, 0.5], shore: [0, 0.5],
  meadowHeight: [0, 5], stoneHeight: [5, 10], stoneNormal: [0.5, 0.8], wetHeight: [0, 0.2], wetDarkening: 0.3,
};

export const leafPerEntry = true;

export async function fixtures(load = (entry) => import(entry)) {
  const { Terrain, TerrainColors, TerrainHeightmap } = await load('../dist/index.js');
  const { TerrainMaterials } = await load('../dist/layers-pbr.js');
  const { TerrainDisplacement } = await load('../dist/displace.js');
  const { TerrainDeformation } = await load('../dist/deform.js');
  const { TerrainVirtualTexture } = await load('../dist/rvt.js');
  const { GroundChange } = await load('../dist/ground-change.js');
  const { RockSurface } = await load('../dist/rock-surface.js');
  const { heightfield } = await load('../dist/index.js');
  const { TerrainBlend } = await load('../dist/blend.js');
  const { TerrainOverlays } = await load('../dist/overlays.js');
  const { TerrainImagery } = await load('../dist/imagery.js');
  const { TerrainStream } = await load('../dist/stream.js');
  const { TerrainSculpt } = await load('../dist/sculpt.js');
  const { PlanetTerrain } = await load('../dist/planet.js');
  const entries = [];
  const own = (name, make) => entries.push({ name, async create({ engine }) {
    const plugin = await make(engine);
    return { plugin, dispose: () => plugin.dispose() };
  } });
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    own('Terrain' + suffix, (engine) => factory ? Terrain.attach(engine, options()) : new Terrain(options(true)));
    own('TerrainHeightmap' + suffix, (engine) => factory
      ? TerrainHeightmap.attach(engine, (x, z) => 0.1 * x * z, { size: [4, 4], resolution: 16 })
      : new TerrainHeightmap(() => 0, { size: [4, 4], resolution: 16 }));
    own('PlanetTerrain' + suffix, (engine) => factory ? PlanetTerrain.attach(engine, { radius: 1000, relief: 10 })
      : new PlanetTerrain({ radius: 1000 }));
  }
  // TerrainColors shades a mesh the caller owns.
  for (const factory of [false, true]) entries.push({ name: 'TerrainColors' + (factory ? '.attach' : ''),
    create({ engine, scene, dependency }) {
      const mesh = dependency(() => scene.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial()));
      const plugin = factory ? TerrainColors.attach(engine, mesh, color) : new TerrainColors(mesh, color);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    } });
  // RockSurface shades meshes the caller owns as rock: one added, so a frame uploads its rows and patches the shader.
  for (const factory of [false, true]) entries.push({ name: 'RockSurface' + (factory ? '.attach' : ''),
    create({ engine, scene, dependency }) {
      const mesh = dependency(() => scene.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial()));
      const plugin = (factory ? RockSurface.attach(engine, { rain: 0.5 }) : new RockSurface({ rain: 0.5 })).add(mesh, { type: 'basalt' });
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    } });
  // GroundChange changes a heightfield mesh the caller owns: a scour at work, so a frame uploads heights and covers.
  const ground = { grid: { size: [8, 8], resolution: 8 }, events: [{ kind: 'scour', center: [0, 0], radius: 2 }, { kind: 'lava', path: [[-3, 1], [3, 1]], width: 2 }], time: 5 };
  for (const factory of [false, true]) entries.push({ name: 'GroundChange' + (factory ? '.attach' : ''),
    create({ engine, scene, dependency }) {
      const mesh = dependency(() => scene.createMesh().setGeometry(heightfield((x, z) => 0.1 * x, ground.grid)).setMaterial(new PbrMaterial()));
      const plugin = factory ? GroundChange.attach(engine, mesh, ground) : new GroundChange(ground, mesh);
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => mesh.dispose() };
    } });
  // Layers on a terrain (and its virtual texture or materials) the caller attached.
  const on = (name, make, { rvt = false, materials = false, weights = false } = {}) => entries.push({ name,
    async create({ engine, scene, dependency }) {
      const terrain = new Terrain(options(weights)), dependencies = [terrain];
      dependency(() => scene.use(terrain));
      const virtual = rvt && new TerrainVirtualTexture(terrain, { texel: 0.25, size: 256, levels: 2 });
      if (virtual) { dependency(() => scene.use(virtual)); dependencies.push(virtual); }
      const pbr = materials && new TerrainMaterials(terrain, {
        textures: (device) => ({ normals: array(device, [128, 128, 255, 255]), surface: array(device, [255, 230, 0, 128]) }),
      });
      if (pbr) { dependency(() => scene.use(pbr)); dependencies.push(pbr); }
      // Textures the layer borrows are the caller's: made in the dependency scope and destroyed at cleanup.
      const borrowed = [], borrow = (texture) => (borrowed.push(texture), texture);
      const plugin = await make(engine, terrain, virtual || pbr, (make) => dependency(() => borrow(make())));
      return { plugin, dependencies, dispose: () => plugin.dispose(), cleanup: () => {
        pbr && pbr.dispose(); virtual && virtual.dispose(); terrain.dispose();
        for (const texture of borrowed) texture.destroy();
      } };
    } });
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    on('TerrainMaterials' + suffix, (engine, terrain) => {
      const textures = (device) => ({ normals: array(device, [128, 128, 255, 255]), surface: array(device, [255, 255, 0, 255]) });
      return factory ? TerrainMaterials.attach(engine, terrain, { textures }) : new TerrainMaterials(terrain, { textures });
    });
    on('TerrainDisplacement' + suffix, (engine, terrain, materials) => factory
      ? TerrainDisplacement.attach(engine, terrain, materials, { depth: 0.05, distance: 30, steps: 8 })
      : new TerrainDisplacement(terrain, materials, { depth: 0.05 }), { materials: true });
    on('TerrainDeformation' + suffix, (engine, terrain) => {
      const plugin = factory ? TerrainDeformation.attach(engine, terrain) : new TerrainDeformation(terrain);
      return plugin.footprint(0, 0).track([-4, 0], [4, 2]);
    });
    on('TerrainVirtualTexture' + suffix, (engine, terrain) => {
      const plugin = factory ? TerrainVirtualTexture.attach(engine, terrain, { texel: 0.25, size: 256, levels: 2 })
        : new TerrainVirtualTexture(terrain, { texel: 0.25, size: 256, levels: 2,
          decals: (device) => array(device, [40, 50, 60, 200], 2) });
      if (!factory) plugin.addDecal({ center: [2, 3], size: [6, 4], angle: 0.3, layer: 0 });
      return plugin;
    });
    on('TerrainBlend' + suffix, (engine, terrain, rvt) => factory ? TerrainBlend.attach(engine, terrain, rvt)
      : new TerrainBlend(terrain, rvt), { rvt: true });
    on('TerrainOverlays' + suffix, (engine, terrain, rvt) => {
      const plugin = factory ? TerrainOverlays.attach(engine, rvt) : new TerrainOverlays(rvt);
      plugin.addPolyline([[-8, -8], [8, 8]], { width: 1 });
      plugin.addPolygon([[[-4, -4], [4, -4], [0, 4]]]);
      return plugin;
    }, { rvt: true });
    // Imagery from a texture the caller lends per device and from tiles loaded in memory, each request with its signal.
    on('TerrainImagery' + suffix, (engine, terrain, _, borrowed) => {
      const plugin = factory ? TerrainImagery.attach(engine, terrain) : new TerrainImagery(terrain);
      plugin.add({ source: { texture: (device) => borrowed(() => array(device, [200, 100, 50, 255], 1)) } });
      plugin.add({ source: { url: (tile) => `tile/${tile.level}/${tile.x}/${tile.y}`, tileSize: 4,
        load: async (_tile, signal) => { signal.throwIfAborted(); return new Uint8Array(64).fill(128); } } });
      return plugin;
    });
    // TerrainSculpt has only its async attach: with and without brush options.
    on('TerrainSculpt.attach' + (factory ? ' brush' : ''), async (engine, terrain) => factory
      ? TerrainSculpt.attach(engine, terrain, { radius: 4, strength: 0.5 })
      : TerrainSculpt.attach(engine, terrain), { weights: true });
  }
  // A streamed terrain: tiles come from memory, through the stream's abortable loader. attach installs the stream's
  // terrain and the stream; dispose removes both.
  entries.push({ name: 'TerrainStream.attach', create({ engine }) {
    const plugin = TerrainStream.attach(engine, {
      tileSize: 8, tileTexels: 8, window: 2, heightScale: 1, layers,
      colors: (device) => array(device, [140, 140, 140, 255]),
      async load(x, z, signal) { signal.throwIfAborted(); return { heights: new Float32Array(64).fill(0.01 * (x + z)) }; },
    });
    return { plugin, dispose: () => plugin.dispose() };
  } });
  return entries;
}
