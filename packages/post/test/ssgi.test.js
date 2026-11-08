import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack, SSGI, SSR } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const ibl = wgsl.replace(/let linear=([^;]+);/, 'let margoAmbient=vec3f(0.5);let linear=$1+margoAmbient;');
const passes = (log) => log.filter((e) => e[0] === 'beginRenderPass').length;

for (const samples of [4, 1])
  test(`SSGI replays core materials, traces the bounce and composes the stack input (${samples}x)`, async () => {
    const h = harness({ samples }),
      ssgi = new SSGI({ rays: 2, maxDistance: 8, steps: 24, intensity: 0.5 });
    const setup = h.gpu.record(() => h.engine.use(new PostStack([ssgi]))),
      log = h.gpu.record(() => h.frame([{ binding: 18, resource: { buffer: {} } }]));
    const replay = modules(log).find((code) => code.includes('struct Input'));
    assert.match(replay, /->MargoGI \{/);
    assert.match(
      replay,
      /if\(false\)\{let direct=[\s\S]*_=vec4f\(linear,1\);\}return MargoGI\(vec4f\(i\.color\*\(1\.0-i\.material\.y\)\*frame\.radiance\.w\*frame\.ambient\.rgb,1\),vec4f\(i\.color\*\(1\.0-i\.material\.y\),1\),vec4f\(n\*0\.5\+0\.5,1\)\);/,
      "core's ambient term, the albedo and the normal; lighting in a dead block",
    );
    const pipeline = log.find((e) => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 3)[2];
    assert.deepEqual(
      pipeline.fragment.targets.map((t) => t.format),
      ['rgba16float', 'rgba8unorm', 'rgb10a2unorm'],
    );
    assert.equal(pipeline.multisample.count, 1, 'pixel-centre materials at 4x');
    const [draw] = h.draws.filter((d) => d.pipeline);
    assert.deepEqual(
      draw.bindings.map((e) => e.binding),
      [18],
      'every pass binding (TAA camera)',
    );
    // The trace reuses SSR's Hi-Z march text and helpers.
    const trace = modules(setup).find((code) => code.includes('fn trace('));
    assert.ok(trace.includes('let plane=select(2.0,(z-o.z)/dir.z,dir.z<0.0);') && trace.includes('fn closest('));
    // Uniform: rays, intensity and the cone of one of the 16 x rays directions.
    const v = written(log, 176);
    assert.deepEqual([...v.subarray(32, 40)], [1280, 720, 0, 0.5, 8, 24, 6, 1]);
    assert.deepEqual([v[40], v[41]], [2, 0.5]);
    assert.ok(Math.abs(v[43] - Math.sqrt((2 * Math.PI) / 32)) < 1e-6);
    // 32 cosine-weighted unit directions: the mean cosine of a cosine-weighted hemisphere is 2/3.
    const dirs = written(log, 4096);
    let mean = 0;
    for (let i = 0; i < 32; i++) {
      const [x, y, z] = dirs.subarray(i * 4, i * 4 + 3);
      assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-6 && z > 0);
      mean += z / 32;
    }
    assert.ok(Math.abs(mean - 2 / 3) < 0.01, `mean cosine ${mean}`);
    assert.deepEqual([...dirs.subarray(128)], new Array(1024 - 128).fill(0));
    // Stage: 5 mips of the input, trace, two blur passes, the composite (last effect: display-encoded).
    const composite = modules(log).find((code) => code.includes('var gi:texture_2d<f32>'));
    assert.match(composite, /return vec4f\(toDisplay\(c\),s\.a\);/);
    ssgi.enabled = false;
    const off = h.gpu.record(() => h.frame());
    assert.ok(passes(off) <= passes(log) - 8, 'disabled: no mips, trace or blur');
    assert.equal(written(off, 176)[39], 0);
    h.engine.removePlugin('post:stack');
    await null; // released resources are destroyed at the end of the task
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('with margoAmbient (environment IBL) the replay returns it with the lighting live', () => {
  const h = harness({ shader: ibl });
  h.engine.use(new PostStack([new SSGI()]));
  const replay = modules(h.gpu.record(() => h.frame())).find((code) => code.includes('struct Input'));
  assert.match(replay, /_=vec4f\(linear,1\);return MargoGI\(vec4f\(margoAmbient,1\)/);
  assert.doesNotMatch(replay, /if\(false\)/);
});

test('SSGI and SSR capture the same model through one hook, each into its own targets', () => {
  const h = harness(),
    ssr = new SSR(),
    ssgi = new SSGI(),
    calls = [];
  const model = {
    hooks: 0,
    setCapture(hook) {
      this.hooks++;
      this.hook = hook;
      return () => {
        this.hook = undefined;
      };
    },
    onDispose: () => () => {},
    draw(c, mode) {
      const declarations = this.hook.declarations(
        'struct Surface {base:vec4f, n:vec3f}\nfn ambient(s:Surface)->vec3f {return vec3f(1);}',
      );
      calls.push({ mode, formats: this.hook.targets.map((t) => t.format), declarations, pass: this.hook.begin() });
    },
  };
  h.engine.use(new PostStack([ssgi, ssr]));
  const stopSSR = ssr.add(model),
    stopGI = ssgi.add(model);
  assert.equal(model.hooks, 1, 'one capture hook per model');
  h.frame();
  assert.deepEqual(
    calls.map((c) => c.formats),
    [
      ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm'],
      ['rgba16float', 'rgba8unorm', 'rgb10a2unorm'],
    ],
    "SSR's capture (order 14), then SSGI's (15)",
  );
  assert.match(calls[0].declarations, /fn margoSSR\(/);
  assert.match(calls[1].declarations, /vec4f\(ambient\(s\)\*k,1\),vec4f\(s\.base\.rgb\*\(1\.0-s\.metal\),1\)/);
  stopSSR();
  assert.ok(model.hook, 'still captured for SSGI');
  calls.length = 0;
  h.frame();
  assert.equal(calls.length, 1);
  stopGI();
  assert.equal(model.hook, undefined, 'the last remover restores the model');
  h.engine.removePlugin('post:stack');
});

test('SSGI runs only in a PostStack and validates its options', async () => {
  const h = harness();
  assert.throws(() => h.engine.use(new SSGI()), {
    name: 'MargoError',
    code: 'state',
    message: /SSGI.attach\(engine\)/,
  });
  const ssgi = SSGI.attach(h.engine, { rays: 1 });
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('ssgi'));
  h.frame();
  ssgi.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
  await null; // released resources are destroyed at the end of the task
  assert.deepEqual(h.live(), []);
  for (const options of [
    { rays: 0 },
    { rays: 17 },
    { maxDistance: 0 },
    { thickness: -1 },
    { steps: 0 },
    { intensity: 5 },
    { multiBounce: 1 },
  ])
    assert.throws(() => new SSGI(options), RangeError);
  assert.throws(() => ssgi.add({}), { name: 'MargoError', code: 'disposed' });
});

test("multiBounce: rays read the light they hit from last frame's result, reprojected; results ping-pong", async () => {
  const h = harness({ samples: 1 }),
    ssgi = new SSGI({ multiBounce: true });
  h.engine.use(new PostStack([ssgi]));
  const log = h.gpu.record(() => h.frame()),
    codes = modules(log),
    trace = codes.find((code) => code.includes('var lit:texture_2d<f32>'));
  assert.ok(trace, 'the feedback trace');
  assert.match(trace, /let pc=last\.previous\*vec4f\(hp,1\.0\);/);
  assert.match(trace, /light=textureLoad\(lit,vec2i\(puv\*u\.a\.xy\),0\)\.rgb;/);
  // A linear composite into the newer result, then the display pass (SSGI ends the stack).
  assert.ok(codes.some((code) => code.includes('var gi:texture_2d<f32>') && code.includes('return vec4f(c,s.a);')));
  assert.ok(
    codes.some((code) => code.includes('let s=textureLoad(lit,vec2i(frag.xy),0);return vec4f(toDisplay(s.rgb),s.a);')),
  );
  // First frame: this frame's camera as last frame's and the input as the source: one bounce.
  const first = written(log, 80),
    camera = written(log, 176).subarray(16, 32);
  assert.deepEqual([...first.subarray(0, 16)], [...camera]);
  assert.equal(first[16], 1);
  const groups = (l) => l.filter((e) => e[0] === 'group').length;
  await null;
  const second = h.gpu.record(() => h.frame());
  await null;
  const third = h.gpu.record(() => h.frame());
  assert.equal(groups(third), 0, 'steady frames create no bind groups');
  assert.equal(
    third.filter((e) => /^(texture|buffer|module|renderPipeline|view|sampler)$/.test(e[0])).length,
    0,
    'steady frames create no GPU objects',
  );
  assert.equal(passes(second), passes(log), 'mips, trace, two blurs, composite, display');
  // Off again: the one-bounce composite straight into the output.
  ssgi.options.multiBounce = false;
  await null;
  const off = h.gpu.record(() => h.frame());
  assert.ok(!modules(off).some((code) => code.includes('var lit:')));
  assert.equal(passes(off), passes(log) - 1, 'no separate display pass');
  ssgi.dispose();
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), []);
});
