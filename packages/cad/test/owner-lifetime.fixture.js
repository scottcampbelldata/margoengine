// Owner/lifetime fixture for @margoengine/cad: what an app adds to an engine from a CAD file. parseCAD and loadCAD
// (STL and OBJ, the formats that read without the B-rep kernel) make a model of meshes, which the app hangs off the
// engine and disposes (owner-shell.js); loadCAD fetches first with the app's own signal, which outlives the load, so
// whatever it subscribes must go when it settles. parseCADAsync runs only where the runtime has workers (the browser
// leaf), on the package's own worker. PartInstancer packs a parsed assembly's small closed parts into shared GPU buffers
// (the plugin is the registration). Not entries: the B-rep formats need the kernel's Wasm in its worker, which
// test/cad-brep-worker.test.js drives; addCAD needs a Stage, which @margoengine/stage's own fixture owns;
// deduplicateParts and capsAsSolid are pure functions of their input.
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';

// Two closed boxes as OBJ objects, small enough for PartInstancer to pack.
const box = (name, o) => {
  const v = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const f = [
    [1, 4, 3, 2],
    [5, 6, 7, 8],
    [1, 2, 6, 5],
    [4, 8, 7, 3],
    [1, 5, 8, 4],
    [2, 3, 7, 6],
  ];
  return [
    `o ${name}`,
    ...v.map(([x, y, z]) => `v ${x + o} ${y} ${z}`),
    ...f.map((q) => `f ${q.map((i) => i - 9).join(' ')}`),
  ].join('\n');
};
const obj = [box('a', 0), box('b', 2)].join('\n') + '\n';
const stl =
  'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
const served = (text) => async (input, init) => {
  init?.signal?.throwIfAborted();
  return new Response(text, { headers: { 'content-length': String(new TextEncoder().encode(text).byteLength) } });
};
const signal = () => new AbortController().signal;
const bytes = (text) => new TextEncoder().encode(text).buffer;

export async function fixtures(load = (entry) => import(entry)) {
  const { parseCAD, loadCAD, parseCADAsync, PartInstancer } = await load('../dist/index.js');
  // The model hangs off the engine; disposing it must leave none of its meshes in the scene.
  const model = (name, make) => ({
    name,
    async create({ engine, scene }) {
      const made = await make(engine);
      const meshes = [made.root, ...made.meshes];
      return ownedByEngine(scene, name, () => made.dispose(), {
        check({ phase }) {
          if (phase === 'render' && meshes.some((m) => m.scene !== scene))
            lifetimeFault(`${name} builds its model outside the scene it was called for`);
          if (phase === 'disposed' && meshes.some((m) => m.scene.meshes.get(m.id) === m))
            lifetimeFault(`a disposed ${name} model leaves meshes in the scene`);
        },
      });
    },
  });
  const entries = [
    model('parseCAD stl', (engine) => parseCAD(engine, stl, 'stl')),
    model('parseCAD obj', (engine) => parseCAD(engine, obj, 'obj')),
    model('loadCAD', (engine) =>
      loadCAD(engine, 'https://assets.example/part.obj', { fetch: served(obj), signal: signal() }),
    ),
    {
      name: 'PartInstancer.attach',
      async create({ engine, dependency }) {
        // The assembly is the app's, not the plugin's: its meshes' GPU buffers count against the app until it disposes it.
        const parts = dependency(() => parseCAD(engine, obj, 'obj'));
        const plugin = PartInstancer.attach(engine);
        return {
          plugin,
          dispose() {
            plugin.dispose();
            parts.dispose();
          },
        };
      },
    },
  ];
  if (typeof Worker === 'function')
    entries.push(model('parseCADAsync', (engine) => parseCADAsync(engine, bytes(obj), 'obj', { signal: signal() })));
  return entries;
}
