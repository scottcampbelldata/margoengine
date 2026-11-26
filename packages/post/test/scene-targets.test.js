// SceneTargets (named MRT outputs) over the recording mock GPU: the core replay's outputs and
// formats, the gltf/pbr capture declarations, clearing per view, resize and release, and the option errors. Pixels are
// checked on a real GPU by the visual check (demos/scene-targets.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, modules } from './support.js';
import { SceneTargets } from '../dist/mrt.js';

const outputs = {
  albedo: 'albedo',
  normal: 'normal',
  distance: 'distance',
  mask: { wgsl: 'vec4f(t.roughness,t.metalness,0,1)', format: 'rg8unorm', clear: { r: 1, g: 0, b: 0, a: 1 } },
};

for (const samples of [4, 1])
  test(`SceneTargets replays core meshes into one target per output (${samples}x)`, async () => {
    const h = harness({ samples }),
      targets = SceneTargets.attach(h.engine, { outputs }),
      taa = { binding: 8, resource: { buffer: {} } };
    let resized = 0;
    targets.onResize(() => resized++);
    assert.equal(targets.texture('albedo'), undefined, 'no textures before the first frame');
    const log = h.gpu.record(() => h.frame([taa]));
    assert.equal(resized, 1);
    assert.deepEqual(targets.names, ['albedo', 'normal', 'distance', 'mask']);
    const replay = modules(log).find((code) => code.includes('fn margoTargets('));
    assert.match(replay, /->MargoCapture \{/);
    assert.match(replay, /if\(false\)\{let direct=[\s\S]*\}return margoTargets\(TargetSurface\(i\.position,n,/);
    assert.match(replay, /o\.o2=vec4f\(vec4f\(distance\(t\.eye,t\.position\),0,0,1\)\);/);
    assert.match(replay, /o\.o3=vec4f\(vec4f\(t\.roughness,t\.metalness,0,1\)\);/);
    const pipeline = log.find((e) => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 4)[2];
    assert.deepEqual(
      pipeline.fragment.targets.map((t) => t.format),
      ['rgba8unorm', 'rgba16float', 'r32float', 'rg8unorm'],
    );
    assert.equal(pipeline.multisample.count, 1, 'single-sample targets at any scene sample count');
    assert.deepEqual(
      [pipeline.depthStencil.format, pipeline.depthStencil.depthCompare],
      ['depth32float', 'greater-equal'],
    );
    const [draw] = h.draws.filter((d) => d.pipeline);
    assert.deepEqual(
      draw.bindings.map((e) => e.binding),
      [8],
      "core's pass bindings stay bound",
    );
    assert.equal(draw.clear, false, 'the targets are cleared by their own pass first');
    assert.equal(draw.colorAttachments.length, 3);
    assert.equal(draw.descriptor.multisample.count, 1);
    for (const name of targets.names) {
      const texture = targets.texture(name);
      assert.ok(texture && targets.view(name));
      assert.equal(texture.sampleCount ?? 1, 1);
    }
    assert.equal(targets.depth.format, 'depth32float');
    assert.equal(h.view.c.descriptor.multisample.count, samples, 'the context is restored after the pass');
    // Steady frames create nothing; a resize recreates the textures and tells listeners.
    await null;
    const steady = h.gpu.record(() => h.frame([taa]));
    assert.deepEqual(
      steady.filter((e) => /^(texture|module|renderPipeline)$/.test(e[0])),
      [],
    );
    await null;
    h.view.state.width = 640;
    h.frame([taa]);
    assert.equal(resized, 2);
    assert.equal(targets.texture('albedo').width, 640);
    targets.dispose();
    await null;
    assert.deepEqual(
      h.live().filter((r) => r.format),
      [],
      'dispose releases every target texture',
    );
  });

test('SceneTargets gives gltf/pbr capture declarations that build the same outputs', () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, { outputs }),
    hooks = [];
  const model = {
    setCapture(hook) {
      hooks.push(hook);
      return () => hooks.splice(hooks.indexOf(hook), 1);
    },
    onDispose: () => () => {},
    draw() {},
  };
  const release = targets.add(model);
  assert.equal(targets.add(model), release, 'adding twice keeps one capture');
  const [hook] = hooks,
    code = hook.declarations('struct Surface {base:vec4f}');
  assert.match(code, /var<private> margoPosition:vec3f;/);
  assert.match(code, /fn margoCapture\(s:Surface,v:vec3f,k:vec3f\)->MargoCapture/);
  assert.match(
    code,
    /TargetSurface\(margoPosition,s\.n,s\.base,s\.roughness,s\.metal,s\.occlusion,s\.emissive,f\.eye\.xyz,1\.0,f\.light\.xyz,0\.0,1\.0\)/,
  );
  assert.deepEqual(
    hook.targets.map((t) => t.format),
    ['rgba8unorm', 'rgba16float', 'r32float', 'rg8unorm'],
  );
  assert.throws(() => hook.declarations('fn other(){}'), { code: 'unsupported' });
  release();
  assert.equal(hooks.length, 0, 'the remover restores the model');
  assert.throws(() => targets.add({}), TypeError);
});

test('SceneTargets checks its outputs and names the fix', () => {
  assert.throws(() => new SceneTargets({}), TypeError);
  assert.throws(() => new SceneTargets({ outputs: {} }), { name: 'RangeError', message: /1 to 7/ });
  assert.throws(
    () => new SceneTargets({ outputs: Object.fromEntries([...Array(8)].map((_, i) => ['o' + i, 'albedo'])) }),
    RangeError,
  );
  assert.throws(() => new SceneTargets({ outputs: { a: 'colour' } }), { message: /unknown; use albedo/ });
  assert.throws(() => new SceneTargets({ outputs: { a: { format: 'r32uint' } } }), { message: /float or unorm/ });
  assert.throws(() => new SceneTargets({ outputs: { 'two words': 'albedo' } }), TypeError);
  assert.throws(() => new SceneTargets({ outputs: { a: { wgsl: '' } } }), TypeError);
  assert.throws(() => new SceneTargets({ outputs: { a: 'albedo' }, order: Number.NaN }), TypeError);
  const missing = new SceneTargets({ outputs: { a: 'albedo' } });
  assert.throws(() => missing.texture('b'), { name: 'RangeError', message: /no output 'b'; use one of a/ });
});

test('SceneTargets keeps one set of textures per destination size across frames', async () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, { outputs: { distance: 'distance' } });
  let resized = 0;
  targets.onResize(() => resized++);
  // Each frame: a canvas view (1280 x 720) and a view into a 256 x 128 target; both are index 0 of their destination.
  const frame = () =>
    h.gpu.record(() => {
      for (const [width, height, id] of [
        [1280, 720, 'canvas'],
        [256, 128, 'target'],
      ]) {
        h.view.begin(0);
        Object.assign(h.view.c, { width, height });
        h.view.c.view = { id, camera: h.view.camera, viewport: [0, 0, width, height], index: 0, count: 1 };
        h.engine.frameGraph.execute(h.view.c);
        assert.deepEqual([targets.depth.width, targets.texture('distance').height], [width, height], id);
      }
    });
  const made = (log) => log.filter((e) => e[0] === 'texture' && /^(r32float|depth32float)$/.test(e[2].format)).length;
  assert.equal(made(frame()), 4, 'the first frame makes a set per size');
  const sets = resized;
  for (let i = 0; i < 3; i++) {
    await null;
    const log = frame();
    assert.equal(made(log), 0, `steady frame ${i} creates no textures`);
    assert.equal(log.filter((e) => e[0] === 'destroy').length, 0, `steady frame ${i} destroys none`);
  }
  // Listeners still hear each switch, so a material bound through onResize follows the view being drawn.
  assert.ok(resized > sets);
  // A size no view draws any more is released one frame later.
  h.view.c.view = undefined;
  await null;
  h.frame();
  await null;
  h.frame();
  await null;
  assert.equal(h.live().filter((r) => /^(r32float|depth32float)$/.test(r.format)).length, 2, 'only the canvas set');
  targets.dispose();
  await null;
  assert.deepEqual(
    h.live().filter((r) => /^(r32float|depth32float)$/.test(r.format)),
    [],
    'dispose releases every size',
  );
});

// The sun's shadow visibility and the look masks made from it (KB-LOOK-SHADOWMASK1): headless/look's penumbra, subject,
// lit and shadow masks need a package that draws them.
const shadowed = (code) =>
  code.replace('let linear=direct*', 'let linear=shadowLit(direct,i.position,i.normal)*') +
  '\nfn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {return direct*0.5;}';
const fakeShadows = {
  name: 'fake-shadows',
  setup() {},
  registerPasses(graph) {
    graph.add({ name: 'fake-shadows', order: -5, execute: (c) => (c.shader = shadowed(c.shader)) });
  },
};
const live = (replay) => replay.slice(replay.lastIndexOf('}return margoTargets('));

test('SceneTargets keeps the sun visibility a shadow plugin wraps around direct live, attached before it', () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, { outputs: { sun: 'shadow' } });
  h.engine.use(fakeShadows);
  const replay = modules(h.gpu.record(() => h.frame())).find((code) => code.includes('fn margoTargets('));
  assert.ok(replay, 'the replay is built');
  assert.match(
    live(replay),
    /TargetSurface\(i\.position,n,vec4f\(i\.color,1\),i\.material\.x,i\.material\.y,1\.0,vec3f\(0\),frame\.eye\.xyz,dot\(shadowLit\(vec3f\(1\),i\.position,i\.normal\),vec3f\(0\.2126,0\.7152,0\.0722\)\),frame\.light\.xyz,0\.0,1\.0\)/,
    'the visibility is computed outside the dead block, after the -5 shader patch of a plugin attached later',
  );
  assert.equal(h.engine.plugins.size, 2);
  targets.dispose();
});

test('SceneTargets reads visibility 1 with no shadow plugin', () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, { outputs: { sun: 'shadow' } });
  const replay = modules(h.gpu.record(() => h.frame())).find((code) => code.includes('fn margoTargets('));
  assert.match(live(replay), /frame\.eye\.xyz,1\.0,frame\.light\.xyz,0\.0,1\.0\)/);
  targets.dispose();
});

test('SceneTargets draws the look masks as r8unorm built-in values', () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, {
      outputs: { sun: 'shadow', penumbra: 'penumbra', lit: 'litGround', shadow: 'shadedGround', subject: 'subject' },
    });
  const log = h.gpu.record(() => h.frame()),
    replay = modules(log).find((code) => code.includes('fn margoTargets('));
  assert.match(replay, /o\.o0=vec4f\(vec4f\(t\.shadow,max\(dot\(t\.normal,t\.light\),0\.0\),0,1\)\);/);
  assert.match(
    replay,
    /o\.o1=vec4f\(vec4f\(select\(0\.0,1\.0,dot\(t\.normal,t\.light\)>0\.05&&t\.shadow>0\.02&&t\.shadow<0\.98\),0,0,1\)\);/,
  );
  assert.match(
    replay,
    /o\.o2=vec4f\(vec4f\(select\(0\.0,1\.0,t\.ground>0\.5&&t\.normal\.y>=0\.7071&&dot\(t\.normal,t\.light\)>=0\.2&&t\.shadow>=0\.98\),0,0,1\)\);/,
  );
  assert.match(
    replay,
    /o\.o3=vec4f\(vec4f\(select\(0\.0,1\.0,t\.ground>0\.5&&t\.normal\.y>=0\.7071&&dot\(t\.normal,t\.light\)>=0\.2&&t\.shadow<=0\.02\),0,0,1\)\);/,
  );
  assert.match(replay, /o\.o4=vec4f\(vec4f\(t\.subject,0,0,1\)\);/);
  const pipeline = log.find((e) => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 5)[2];
  assert.deepEqual(
    pipeline.fragment.targets.map((t) => t.format),
    ['rg16float', 'r8unorm', 'r8unorm', 'r8unorm', 'r8unorm'],
  );
  targets.dispose();
});

test('SceneTargets marks subject models and reads their sun visibility; terrain captures too', () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, { outputs: { subject: 'subject', sun: 'shadow' } }),
    made = () => {
      const hooks = [];
      return {
        hooks,
        setCapture(hook) {
          hooks.push(hook);
          return () => hooks.splice(hooks.indexOf(hook), 1);
        },
        onDispose: () => () => {},
        draw() {},
      };
    };
  const person = made(),
    ground = made(),
    pbr = 'struct Surface {base:vec4f}\nfn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {return direct;}';
  targets.add(person, { subject: true });
  targets.add(ground);
  const subjectCode = person.hooks[0].declarations(pbr),
    groundCode = ground.hooks[0].declarations(pbr);
  assert.match(
    subjectCode,
    /f\.eye\.xyz,dot\(shadowLit\(vec3f\(1\),margoPosition,s\.n\),vec3f\(0\.2126,0\.7152,0\.0722\)\),f\.light\.xyz,1\.0,1\.0\)\);\}/,
  );
  assert.match(groundCode, /f\.light\.xyz,0\.0,1\.0\)\);\}/);
  // Added again with the other choice, the model moves to that hook.
  targets.add(person);
  assert.equal(person.hooks.length, 1);
  assert.match(person.hooks[0].declarations(pbr), /f\.light\.xyz,0\.0,1\.0\)\);\}/);
  assert.throws(() => targets.add(ground, { subject: 'yes' }), TypeError);
  // Terrain's capture (SSR's contract for shaders without the PBR Surface) gets margoSSR over the same outputs.
  const terrain =
    'struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f}\nfn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {return direct;}';
  const field = made();
  targets.add(field, { subject: false });
  const code = field.hooks[0].declarations(terrain);
  assert.match(code, /struct MargoSSR \{@location\(0\) o0:vec4f,@location\(1\) o1:vec4f\}/);
  assert.match(
    code,
    /fn margoSSR\(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32\)->MargoSSR \{_=v;let o=margoTargets\(TargetSurface\(margoPosition,n,vec4f\(base,1\),rough,metal,1\.0,vec3f\(0\),frame\.eye\.xyz,dot\(shadowLit\(vec3f\(1\),margoPosition,n\),vec3f\(0\.2126,0\.7152,0\.0722\)\),frame\.light\.xyz,0\.0,1\.0\)\);return MargoSSR\(o\.o0,o\.o1\);\}/,
  );
  assert.throws(() => field.hooks[0].declarations('struct Frame {camera:mat4x4f,eye:vec4f,sun:vec4f}'), {
    code: 'unsupported',
  });
  targets.dispose();
});

test('SceneTargets.add {ground: false}: plants hide the ground and are not ground; core lit stages capture too', () => {
  const h = harness(),
    targets = SceneTargets.attach(h.engine, {
      outputs: {
        lit: 'litGround',
        shade: 'shadedGround',
        plants: { wgsl: 'vec4f(1.0-t.ground,0,0,1)', format: 'r8unorm' },
      },
    }),
    made = () => {
      const hooks = [];
      return {
        hooks,
        setCapture(hook) {
          hooks.push(hook);
          return () => hooks.splice(hooks.indexOf(hook), 1);
        },
        onDispose: () => () => {},
        draw() {},
      };
    };
  // Core's lit shader, which lit scatter extends, spells its Frame `struct Frame { camera`.
  const core = 'struct Frame { camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f }',
    plant = made(),
    soil = made();
  targets.add(plant, { ground: false });
  targets.add(soil);
  const plantCode = plant.hooks[0].declarations(core),
    soilCode = soil.hooks[0].declarations(core);
  assert.match(
    plantCode,
    /frame\.eye\.xyz,1\.0,frame\.light\.xyz,0\.0,0\.0\)\);return MargoSSR\(o\.o0,o\.o1,o\.o2\);\}/,
  );
  assert.match(soilCode, /frame\.light\.xyz,0\.0,1\.0\)\);return MargoSSR/);
  assert.match(plantCode, /o\.o0=vec4f\(vec4f\(select\(0\.0,1\.0,t\.ground>0\.5&&/, 'litGround needs ground');
  assert.match(plantCode, /o\.o2=vec4f\(vec4f\(1\.0-t\.ground,0,0,1\)\);/);
  // Added again with the other choice, the model moves; a subject that is not ground has both flags.
  targets.add(plant, { subject: true, ground: false });
  assert.equal(plant.hooks.length, 1);
  assert.match(plant.hooks[0].declarations(core), /frame\.light\.xyz,1\.0,0\.0\)\);/);
  targets.add(plant);
  assert.match(plant.hooks[0].declarations(core), /frame\.light\.xyz,0\.0,1\.0\)\);/);
  assert.throws(() => targets.add(soil, { ground: 'no' }), TypeError);
  targets.dispose();
});
