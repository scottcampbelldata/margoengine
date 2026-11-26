// Scatter material capture (KB-LOOK-MASKOCCLUDE1): `setCapture` lets SSR, SceneTargets and LightBounce draw the plants
// with their own lit stage, so the look masks see plants in front of the ground instead of the ground behind them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { Scatter } from '../dist/index.js';
import { captureStage } from '../src/capture.ts';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const declarations = (tag, outputs = 2) =>
  `// effect ${tag}\nvar<private> margoPosition:vec3f;\nstruct MargoSSR {${Array.from({ length: outputs }, (_, i) => `@location(${i}) o${i}:vec4f`).join(',')}}\nfn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {_=v;return MargoSSR(${Array.from({ length: outputs }, () => 'vec4f(base,rough)').join(',')});}\n`;

test("captureStage turns core's lit fragment into the hook's margoSSR, its lighting kept in a dead block", () => {
  const code = captureStage(wgsl, declarations('a'));
  assert.ok(code.startsWith('// effect a\n'), 'the declarations come first');
  assert.equal(code.match(/@fragment fn [^{]*->MargoSSR \{/g)?.length, 1, 'one MargoSSR fragment');
  assert.match(code, /@fragment fn fragment\(i:Output,@builtin\(front_facing\) front:bool\)->MargoSSR \{/);
  assert.equal(code.split('return margoSSR(').length, 2);
  assert.match(
    code,
    /if\(false\)\{let direct=[^]*_=vec4f\(select\(mapped\*12\.92,[^]*\);\}margoPosition=i\.position;return margoSSR\(n,v,i\.color,i\.material\.y,i\.material\.x\);\n\}/,
  );
  assert.match(code, /if\(!C&&!facing&&i\.material\.z<0\.5\)\{discard;\}/, 'single-sided discard stays live');
  assert.doesNotMatch(
    captureStage(wgsl, 'struct MargoSSR {@location(0) o0:vec4f}\n'),
    /margoPosition=/,
    'margoPosition only where declared',
  );
  // A shadow plugin's wrap of `direct` and code after the fragment (the LOD fade) stay as they were.
  const shadowed =
    wgsl.replace('let linear=direct*', 'let linear=shadowLit(direct,i.position,n)*') +
    '\nfn after()->vec4f {return vec4f(1);}\n';
  const wrapped = captureStage(shadowed, declarations('b'));
  assert.match(wrapped, /if\(false\)\{let direct=[^}]*let linear=shadowLit\(direct,i\.position,n\)\*/);
  assert.match(wrapped, /\nfn after\(\)->vec4f \{return vec4f\(1\);\}\n$/);
  assert.equal(captureStage('@fragment fn fragment(i:Output)->@location(0) vec4f {return vec4f(1);}', ''), undefined);
  assert.equal(captureStage(wgsl + wgsl.slice(wgsl.indexOf('@fragment')), ''), undefined, 'two fragments: not core');
});

function rig(options = {}) {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array([1, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 1]) };
  const scatter = new Scatter([box(), box(0.5), box(0.25)], {
    count: 16,
    material: new PbrMaterial({ color: [0.2, 0.5, 0.1], roughness: 0.7 }),
    ...options,
  });
  h.engine.use(scatter);
  const passes = [];
  const hook = (tag, formats = ['rgba16float', 'r8unorm']) => ({
    targets: formats.map((format) => ({ format })),
    declarations: () => declarations(tag, formats.length),
    begin() {
      const pass = h.context.encoder.beginRenderPass();
      passes.push(tag);
      return pass;
    },
  });
  const capture = () => {
    const before = h.pipelines.length,
      indirect = h.counts.indirect ?? 0;
    h.context.shader = wgsl;
    scatter.draw(h.context, 'capture');
    return { made: h.pipelines.slice(before), draws: (h.counts.indirect ?? 0) - indirect };
  };
  return { h, scatter, hook, passes, capture };
}

test("a lit Scatter draws its three rings into a capture hook's pass with its own stage, cached per effect", () => {
  const r = rig();
  r.h.frame();
  assert.deepEqual(r.capture(), { made: [], draws: 0 }, 'no hook: nothing');
  const a = r.hook('a'),
    stop = r.scatter.setCapture(a);
  const first = r.capture();
  assert.equal(first.draws, 3, 'near, middle and far ring');
  assert.equal(first.made.length, 1);
  const [pipeline] = first.made,
    code = pipeline.fragment.module.code;
  assert.ok(code.startsWith('// effect a\n'));
  assert.match(code, /->MargoSSR \{/);
  assert.match(code, /margoPosition=i\.position;return margoSSR\(n,v,i\.color,i\.material\.y,i\.material\.x\);/);
  assert.match(code, /@vertex fn vertex\(/, "scatter's own vertex stage");
  assert.deepEqual(
    pipeline.fragment.targets.map((t) => t.format),
    ['rgba16float', 'r8unorm'],
  );
  assert.deepEqual(
    [pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled, pipeline.depthStencil.format],
    ['greater-equal', true, 'depth32float'],
  );
  assert.equal(pipeline.fragment.constants, undefined, 'the back-face discard stays in the stage');
  assert.deepEqual(r.passes, ['a']);
  assert.equal(r.capture().made.length, 0, 'cached');
  // A second effect on the same Scatter keeps its own stage; the first stays cached.
  const b = r.hook('b', ['rgba8unorm']);
  r.scatter.setCapture(b);
  const second = r.capture();
  assert.equal(second.made.length, 1);
  assert.ok(second.made[0].fragment.module.code.startsWith('// effect b\n'));
  r.scatter.setCapture(a);
  assert.equal(r.capture().made.length, 0);
  // The colour pass is unchanged by the capture: no pipeline rebuilt there next frame.
  const before = r.h.pipelines.length;
  r.h.frame();
  assert.equal(r.h.pipelines.length, before, 'the colour pipelines stay cached');
  stop();
  r.scatter.setCapture(b)();
  assert.equal(r.capture().draws, 0, 'the remover detaches the hook');
  r.scatter.dispose();
});

test('replaced instance buffers are bound in the next capture, not the destroyed ones', () => {
  // ScatterTiles grows its rings by replacing `instances` and calling `instancesChanged`: the capture ring groups
  // were kept, so the next capture bound a destroyed buffer ("used in submit while destroyed" on a real GPU).
  const r = rig(),
    device = r.h.engine.gpu,
    made = device.createBindGroup?.bind(device),
    bound = [];
  device.createBindGroup = (descriptor) => ({ descriptor, inner: made?.(descriptor) });
  r.h.frame();
  const hook = r.hook('a'),
    begin = hook.begin;
  hook.begin = () => {
    const pass = begin();
    return new Proxy(pass, {
      get: (target, key) =>
        key === 'setBindGroup'
          ? (index, group, ...rest) => {
              if (index === 1) bound.push(group);
              return target.setBindGroup(index, group, ...rest);
            }
          : typeof target[key] === 'function'
            ? target[key].bind(target)
            : target[key],
    });
  };
  r.scatter.setCapture(hook);
  const buffer = (group) => group.descriptor.entries[0].resource.buffer;
  r.capture();
  assert.deepEqual(bound.map(buffer), r.scatter.instances, 'each ring group binds its ring');
  const old = r.scatter.instances[0];
  r.scatter.instances[0] = device.createBuffer({ size: old.size, usage: old.usage });
  old.destroy();
  r.scatter.instancesChanged();
  bound.length = 0;
  r.capture();
  assert.equal(buffer(bound[0]), r.scatter.instances[0], 'the new near ring is bound');
  assert.notEqual(buffer(bound[0]), old);
  r.scatter.dispose();
});

test('capture hooks are validated, an unlit Scatter refuses one, onDispose runs once and a disposed Scatter draws nothing', () => {
  const r = rig();
  r.h.frame();
  for (const bad of [undefined, {}, { declarations() {}, begin() {} }, { targets: [], begin() {} }])
    assert.throws(() => r.scatter.setCapture(bad), TypeError);
  const unlit = new Scatter(box(), { count: 4 });
  assert.throws(() => unlit.setCapture(r.hook('u')), { code: 'unsupported' });
  assert.throws(() => r.scatter.onDispose(1), TypeError);
  let calls = 0;
  r.scatter.onDispose(() => calls++);
  r.scatter.onDispose(() => calls++)();
  r.scatter.setCapture(r.hook('a'));
  r.scatter.dispose();
  r.scatter.dispose();
  assert.equal(calls, 1);
  assert.equal(r.capture().draws, 0);
  assert.throws(() => r.scatter.setCapture(r.hook('a')), TypeError);
});

test('textured scatter captures through its maps: base colour, roughness and metalness from the maps, cut-out kept', () => {
  const card = new Geometry(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 1, 2, 0, 2, 3],
  );
  const data = new Uint8Array(4 * 4 * 4).fill(255);
  const r = rig();
  const textured = new Scatter(card, {
    count: 4,
    material: new PbrMaterial({ color: [1, 1, 1] }),
    textures: { uvs: [0, 1, 1, 1, 1, 0, 0, 0], baseColor: { width: 4, height: 4, data }, alphaCutoff: 0.5 },
  });
  r.h.engine.use(textured);
  // A textured Scatter's colour pass needs core's lit stage, which the harness frame would swap for its stub.
  Object.defineProperty(r.h.context, 'shader', { get: () => wgsl, set() {}, configurable: true });
  r.h.frame();
  textured.setCapture(r.hook('t'));
  const before = r.h.pipelines.length;
  r.h.context.shader = wgsl;
  textured.draw(r.h.context, 'capture');
  const code = r.h.pipelines.slice(before)[0].fragment.module.code;
  assert.match(code, /return margoSSR\(n,v,surfColor,surfMetal,surfRough\);/);
  const cut = code.indexOf('if(surfBase.a<0.500000){discard;}');
  assert.ok(cut > 0 && cut < code.indexOf('return margoSSR('), 'the cut-out discard runs before the capture');
  textured.dispose();
  r.scatter.dispose();
});
