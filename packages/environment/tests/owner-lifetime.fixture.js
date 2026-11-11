// A device restore rebuilds an environment asynchronously; a build still running when its owner is disposed destroys its
// own result, so the check waits for that to finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

export async function fixtures(load = (entry) => import(entry)) {
  const { Environment, EnvironmentBackground, ImageBackground, ColorBackground, TransparentCanvas, EnvironmentLighting,
    Fog, HemisphereLight, AmbientLight, ColorOutput } = await load('../dist/index.js');
  const { GroundProjectedBackground } = await load('../dist/ground.js');
  const { EnvironmentBlend } = await load('../dist/blend.js');
  const { LightProbes } = await load('../dist/probes.js');
  const { DynamicGI } = await load('../dist/gi.js');
  const { VolumetricFog } = await load('../dist/volumetric.js');
  const { Reflector } = await load('../dist/reflector.js');
  const { Refractor } = await load('../dist/refractor.js');
  const { CubeCamera } = await load('../dist/cube-camera.js');
  const image = () => ({ width: 16, height: 8, data: new Float32Array(16 * 8 * 4).fill(0.5) });
  const entries = [];
  const own = (name, make) => entries.push({ name, create({ engine }) {
    const plugin = make(engine);
    return { plugin, dispose: () => plugin.dispose() };
  } });
  // Environments are plugins another entry reads from: installed by the caller, so they count as dependencies.
  const withEnvironments = (name, count, make) => entries.push({ name, async create({ engine, dependency }) {
    const sources = [];
    for (let i = 0; i < count; i++) sources.push(await dependency(() => Environment.attach(engine, image(), { size: 16 })));
    const plugin = await make(engine, ...sources);
    return { plugin, dependencies: sources, dispose: () => plugin.dispose(),
      cleanup: async () => { for (const source of sources) source.dispose(); await settle(); } };
  } });
  withEnvironments('Environment.attach', 0, async (engine) => Environment.attach(engine, image(), { size: 16 }));
  own('ColorBackground', () => new ColorBackground());
  own('ColorBackground.attach', (engine) => ColorBackground.attach(engine));
  own('TransparentCanvas', () => new TransparentCanvas());
  own('Fog', () => new Fog());
  own('HemisphereLight', () => new HemisphereLight());
  own('AmbientLight', () => new AmbientLight());
  own('ColorOutput', () => new ColorOutput());
  own('ImageBackground', () => new ImageBackground({ shape: 'sphere',
    images: [{ width: 2, height: 2, data: new Uint8Array(16).fill(128) }] }));
  own('LightProbes', () => new LightProbes({ reflections: [{ position: [0, 1, 0], min: [-2, 0, -2], max: [2, 3, 2] }] }));
  own('DynamicGI', () => new DynamicGI({ min: [-1, 0, -1], max: [1, 2, 1], counts: [2, 2, 2] }));
  own('VolumetricFog', () => new VolumetricFog({ depth: () => undefined }));
  own('Reflector', () => new Reflector());
  own('Refractor', () => new Refractor());
  own('CubeCamera', () => new CubeCamera());
  withEnvironments('EnvironmentBackground', 1, (engine, environment) => new EnvironmentBackground(environment));
  withEnvironments('EnvironmentLighting', 1, (engine, environment) => new EnvironmentLighting(environment));
  withEnvironments('GroundProjectedBackground', 1, (engine, environment) => new GroundProjectedBackground(environment));
  entries.push({ name: 'EnvironmentBlend', async create({ engine, scene, dependency }) {
    const from = await dependency(() => Environment.attach(engine, image(), { size: 16 }));
    const to = await Environment.create(engine, image(), { size: 16 });
    // Attach in the owner's scene: the fixture's own awaits already returned the engine to its active scene.
    let pending;
    const scope = { name: 'owner-lifetime:blend', setup() { pending = EnvironmentBlend.attach(engine, from, to); } };
    scene.use(scope);
    scene.removePlugin(scope.name);
    const plugin = await pending;
    return { plugin, dependencies: [from], dispose: () => plugin.dispose(),
      cleanup: async () => { to.dispose(); from.dispose(); await settle(); } };
  } });
  return entries;
}
