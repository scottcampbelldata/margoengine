const entries = {
  afterimage: ['Afterimage'], anamorphic: ['Anamorphic'], bloom: ['Bloom'], blur: ['Blur'],
  'contact-shadows': ['ContactShadows'], curvature: ['Curvature'], decals: ['Decals'], depth: ['DepthTexture'],
  fxaa: ['FXAA'], glitch: ['Glitch'], gtao: ['GTAO'], halftone: ['Halftone', 'DotScreen'], image: ['ImagePost'],
  'lens-flare': ['LensFlare'], lens: ['Lens'], 'material-decals': ['MaterialDecals'], outline: ['Outline'],
  pixelate: ['Pixelate'], smaa: ['SMAA'], ssao: ['SSAO'],
  sss: ['SSS'], stylize: ['Stylize'],
  'motion-blur': ['MotionBlur'], mrt: ['SceneTargets'], 'selective-bloom': ['SelectiveBloom'],
};
// Not covered here: SceneFade ends itself on device restore by design (a captured transition cannot survive it), and
// SSR and SSGI, whose clear colour buffers stay in shared/clear-color.js's per device cache after disposal
// (docs/known-bugs.md).
// Classes whose options have required members.
const required = {
  MotionBlur: { velocity: () => undefined },
  SceneTargets: { outputs: { albedo: 'albedo', normal: 'normal' } },
  SelectiveBloom: { mask: () => undefined },
};
export async function fixtures(load = (entry) => import(entry)) {
  const out = [];
  for (const [file, names] of Object.entries(entries)) {
    const module = await load(`../dist/${file}.js`);
    for (const name of names) out.push({ name: name + '.attach', create({ engine }) {
      const plugin = required[name] ? module[name].attach(engine, required[name]) : module[name].attach(engine);
      return { plugin, dispose: () => plugin.dispose() };
    } });
  }
  const { EffectMask } = await load('../dist/mask.js');
  const { Pixelate } = await load('../dist/pixelate.js');
  const { Bloom } = await load('../dist/bloom.js');
  const { PostStack } = await load('../dist/stack.js');
  out.push({ name: 'EffectMask.attach', create({ engine }) {
    const effect = new Pixelate(), plugin = EffectMask.attach(engine, effect, { mask: () => undefined });
    return { plugin, dispose: () => plugin.dispose(), cleanup: () => effect.dispose() };
  } });
  for (const factory of [false, true]) out.push({ name: 'PostStack' + (factory ? '.attach' : ''), create({ engine }) {
    const effects = [new Bloom(), new Pixelate()];
    const plugin = factory ? PostStack.attach(engine, effects) : new PostStack(effects);
    return { plugin, dispose: () => plugin.dispose(), cleanup() { for (const effect of effects) effect.dispose(); } };
  } });
  return out;
}
