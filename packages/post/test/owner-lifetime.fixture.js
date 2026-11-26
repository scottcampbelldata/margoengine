// check:owners runs one browser leaf per entry: all 31 in one leaf took 208 s on the WebGL2 layer (Radeon 680M, list 5
// batch I1), past the leaf's 180 s limit, which never rises.
export const leafPerEntry = true;
const entries = {
  afterimage: ['Afterimage'],
  anamorphic: ['Anamorphic'],
  ascii: ['ASCII'],
  bloom: ['Bloom'],
  blur: ['Blur'],
  'color-average': ['ColorAverage'],
  'contact-shadows': ['ContactShadows'],
  curvature: ['Curvature'],
  decals: ['Decals'],
  depth: ['DepthTexture'],
  'depth-downsample': ['DepthDownsample'],
  fxaa: ['FXAA'],
  glitch: ['Glitch'],
  gtao: ['GTAO'],
  'heat-haze': ['HeatHaze'],
  halftone: ['Halftone', 'DotScreen'],
  image: ['ImagePost'],
  'kawase-blur': ['KawaseBlur'],
  'lens-flare': ['LensFlare'],
  lens: ['Lens'],
  lut1d: ['LUT1D'],
  'material-decals': ['MaterialDecals'],
  outline: ['Outline'],
  overlays: ['Ramp', 'Grid', 'DepthView', 'TextureOverlay'],
  pixelate: ['Pixelate'],
  'render-graph': ['RenderGraph'],
  smaa: ['SMAA'],
  ssao: ['SSAO'],
  ssgi: ['SSGI'],
  ssr: ['SSR'],
  sss: ['SSS'],
  stylize: ['Stylize'],
  'motion-blur': ['MotionBlur'],
  mrt: ['SceneTargets'],
  'mesh-blend': ['MeshBlend'],
  'selective-bloom': ['SelectiveBloom'],
  trail: ['TrailTexture'],
  upscale: ['SpatialUpscale'],
};
// Not covered here: SceneFade ends itself on device restore by design (a captured transition cannot survive it).
// Classes whose options have required members.
const required = {
  LUT1D: { lut: { data: [0, 0, 0, 1, 1, 1] } },
  MotionBlur: { velocity: () => undefined },
  RenderGraph: { version: 1, tasks: [{ name: 'x', type: 'clear', outputs: { target: 'screen' } }] },
  SceneTargets: { outputs: { albedo: 'albedo', normal: 'normal' } },
  SelectiveBloom: { mask: () => undefined },
  TextureOverlay: { source: () => undefined },
};
export async function fixtures(load = (entry) => import(entry)) {
  const out = [];
  for (const [file, names] of Object.entries(entries)) {
    const module = await load(`../dist/${file}.js`);
    for (const name of names)
      out.push({
        name: name + '.attach',
        create({ engine }) {
          const plugin = required[name] ? module[name].attach(engine, required[name]) : module[name].attach(engine);
          return { plugin, dispose: () => plugin.dispose() };
        },
      });
  }
  const { EffectMask } = await load('../dist/mask.js');
  const { Pixelate } = await load('../dist/pixelate.js');
  const { Bloom } = await load('../dist/bloom.js');
  const { PostStack } = await load('../dist/stack.js');
  // RTReflections and RTGI need a scene on the engine's device; the scene is the caller's (a dependency), released at cleanup.
  const { RTReflections } = await load('../dist/rt-reflections.js');
  const { MeshBVH } = await load('../../bvh/dist/index.js');
  const { GPUSceneBVH } = await load('../../bvh/dist/gpu-scene.js');
  const { RTGI } = await load('../dist/rt-gi.js');
  for (const [name, attach] of [
    ['RTReflections.attach', (engine, scene) => RTReflections.attach(engine, { scene, stochastic: true })],
    ['RTGI.attach', (engine, scene) => RTGI.attach(engine, { scene, multiBounce: true })],
  ])
    out.push({
      name,
      create({ engine, dependency }) {
        const bvh = MeshBVH.build({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
          scene = dependency(() => GPUSceneBVH.forShader(engine, [{ bvh }])),
          plugin = attach(engine, scene);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => scene.dispose() };
      },
    });
  out.push({
    name: 'EffectMask.attach',
    create({ engine }) {
      const effect = new Pixelate(),
        plugin = EffectMask.attach(engine, effect, { mask: () => undefined });
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => effect.dispose() };
    },
  });
  for (const factory of [false, true])
    out.push({
      name: 'PostStack' + (factory ? '.attach' : ''),
      create({ engine }) {
        const effects = [new Bloom(), new Pixelate()];
        const plugin = factory ? PostStack.attach(engine, effects) : new PostStack(effects);
        return {
          plugin,
          dispose: () => plugin.dispose(),
          cleanup() {
            for (const effect of effects) effect.dispose();
          },
        };
      },
    });
  // The runtime is no plugin: a plugin owns one here, as an app running it on an engine's device would.
  const { ImageFilterGraph } = await load('../dist/filter-graph.js');
  out.push({
    name: 'ImageFilterGraph.create',
    async create({ engine }) {
      const filter = await ImageFilterGraph.create(
        { nodes: [{ id: 'fill', type: 'solid-color' }], output: 'fill' },
        { device: engine.gpu, size: [8, 8] },
      );
      const plugin = {
        name: 'owner-lifetime:filter-graph',
        setup() {},
        onPreUpdate: () => filter.render(),
        onDeviceRestored: (next) => filter.restore(next.gpu),
        dispose: () => filter.dispose(),
      };
      const dispose = () => {
        engine.sceneOf(plugin)?.removePlugin(plugin.name);
        filter.dispose();
      };
      return { plugin, dispose };
    },
  });
  return out;
}
