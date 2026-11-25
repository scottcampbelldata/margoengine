// Owner/lifetime fixture for @margoengine/blender: what an app attaches to an engine from a .margo file. Each parse
// function makes a glTF PBR PBRModel (the model is the registration), each load function fetches first with the app's
// own signal, which outlives the load; parseMargoNodes adds its node-material uniforms; parseMargoComponents adds the
// file's physics world, lights and the scripts it names. The files are the package's own test fixtures, read once
// (packages/blender/tests/fixtures). Not entries: the files with images (pbr-ext, lightmap, triangle) need an image
// decoder the CPU leaf lacks, their parse paths are the parseMargo path plus images, which
// tests/async-scene.test.js and tests/lightmap-scene.browser.mjs cover; margoLive needs an EventSource and a local
// Blender; decodeMargo, margoComponents, compressMargoMeshopt and the writers are pure functions of their input.

const files = ['compact-triangle', 'nodes', 'anim', 'curves', 'components'];
async function read(name) {
  const url = new URL(`./fixtures/${name}.margo`, import.meta.url);
  if (url.protocol !== 'file:') return new Uint8Array(await (await fetch(url)).arrayBuffer());
  const { readFile } = await import('node:fs/promises');
  return new Uint8Array(await readFile(url));
}
// The app's own signal outlives the load: whatever a load subscribes on it must go when the load settles.
const signal = () => new AbortController().signal;
const served = (bytes) => async (input, init) => {
  init?.signal?.throwIfAborted();
  return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
};

export async function fixtures(load = (entry) => import(entry)) {
  const { parseMargo, loadMargo } = await load('../dist/index.js');
  const { parseMargoNodes, loadMargoNodes } = await load('../dist/nodes.js');
  const { parseAnimatedMargo } = await load('../dist/anim.js');
  const { parseMargoCurves } = await load('../dist/curves.js');
  const { parseMargoComponents } = await load('../dist/components.js');
  const [plain, nodes, anim, curves, components] = await Promise.all(files.map(read));
  const url = 'https://assets.example/scene.margo';
  // The model is the plugin; `release` is what the app calls, and must leave none of the model's meshes behind.
  const model = (name, make) => ({
    name,
    async create(context) {
      const { plugin, release = () => plugin.dispose() } = await make(context);
      const meshes = [plugin.root, ...plugin.nodes].filter(Boolean);
      if (!meshes.length) throw new Error(`OWNER_FIXTURE: ${name} made no mesh`);
      return {
        plugin,
        dispose: release,
        check({ phase }) {
          if (phase === 'disposed' && meshes.some((m) => m.engine.meshes.get(m.id) === m))
            throw new Error(`OWNER_LIFETIME: a disposed ${name} model leaves meshes in the scene`);
        },
      };
    },
  });
  const loaded = (made) => async (context) => {
    const result = await made(context);
    return { plugin: result.model, release: () => result.dispose() };
  };
  return [
    model('parseMargo', async ({ engine }) => ({ plugin: await parseMargo(engine, plain, { signal: signal() }) })),
    model('loadMargo', async ({ engine }) => ({
      plugin: await loadMargo(engine, url, { fetch: served(plain), signal: signal() }),
    })),
    model(
      'parseMargoNodes',
      loaded(({ engine }) => parseMargoNodes(engine, nodes, { signal: signal() })),
    ),
    model(
      'loadMargoNodes',
      loaded(({ engine }) => loadMargoNodes(engine, url, { fetch: served(nodes), signal: signal() })),
    ),
    model('parseAnimatedMargo', async ({ engine }) => ({
      plugin: await parseAnimatedMargo(engine, anim, { signal: signal() }),
    })),
    model('parseMargoCurves', async ({ engine }) => {
      const result = await parseMargoCurves(engine, curves, { signal: signal() });
      return { plugin: result.model };
    }),
    // Scripts that make a mesh in the scene and hand back its cleanup, as a door or a spinner does.
    model(
      'parseMargoComponents',
      loaded(({ engine }) =>
        parseMargoComponents(engine, components, {
          signal: signal(),
          view: false,
          scripts: {
            door: ({ model: owner }) => {
              const mesh = owner.root.engine.createMesh();
              return () => mesh.dispose();
            },
            glow: () => {},
          },
        }),
      ),
    ),
  ];
}
