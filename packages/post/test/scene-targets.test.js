// SceneTargets (named MRT outputs) over the recording mock GPU: the core replay's outputs and
// formats, the gltf-pro capture declarations, clearing per view, resize and release, and the option errors. Pixels are
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

test('SceneTargets gives gltf-pro capture declarations that build the same outputs', () => {
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
    /TargetSurface\(margoPosition,s\.n,s\.base,s\.roughness,s\.metal,s\.occlusion,s\.emissive,f\.eye\.xyz\)/,
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
