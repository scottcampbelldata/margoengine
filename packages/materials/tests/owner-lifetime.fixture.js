export async function fixtures(load = (entry) => import(entry)) {
  const { StencilBuffer } = await load('../dist/index.js');
  const { Transmission } = await load('../dist/transmission.js');
  const { Material } = await load('../dist/index.js');
  const { BatchedMesh } = await load('../dist/batched.js');
  const { BatchedLOD } = await load('../dist/batched-lod.js');
  const triangle = { positions: [-1, -1, 0, 1, -1, 0, -1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
  const entries = [];
  const own = (name, make) =>
    entries.push({
      name,
      create({ engine }) {
        const plugin = make(engine);
        return { plugin, dispose: () => plugin.dispose() };
      },
    });
  own('StencilBuffer', () => new StencilBuffer());
  own('StencilBuffer.attach', (engine) => StencilBuffer.attach(engine));
  own('Transmission', () => new Transmission());
  own('Transmission.attach', (engine) => Transmission.attach(engine));
  // The batch it culls is made with it and disposed after it; the items it added go with it.
  entries.push({
    name: 'BatchedLOD.attach',
    warmUp: "materials' 1x1 default textures, made once per device",
    create({ engine }) {
      const batch = BatchedMesh.attach(engine, new Material(), { maxItems: 4, maxVertices: 16 }),
        plugin = BatchedLOD.attach(engine, batch);
      plugin.add([{ geometry: triangle }, { geometry: triangle, distance: 5 }]);
      return {
        plugin,
        dispose() {
          plugin.dispose();
          batch.dispose();
        },
      };
    },
  });
  return entries;
}
