const data = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0]),
  covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1, 0.1, 0, 0, 0.1, 0, 0.1]),
  colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
});

export async function fixtures(load = (entry) => import(entry)) {
  const { Splats } = await load('../dist/index.js');
  const { SplatBrush } = await load('../dist/brush.js');
  const { SplatDepth } = await load('../dist/depth.js');
  const { SplatLighting } = await load('../dist/lighting.js');
  const { SplatSequence, SplatSkin } = await load('../dist/animate.js');
  const { SplatModifier } = await load('../dist/modify.js');
  const { SplatLod, buildSplatLod } = await load('../dist/lod.js');
  const skin = () => ({ joints: 1, indices: new Uint32Array(8), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]) });
  // [name, extra arguments after the cloud, class]
  const followers = {
    SplatBrush: [SplatBrush, () => []],
    SplatDepth: [SplatDepth, () => [{}]],
    SplatLighting: [SplatLighting, () => [{}]],
    SplatSequence: [SplatSequence, () => [[data(), data()]]],
    SplatSkin: [SplatSkin, () => [skin()]],
  };
  const entries = [];
  for (const factory of [false, true]) {
    const suffix = factory ? '.attach' : '';
    entries.push({ name: 'Splats' + suffix, visible: false, create({ engine }) {
      const plugin = factory ? Splats.attach(engine, data()) : new Splats(data());
      if (!factory) engine.use(plugin);
      return { plugin, dispose: () => plugin.dispose() };
    } });
    for (const [name, [Plugin, extra]] of Object.entries(followers))
      entries.push({ name: name + suffix, create({ engine, scene, dependency }) {
          const cloud = new Splats(data());
        dependency(() => scene.use(cloud));
        const plugin = factory ? Plugin.attach(engine, cloud, ...extra()) : new Plugin(cloud, ...extra());
        return { plugin, dependencies: [cloud], dispose: () => plugin.dispose(), cleanup: () => cloud.dispose() };
      } });
    entries.push({ name: 'SplatModifier' + suffix, async create({ engine, scene, dependency }) {
      const cloud = new Splats(data());
      dependency(() => scene.use(cloud));
      const plugin = await SplatModifier.create(cloud);
      return { plugin, dependencies: [cloud], dispose: () => plugin.dispose(), cleanup: () => cloud.dispose() };
    } });
    entries.push({ name: 'SplatLod' + suffix, create({ engine }) {
      const source = buildSplatLod(data(), { leafSize: 1024 });
      const plugin = factory ? SplatLod.attach(engine, source) : new SplatLod(source);
      if (!factory) {
        engine.use(plugin.cloud);
        engine.use(plugin);
      }
      return { plugin, dispose: () => plugin.dispose() };
    } });
  }
  return entries;
}
