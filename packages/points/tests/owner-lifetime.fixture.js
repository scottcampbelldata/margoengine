const positions = () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const colors = () => new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);

// WebGPU enum globals the plugins read; present only while a fixture instance lives, so other packages see none.
const enums = {
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64,
    STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
};
let users = 0;
const added = [];
function withEnums() {
  if (!users++) for (const [name, value] of Object.entries(enums)) if (!(name in globalThis)) {
    globalThis[name] = value;
    added.push(name);
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--users) return;
    for (const name of added.splice(0)) delete globalThis[name];
  };
}

// The fake GPU has no pipeline-layout factory; every device the host swaps in after a loss needs one too.
function layouts(engine) {
  let proto = Object.getPrototypeOf(engine), get;
  while (proto && !(get = Object.getOwnPropertyDescriptor(proto, 'gpu')?.get)) proto = Object.getPrototypeOf(proto);
  Object.defineProperty(engine, 'gpu', { configurable: true, get() {
    const gpu = get.call(this);
    if (gpu) {
      gpu.createBindGroupLayout ??= (d) => d;
      gpu.createPipelineLayout ??= (d) => d;
    }
    return gpu;
  } });
}

export async function fixtures(load = (entry) => import(entry)) {
  const { PointsPlugin, PointCloud, SpriteBatch } = await load('../dist/index.js');
  const { SurfelPlugin } = await load('../dist/surfels.js');
  const { OctreeCloud, buildOctree } = await load('../dist/octree.js');
  const entries = [];
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    entries.push({ name: 'PointsPlugin' + suffix, visible: false, create({ engine }) {
      const release = withEnums();
      layouts(engine);
      const plugin = factory ? PointsPlugin.attach(engine) : new PointsPlugin();
      if (!factory) engine.use(plugin);
      plugin.add(new PointCloud({ positions: positions(), colors: colors(), colorComponents: 4 }));
      const sprites = new SpriteBatch({ capacity: 2 });
      sprites.add({ position: [0, 0, 0], size: 1 });
      plugin.add(sprites);
      return { plugin, dispose: () => plugin.dispose(), cleanup: release };
    } });
    entries.push({ name: 'SurfelPlugin' + suffix, create({ engine }) {
      const release = withEnums();
      layouts(engine);
      const plugin = factory ? SurfelPlugin.attach(engine) : new SurfelPlugin();
      if (!factory) engine.use(plugin);
      plugin.add(new PointCloud({ positions: positions(), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) }));
      return { plugin, dispose: () => plugin.dispose(), cleanup: release };
    } });
    entries.push({ name: 'OctreeCloud' + suffix, create({ engine, scene, dependency }) {
      const release = withEnums();
      layouts(engine);
      const points = new PointsPlugin();
      dependency(() => scene.use(points));
      const tree = buildOctree({ positions: positions() }, { maxPointsPerNode: 8 });
      const plugin = factory ? OctreeCloud.attach(engine, points, tree) : new OctreeCloud(points, tree);
      return { plugin, dependencies: [points], dispose: () => plugin.dispose(), cleanup() { points.dispose(); release(); } };
    } });
  }
  return entries;
}
