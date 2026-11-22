// Owner/lifetime fixture for @margoengine/geometry. Everything but `@margoengine/geometry/gpu` is arithmetic on typed
// arrays. GeometryGenerator is an engine plugin that owns a compute pass, the pipelines and, per generated item, a
// settings buffer (and for a tube or ribbon the control-point and frame buffers) that the new device must get again after
// a loss. One item of every kind is made and drawn by a mesh, a path gets points, and an item is disposed on its own
// while its generator lives (its buffers must go, the others stay).
export async function fixtures(load = (entry) => import(entry)) {
  const { GeometryGenerator } = await load('../dist/gpu.js');
  const fill = (engine, generator) => {
    const items = [
      generator.surface({
        code: 'fn surface(u: f32, v: f32, time: f32, p: vec4f) -> vec3f { return vec3f(u, v, time); }',
        columns: 4,
        rows: 4,
      }),
      generator.grid({ columns: 4, rows: 4 }),
      generator.sphere({ columns: 8, rows: 4 }),
      generator.torus({ columns: 8, rows: 4 }),
      generator.cylinder({ columns: 8 }),
      generator.tube({ points: 4 }),
      generator.ribbon({ points: 4, closed: true }),
    ];
    const points = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    for (const item of items) if (item.setPoints) item.setPoints(points);
    const meshes = items.map((item) => engine.createMesh().setGeometry(item.geometry));
    // One item goes early: its buffers are released while the generator keeps the rest.
    generator.sphere({ columns: 4, rows: 2 }).dispose();
    return { items, meshes };
  };
  return [
    {
      name: 'GeometryGenerator.attach',
      create({ engine }) {
        const plugin = GeometryGenerator.attach(engine);
        const made = fill(engine, plugin);
        // The meshes are the caller's, so they go with the generator however it is released (a removed plugin is disposed by
        // the scene): the fixture is the caller that draws what it generates.
        const release = plugin.dispose.bind(plugin);
        let released = false;
        plugin.dispose = () => {
          release();
          released = true;
          for (const mesh of made.meshes) mesh.dispose?.();
        };
        return {
          plugin,
          dispose: () => plugin.dispose(),
          // A real frame generates each item; reading one back makes its copy and staging buffers, gone when it settles. The
          // harness also renders after a disposal, when the generator refuses a read by design.
          async check({ phase }) {
            if (phase === 'render' && !released && globalThis.document && engine.backend === 'webgpu')
              await made.items[2].read();
          },
        };
      },
    },
  ];
}
