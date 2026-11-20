// Owner/lifetime fixture for @margoengine/transitions: what an app attaches to an engine for a scene change. The
// frozen-frame Transitions plugin (constructor, attach, and one started), a custom WGSL transition, a preset and a GLSL
// transition (each validates its shader across an await, then registers in the scene the call was made for). Not
// entries: LiveTransitions (attach, custom and createLivePresetTransition) registers in a composite scene it creates and
// owns, never in the app's scene, which the harness's peer-engine check (the active scene's plugins) cannot see yet;
// its scene disposal is covered by test/live.test.js. createMaskTransition needs an
// ImageData or ImageBitmap, which the CPU model does not have (the fixtures never shim one).
// translateGLSLTransition, transitionPresetWGSL and the shader text are pure functions of their input.
const wgsl =
  'fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return mix(sample(a,uv),sample(b,uv),p*p);}';
const glsl = 'vec4 transition(vec2 uv){return mix(getFromColor(uv),getToColor(uv),progress);}';

export async function fixtures(load = (entry) => import(entry)) {
  const { Transitions } = await load('../dist/index.js');
  const { createCustomTransition } = await load('../dist/custom.js');
  const { createPresetTransition, transitionPresets } = await load('../dist/presets.js');
  const { createGLSLTransition } = await load('../dist/glsl.js');
  const entry = (name, make) => ({
    name,
    async create({ engine }) {
      const plugin = await make(engine);
      return { plugin, dispose: () => plugin.dispose() };
    },
  });
  return [
    entry('Transitions', (engine) => {
      const transitions = new Transitions();
      engine.use(transitions);
      return transitions;
    }),
    entry('Transitions.attach', (engine) => Transitions.attach(engine)),
    entry('Transitions.start', (engine) => {
      const transitions = Transitions.attach(engine);
      transitions.start('dissolve', 2);
      return transitions;
    }),
    entry('createCustomTransition', (engine) => createCustomTransition(engine, wgsl)),
    entry('createPresetTransition', (engine) => createPresetTransition(engine, transitionPresets[0])),
    entry('createGLSLTransition', (engine) => createGLSLTransition(engine, glsl)),
  ];
}
