// Owner/lifetime fixture of @margoengine/voxel: each engine-side owner (the block renderer, its lighting effects, the
// smooth terrain view and object blocks) on a small world. Chunks mesh on this thread through a mesher object, since
// the node adapter has no Web Workers; the renderer's own GPU work is the same either way.
const world = (index, render) => {
  const { BlockTypes, VoxelWorld } = index;
  const blocks = new BlockTypes();
  const stone = blocks.define('stone', { textures: 0 }),
    glass = blocks.define('glass', { layer: 'translucent', textures: 0 }),
    lamp = blocks.define('lamp', { textures: 0, light: 14 });
  const w = new VoxelWorld({ blocks });
  const edits = [];
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) edits.push(x, 0, z, stone);
  edits.push(2, 1, 2, glass, 3, 1, 3, lamp);
  w.setBlocks(edits);
  return { w, textures: new render.BlockTextures() };
};
const inline = (mesher) => ({
  mesh: async (w, key) => mesher.meshChunk(mesher.meshInput(w, key)),
  cancel() {},
  dispose() {},
});

export async function fixtures(load = (entry) => import(entry)) {
  const index = await load('../dist/index.js');
  const render = await load('../dist/render.js');
  const mesher = await load('../dist/mesher.js');
  const { VoxelColorLight } = await load('../dist/light-rgb.js');
  const renderer = (engine, factory) => {
    const { w, textures } = world(index, render);
    const options = { world: w, textures, mesher: inline(mesher) };
    // The block textures belong to the caller, not the renderer: the fixture disposes them with it.
    return { w, textures, plugin: render.VoxelRenderer.attach(engine, options) };
  };
  const entries = [{ name: 'VoxelRenderer.attach', create({ engine }) {
    const { plugin, textures } = renderer(engine);
    return { plugin, dispose() { plugin.dispose(); textures.dispose(); } };
  } }];
  entries.push({ name: 'VoxelColorLight', create({ engine }) {
    const { w, plugin, textures } = renderer(engine);
    const light = VoxelColorLight.attach(engine, { world: w, extent: [32, 32, 32], colors: { lamp: [1, 0.5, 0.2] } });
    const remove = plugin.addLighting(light);
    return { plugin, dispose() { remove(); light.dispose(); plugin.dispose(); textures.dispose(); } };
  } });
  return entries;
}
