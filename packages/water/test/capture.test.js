import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Water } from '../dist/index.js';

/** A Water on the recording mock with its own depth texture, and a stand-in for SSR's capture hook. */
function rig() {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 4, format: 'rgba16float' }),
    makeDepth = () =>
      gpu.device.createTexture({
        size: [1280, 720],
        format: 'depth24plus-stencil8',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
  let depth = makeDepth();
  const engine = {
    gpu: gpu.device,
    lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
    stats: { drawCalls: 0 },
    sceneOf() {
      return { removePlugin() {} };
    },
  };
  const water = new Water({ depth: () => depth });
  water.setup(engine);
  const passes = [];
  water.registerPasses({ add: (p) => passes.push(p) });
  const drawn = [],
    pass = {
      setPipeline: (p) => drawn.push(['pipeline', p]),
      setBindGroup: (i, g) => drawn.push(['group', i, g]),
      setVertexBuffer: () => {},
      setIndexBuffer: () => {},
      drawIndexed: (n) => drawn.push(['draw', n]),
    };
  const hook = {
    targets: [{ format: 'rgba16float' }, { format: 'rgb10a2unorm' }, { format: 'rgb10a2unorm' }],
    declarations: () =>
      'struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}\n',
    begin: () => pass,
  };
  let index = 0;
  return {
    gpu,
    water,
    view,
    hook,
    drawn,
    /** Replaces the scene depth (a new post stack's), returning the new texture. */
    newDepth() {
      depth = makeDepth();
      return depth;
    },
    frame() {
      view.begin(index++);
      for (const p of passes) p.execute(view.c);
      view.end();
    },
  };
}
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test("water draws its sky reflection, weight and normal into SSR's capture hook", () => {
  const r = rig();
  r.water.setCapture(r.hook);
  r.water.draw(r.view.c, 'capture');
  assert.equal(r.drawn.length, 0, 'nothing before its first frame');
  r.frame();
  const log = r.gpu.record(() => r.water.draw(r.view.c, 'capture')),
    code = modules(log)[0],
    pipeline = log.find((e) => e[0] === 'renderPipeline')[2];
  assert.match(code, /@fragment fn fragment\(i:Output\)->MargoSSR\{/);
  assert.match(
    code,
    /let keep=reflection\*\(1\.0-shown\);_=body;_=glint\*shade;return MargoSSR\(vec4f\(skyColor\(reflect\(-v,n\),rough\)\*keep,rough\),vec4f\(vec3f\(keep\),1\),vec4f\(n\*0\.5\+0\.5,1\)\);/,
    'the sky reflection it added, times Fresnel and the foam share, as the specular SSR replaces',
  );
  assert.doesNotMatch(code, /return Result\(/);
  assert.deepEqual(
    [pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled],
    ['greater-equal', true],
    'its depth goes into what SSR traces',
  );
  assert.equal(pipeline.layout, 'auto');
  assert.ok(
    log.some((e) => e[0] === 'group'),
    'its own group 0 for the capture layout',
  );
  assert.equal(r.drawn.filter((d) => d[0] === 'draw').length, 1);
  r.drawn.length = 0;
  r.frame();
  assert.equal(modules(r.gpu.record(() => r.water.draw(r.view.c, 'capture'))).length, 0, 'pipeline and groups cached');
  let disposed = 0;
  r.water.onDispose(() => disposed++);
  r.water.dispose();
  r.water.draw(r.view.c, 'capture');
  assert.equal(disposed, 1);
  assert.equal(r.drawn.filter((d) => d[0] === 'draw').length, 1, 'nothing after disposal');
});

test('one water in two effects: each keeps its own capture stage and pipeline, built once', () => {
  const r = rig();
  r.frame();
  const hook = (tag, formats) => ({
    targets: formats.map((format) => ({ format })),
    declarations: () =>
      `// effect ${tag}\nstruct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}\n`,
    begin: () => r.hook.begin(),
  });
  const a = hook('a', ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm']),
    b = hook('b', ['rgba16float', 'rgb10a2unorm', 'rgb10a2unorm']),
    c = hook('c', ['rgba16float', 'rgba16float', 'rgb10a2unorm']);
  const draw = (h) => {
    r.water.setCapture(h);
    r.drawn.length = 0;
    const log = r.gpu.record(() => r.water.draw(r.view.c, 'capture'));
    return { codes: modules(log), pipeline: r.drawn.find((d) => d[0] === 'pipeline')?.[1] };
  };
  const first = draw(a),
    second = draw(b),
    third = draw(c);
  assert.match(first.codes[0], /^\/\/ effect a\n/);
  assert.equal(second.codes.length, 1, 'same targets, other declarations: its own stage');
  assert.match(second.codes[0], /^\/\/ effect b\n/);
  assert.match(third.codes[0], /^\/\/ effect c\n/);
  assert.notEqual(first.pipeline, second.pipeline);
  for (const [h, before] of [
    [a, first],
    [b, second],
    [c, third],
  ]) {
    const again = draw(h);
    assert.equal(again.codes.length, 0, 'alternating effects rebuild nothing');
    assert.equal(again.pipeline, before.pipeline);
  }
});

// KB-WATER-TARGETS1: before it the water wrote SSR's three fields for every effect, so SceneTargets (one field per
// output), MeshBlend (one) and LightBounce (one) got `return MargoSSR(specular, weight, normal)` against their own
// MargoSSR and the stage did not compile. Any effect that is not SSR gets its own margoSSR with the water's surface.
test("water hands any other effect's margoSSR its normal, body colour and roughness", () => {
  const r = rig();
  r.frame();
  const other = {
    targets: [{ format: 'rgba8unorm' }, { format: 'r8unorm' }, { format: 'r16float' }, { format: 'rgba8unorm' }],
    declarations: () =>
      'var<private> margoPosition:vec3f;\nstruct MargoSSR {@location(0) o0:vec4f,@location(1) o1:vec4f,@location(2) o2:vec4f,@location(3) o3:vec4f}\nfn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {_=n;_=v;_=metal;_=rough;return MargoSSR(vec4f(base,1),vec4f(1),vec4f(1),vec4f(1));}\n',
    begin: () => r.hook.begin(),
  };
  r.water.setCapture(other);
  const code = modules(r.gpu.record(() => r.water.draw(r.view.c, 'capture')))[0];
  assert.match(
    code,
    /margoPosition=i\.world;return margoSSR\(n,v,mix\(frame\.color\.rgb,foamColor,shown\),0\.0,rough\);/,
  );
  assert.doesNotMatch(code, /return MargoSSR\(vec4f\(skyColor/, "SSR's sky-replace fields only for SSR");
  // Without margoPosition declared (MeshBlend, LightBounce) the stage does not write it.
  r.water.setCapture({
    ...other,
    declarations: () => other.declarations().replace('var<private> margoPosition:vec3f;\n', ''),
  });
  const plain = modules(r.gpu.record(() => r.water.draw(r.view.c, 'capture')))[0];
  assert.doesNotMatch(plain, /margoPosition=/);
  assert.match(plain, /return margoSSR\(n,v,/);
  // SSR's hook still gets the reflection it replaces.
  r.water.setCapture(r.hook);
  assert.match(modules(r.gpu.record(() => r.water.draw(r.view.c, 'capture')))[0], /return MargoSSR\(vec4f\(skyColor/);
});

// A capture that runs before the surface's own draw in a frame (SceneTargets at -4.5, water at 4) used the groups of
// the frame before. After the post stack that owns the scene depth was replaced, they held the old stack's destroyed
// depth texture ("Destroyed texture used in a submit"; post scene-targets-water-browser.mjs). The capture rebinds the
// depth it reads when the scene depth changed since the surface last drew.
test('a capture before the surface draws binds the scene depth of this frame, not the replaced one', () => {
  const r = rig();
  r.water.setCapture(r.hook);
  r.frame();
  const depthViews = (log) => log.filter((e) => e[0] === 'view' && e[2]?.aspect === 'depth-only').length;
  assert.equal(depthViews(r.gpu.record(() => r.water.draw(r.view.c, 'capture'))), 0, 'same depth: nothing rebound');
  r.newDepth();
  const log = r.gpu.record(() => r.water.draw(r.view.c, 'capture'));
  assert.equal(depthViews(log), 1, 'a view of the new scene depth is made before the capture draws');
  assert.ok(
    log.some((e) => e[0] === 'group'),
    'and the capture groups are made again from it',
  );
  assert.equal(depthViews(r.gpu.record(() => r.water.draw(r.view.c, 'capture'))), 0, 'once');
});
