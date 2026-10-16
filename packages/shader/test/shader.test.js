import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { boxGeometry } from '../../geometry/dist/index.js';
import { Texture, Material, createMesh } from '../../materials/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { PostStack, FXAA } from '../../post/dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';
import { compactOutput } from '../../../scripts/measure-size.js';
import * as S from '../dist/index.js';
const {
  NodeMaterial,
  NodePass,
  ComputePass,
  storage,
  uniform,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  float,
  color,
  mix,
  smoothstep,
  sin,
  clamp,
  time,
  deltaTime,
  positionLocal,
  normalLocal,
  normalWorld,
  inputColor,
  inputDepth,
  materialColor,
  loop,
  Fn,
  wgslFn,
  select,
  varying,
  instanceIndex,
  screenUV,
  dot,
} = S;

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
/** Generated WGSL is compared byte for byte; UPDATE_SNAPSHOTS=1 rewrites the files. */
async function snapshot(name, text) {
  const file = snapshots + name + '.wgsl';
  if (process.env.UPDATE_SNAPSHOTS) {
    await mkdir(snapshots, { recursive: true });
    await writeFile(file, text);
    return;
  }
  assert.equal(
    text,
    (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
    name + ' WGSL changed (UPDATE_SNAPSHOTS=1 to accept)',
  );
}
const gradient = () => {
  const tint = uniform('#ff8800', { name: 'tint' }),
    wave = sin(time.add(uv().y.mul(10)))
      .mul(0.5)
      .add(0.5);
  return {
    tint,
    options: {
      colorNode: mix(color('#2040ff'), tint, uv().y).mul(wave),
      roughnessNode: uv().y,
      positionNode: positionLocal.add(normalLocal.mul(wave.mul(0.1))),
      emissiveNode: varying(positionLocal).mul(0.1),
      normalNode: normalWorld,
    },
  };
};

test('material nodes generate stable, readable WGSL with shared subexpressions', async () => {
  const a = new NodeMaterial(gradient().options),
    b = new NodeMaterial(gradient().options);
  await snapshot('material-fragment', a.fragmentCode);
  await snapshot('material-vertex', a.vertexCode);
  await snapshot('material-declarations', a.program.declare(2) + a.varyingFields);
  assert.equal(a.fragmentCode, b.fragmentCode, 'equal graphs give equal text, so pipelines cache');
  assert.equal(a.fragmentCode.match(/i\.uv\.y/g).length, 1, 'uv().y built three times is computed once');
  assert.match(a.fragmentCode, /let nd0 = i\.uv\.y;/);
  assert.equal(
    a.varyingFields.match(/ndv/g).length,
    1,
    'explicit varying(positionLocal) and positionLocal share one varying',
  );
});

test('dead nodes, unused uniforms and unused resources are not emitted', () => {
  const unused = uniform(3, { name: 'unused' }),
    tex = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  texture(tex).add(unused);
  const m = new NodeMaterial({ colorNode: vec3(1, 0, 0) });
  assert.equal(m.program.declare(2), '');
  assert.equal(m.fragmentCode.trim(), 's.base = vec4f(vec3f(1.0, 0.0, 0.0), s.base.a);');
  assert.ok(!m.vertexCode.includes('let nd'));
  const pass = new NodePass(inputColor().rgb.mul(0.5));
  assert.ok(!pass.code().includes('sampler') && !pass.code().includes('NdUniforms') && !pass.code().includes('depth'));
});

test('types are checked with clear errors', () => {
  assert.throws(() => vec3(1, 2, 3).add(vec2(1, 2)), /vec3f \+ vec2f: operand types do not combine/);
  assert.throws(() => vec2(1, 2).z, /out of range/);
  assert.throws(() => vec3(1, 2), /vec3f needs 3 components, got 2/);
  assert.throws(() => mix(vec3(1), vec2(1), 0.5), /operand types do not match/);
  assert.throws(() => S.int(1.5), /not a valid i32/);
  assert.throws(() => float(NaN), /finite/);
  assert.throws(() => uniform(1, { name: 'loop' }), /not a usable WGSL identifier/);
  assert.throws(() => (uniform(1).value = [1, 2]), /needs 1 finite/);
  assert.throws(() => new NodeMaterial({ colorNode: float(1) }), /colorNode must be a vec3f or vec4f/);
  assert.throws(() => new NodeMaterial({ colorNode: inputColor() }), /only available in NodePass/);
  assert.throws(() => new NodePass(vec3(positionLocal)), /positionLocal is not available in post nodes/);
  const bad = Fn((c) => c.mul(uv().x), 'scale');
  assert.throws(() => new NodePass(bad(vec3(1))), /cannot be read inside Fn/);
  assert.throws(
    () =>
      new NodeMaterial({
        colorNode: vec3(1).mul(
          Array.from({ length: 9 }, (_, i) => varying(positionLocal.mul(i + 1)).x).reduce((s, v) => s.add(v)),
        ),
      }),
    /8 varyings/,
  );
  assert.equal(vec3(1).mul(S.mat3(vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1))).type, 'vec3f');
  assert.equal(S.mat4(...Array(16).fill(0)).mul(vec4(1)).type, 'vec4f');
  assert.equal(float(2).xxx.type, 'vec3f');
  assert.equal(vec4(1).rgb.type, 'vec3f');
  assert.equal(vec3(1).lessThan(0.5).type, 'vec3<bool>');
});

test('loops, select, Fn and wgslFn emit functions and scoped statements', async () => {
  const luminance = Fn((c) => dot(c, vec3(0.2126, 0.7152, 0.0722)), 'luminance');
  const fade = wgslFn('fn fade(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }');
  const blur = loop(4, vec3(0), (i, acc) => acc.add(inputColor(uv().add(vec2(i.toFloat().mul(0.002), 0))).rgb));
  const graded = blur.div(4),
    l = luminance(graded);
  const node = select(l.greaterThan(0.5), graded, mix(vec3(l), graded, fade(uv().x)));
  const code = new NodePass(node).code();
  await snapshot('post-loop-fn', code);
  assert.equal(code.match(/fn luminance\(p0:vec3f\) -> f32/g).length, 1, 'one function per signature');
  const twice = Fn((c) => c.mul(2), 'twice');
  assert.match(
    new NodePass(twice(vec3(1)).add(twice(S.vec4(1)).xyz)).code(),
    /fn twice\(p0:vec3f\) -> vec3f[\s\S]*fn twice_1\(p0:vec4f\) -> vec4f/,
    'a second signature gets a suffix',
  );
  assert.equal(code.match(/fn fade/g).length, 1);
  assert.match(code, /for \(var nd\d+ = 0i; nd\d+ < 4i; nd\d+\+\+\) \{/);
  assert.throws(() => fade(1, 2), /takes 1 arguments/);
});

test('NodeMaterial draws through materials and gltf-pro with node bindings; uniforms update without recompiling', async () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    store = await TransformStore.create(64);
  device.limits.maxTextureDimension2D = 8192;
  device.queue.writeTexture = () => {};
  device.queue.copyExternalImageToTexture = () => {};
  const create = device.createTexture;
  device.createTexture = (d) => {
    const t = create(d);
    t.createView = (v = {}) => ({ texture: t, ...v });
    return t;
  };
  device.queue.submit = () => {};
  device.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  const c = { ...h.context, camera: engine.camera },
    frame = () => {
      store.tick(false);
      engine.frameGraph.execute(c);
    };
  try {
    const map = new Texture({ data: new Uint8Array(16).fill(255), width: 2, height: 2 }),
      strength = uniform(0.25, { name: 'strength' });
    const material = new NodeMaterial({
      map,
      colorNode: texture(map).rgb.mul(materialColor.rgb).mul(strength),
      opacityNode: strength,
      transparent: true,
    });
    const mesh = createMesh(engine, boxGeometry(1, 1, 1), material),
      plain = createMesh(engine, boxGeometry(1, 1, 1), new Material());
    frame();
    const beauty = () => h.pipelines.filter((p) => p.fragment?.entryPoint === 'fragment' && p.vertex.buffers?.length),
      code = beauty()
        .map((p) => p.vertex.module.code)
        .find((s) => s.includes('NdUniforms'));
    assert.ok(code, 'node material pipeline');
    assert.equal(beauty().length, 2, 'plain material keeps its own pipeline');
    assert.match(
      code,
      /^@group\(2\) @binding\(48\) var ndt0:texture_2d<f32>;\n@group\(2\) @binding\(49\) var ndt0s:sampler;\nstruct NdUniforms \{\n  strength:f32,\n\}\n@group\(2\) @binding\(50\) var<uniform> ndu:NdUniforms;/,
    );
    assert.match(
      code,
      /s\.base = vec4f\(\(textureSample\(ndt0, ndt0s, i\.uv\.xy\)\.xyz \* s\.base\.xyz\) \* ndu\.strength, s\.base\.a\);\n  s\.base\.a = ndu\.strength;\n  if\(margoFaceTest&&!facing/,
    );
    assert.ok(code.includes('textureSample(mat_baseMap,'), 'materials maps still apply');
    const group = h.groups.findLast((g) => g.entries.some((e) => e.binding === 50)),
      buffer = group.entries.find((e) => e.binding === 50).resource.buffer;
    assert.equal(
      group.entries.find((e) => e.binding === 48).resource.texture.format,
      'rgba8unorm-srgb',
      'texture() binds the shared materials Texture',
    );
    assert.deepEqual(
      group.entries.map((e) => e.binding),
      [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 48, 49, 50],
    );
    assert.equal(new Float32Array(buffer.data)[0], 0.25);
    const pipelines = h.pipelines.length,
      groups = h.counts.groups;
    strength.value = 0.75;
    frame();
    frame();
    assert.equal(new Float32Array(buffer.data)[0], 0.75, 'new value uploaded');
    assert.equal(h.pipelines.length, pipelines, 'no new pipeline');
    assert.equal(h.counts.groups, groups, 'no new bind group');
    assert.equal(mesh.primitives[0].material.settings[0], 2, 'Material options still apply');
    mesh.destroy();
    plain.destroy();
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('node overrides patch compact, extended and physical gltf-pro shader variants', async () => {
  const { pbrShader, extendedPBRShader, physicalShader } = await import('../../gltf-pro/src/shader.ts');
  const m = new NodeMaterial({
    colorNode: vec3(1, 0, 0),
    positionNode: positionLocal.mul(2),
    emissiveNode: varying(normalLocal),
  });
  for (const source of [pbrShader, extendedPBRShader, physicalShader()]) {
    const code = m.shader(source, 2);
    const faceTest = source.includes('override margoFaceTest:') ? 'margoFaceTest&&' : '';
    assert.ok(
      code.includes(
        `  s.base = vec4f(vec3f(1.0, 0.0, 0.0), s.base.a);\n  s.emissive = i.ndv0;\n  if(${faceTest}!facing&&f.settings.z<0.5){discard;}`,
      ),
    );
    assert.ok(
      code.includes('let p=f.model*vec4f(i.position.xyz * 2.0,1);\n  o.ndv0 = i.normal.xyz;') &&
        code.includes('@location(8) ndv0:vec3f\n}'),
    );
    assert.equal(m.shader(source, 2), code, 'cached per source');
  }
  assert.ok(
    m.shader(physicalShader(), 2).indexOf('s.base = vec4f') > m.shader(physicalShader(), 2).indexOf('s.f0='),
    'nodes run after the physical layer inputs',
  );
});

test('the shader patch fails loudly on an unknown gltf-pro shader and caches per source', () => {
  const m = new NodeMaterial({ colorNode: vec3(1) });
  assert.throws(() => m.shader('fn other() {}', 2), /standard gltf-pro PBR shader|Materials require/);
});

/** Engine stand-in over the recording mock GPU, as in @margoengine/post's stack tests. */
function stackHarness(samples = 4) {
  const gpu = mockGPU(),
    graph = new FrameGraph(),
    plugins = new Map();
  const engine = {
    gpu: gpu.device,
    frameGraph: graph,
    hasPlugin: (name) => plugins.has(name),
    use(plugin) {
      graph.withOwner(plugin.name, () => {
        plugin.setup(engine);
        plugin.registerPasses?.(graph);
      });
      plugins.set(plugin.name, plugin);
      return engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      if (plugin) {
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      }
    },
  };
  const view = context(gpu, { samples, shader: wgsl, format: 'bgra8unorm' });
  let index = 0;
  return {
    gpu,
    engine,
    view,
    plugins,
    frame: () => {
      view.begin(index++);
      graph.execute(view.c);
    },
  };
}

test('NodePass joins PostStack in HDR and LDR positions, binds input, depth and uniforms, and caches its pipeline', async () => {
  const h = stackHarness(4),
    amount = uniform(0.5, { name: 'amount' });
  const vignette = new NodePass(inputColor().rgb.mul(smoothstep(0.8, 0.2, screenUV.sub(0.5).length()).mul(amount)), {
    name: 'vignette',
  });
  const fog = new NodePass(
    mix(inputColor().rgb, vec3(0.6, 0.7, 0.8), clamp(float(1).sub(inputDepth().mul(50)), 0, 1)),
    { kind: 'hdr', name: 'fog' },
  );
  await snapshot('post-vignette', vignette.code());
  await snapshot('post-fog-encoded', fog.code(true));
  const stack = PostStack.attach(h.engine, [fog, new Tonemap(), vignette, new FXAA()]);
  const calls = h.gpu.record(() => {
    h.frame();
    h.frame();
  });
  const modules = calls.filter(([name]) => name === 'module').map(([, , d]) => d.code);
  assert.equal(modules.filter((code) => code.includes('ndu.amount')).length, 1, 'vignette compiled once');
  assert.ok(
    modules.some((code) => code.includes('texture_depth_2d') && !code.includes('aces(')),
    'fog before a display effect stays linear',
  );
  const groups = calls.filter(([name]) => name === 'group').map(([, , d]) => d.entries.map((e) => e.binding));
  assert.deepEqual(
    groups.filter((b) => b.length === 3),
    [[0, 1, 2]],
    'fog: input, depth, uniforms; bind group reused next frame',
  );
  amount.value = 0.9;
  const next = h.gpu.record(() => h.frame());
  assert.ok(
    !next.some(([name]) => name === 'module' || name === 'renderPipeline'),
    'uniform change does not recompile',
  );
  stack.dispose();
  assert.equal(h.plugins.size, 0);
  // Alone in a stack, an HDR pass is the display output and encodes.
  const g = stackHarness(1),
    alone = new NodePass(inputColor().rgb, { kind: 'hdr' }),
    log = g.gpu.record(() => {
      PostStack.attach(g.engine, [alone]);
      g.frame();
    });
  assert.ok(log.some(([name, , d]) => name === 'module' && d.code.includes('aces(')));
  assert.throws(() => g.engine.use(new NodePass(vec3(1))), /runs inside a PostStack/);
  assert.throws(() => PostStack.attach(stackHarness().engine, [alone]), /already attached/);
});

test('ComputePass writes a storage buffer every frame and other nodes read it', async () => {
  const h = optionalGPU(),
    field = storage(new Float32Array(4 * 256), 'vec4f'),
    speed = uniform(2, { name: 'speed' });
  const pass = new ComputePass(
    256,
    (i) => {
      const p = field.element(i);
      return field.store(i, p.add(vec4(0, speed.mul(deltaTime), 0, 0)));
    },
    { name: 'rise' },
  );
  await snapshot('compute-rise', pass.code);
  assert.match(pass.code, /var<storage, read_write> ndb0:array<vec4f>;/);
  h.engine.use(pass);
  h.frame();
  h.frame();
  assert.equal(h.counts.compute, 2);
  assert.equal(h.pipelines.filter((p) => p.compute).length, 1);
  const groups = h.groups.length;
  speed.value = 3;
  h.frame();
  assert.equal(h.groups.length, groups, 'bind group reused');
  const read = new NodeMaterial({ colorNode: field.element(3).xyz });
  assert.match(read.program.declare(2), /@group\(2\) @binding\(48\) var<storage, read> ndb0:array<vec4f>;/);
  assert.equal(
    read.program.entries(h.engine.gpu, { width: 1, height: 1 })[0].resource.buffer,
    field.buffer(h.engine.gpu),
    'material reads the computed buffer',
  );
  assert.throws(() => new ComputePass(4, () => []), /storage\.store/);
  assert.throws(
    () => new NodeMaterial({ colorNode: vec3(instanceIndex.toFloat()) }),
    /instanceIndex is not available in fragment/,
  );
  h.engine.removePlugin(pass.name);
  field.dispose();
  h.cleanup();
});

test('discard() cuts out fragments in material and post nodes and is refused elsewhere', async () => {
  const map = new Texture({ data: new Uint8Array(16).fill(255), width: 2, height: 2 }),
    cut = uniform(0.5, { name: 'cut' });
  const m = new NodeMaterial({
    colorNode: S.discard(texture(map).a.lessThan(cut).or(S.positionWorld.y.greaterThan(1)), texture(map).rgb),
    roughnessNode: 0.5,
  });
  await snapshot('material-discard', m.fragmentCode);
  assert.ok(
    m.fragmentCode.indexOf('{ discard; }') < m.fragmentCode.indexOf('s.base ='),
    'discard runs before the slots are written',
  );
  assert.equal(m.fragmentCode.match(/textureSample/g).length, 1, 'condition and value share one sample');
  const pass = new NodePass(S.discard(inputDepth().equal(0), inputColor()));
  await snapshot('post-discard', pass.code());
  assert.equal(
    new NodeMaterial({ colorNode: S.discard(true, vec3(1)) }).fragmentCode,
    new NodeMaterial({ colorNode: S.discard(true, vec3(1)) }).fragmentCode,
  );
  assert.throws(
    () => new NodeMaterial({ positionNode: S.discard(true, positionLocal) }),
    /discard\(\) is not available in vertex nodes/,
  );
  assert.throws(
    () => new ComputePass(4, (i) => storage(4, 'f32').store(i, S.discard(true, float(1)))),
    /not available in compute nodes/,
  );
  assert.throws(() => S.discard(vec3(1), vec3(1)), /discard condition must be bool, got vec3f/);
});

test('atomics on u32/i32 storage: ordered read-modify-write, compaction and clear errors', async () => {
  const h = optionalGPU(),
    counter = storage(4, 'u32', { atomic: true }),
    visible = storage(256, 'u32'),
    signed = storage(1, 'i32', { atomic: true });
  const pass = new ComputePass(
    256,
    (i) => {
      counter.atomicMax(1, i);
      counter.atomicMin(2, i);
      signed.atomicAdd(0, -1);
      const keep = i.mod(2).equal(0),
        slot = counter.atomicAdd(0, select(keep, S.uint(1), S.uint(0)));
      return [visible.store(select(keep, slot, 255), i), counter.atomicStore(3, counter.atomicLoad(0))];
    },
    { name: 'cull' },
  );
  await snapshot('compute-atomics', pass.code);
  assert.match(pass.code, /var<storage, read_write> ndb0:array<atomic<u32>>;/);
  assert.ok(
    pass.code.indexOf('atomicMax') < pass.code.indexOf('atomicMin') &&
      pass.code.indexOf('atomicMin') < pass.code.indexOf('atomicAdd(&ndb1'),
    'atomics run in the order they were made',
  );
  const count = new ComputePass(8, () => {
    counter.atomicAdd(0, 1);
  });
  assert.match(count.code, /let nd0 = atomicAdd\(&ndb0\[0u\], 1u\);/, 'an unused atomic still runs');
  assert.equal(
    new ComputePass(8, () => [counter.atomicAdd(0, 1), counter.atomicAdd(0, 1)]).code.match(/atomicAdd/g).length,
    2,
    'equal atomics are not merged',
  );
  const looped = new ComputePass(8, () => {
    counter.atomicAdd(
      0,
      loop(3, S.uint(0), (k, acc) => acc.add(counter.atomicAdd(1, 1))),
    );
  });
  assert.match(
    looped.code,
    /for \([^]*atomicAdd\(&ndb0\[1u\], 1u\)[^]*\}\n[^]*atomicAdd\(&ndb0\[0u\]/,
    'an atomic inside a loop runs in the loop',
  );
  assert.match(
    new ComputePass(1, (i) => storage(1, 'u32').store(0, counter.element(i))).code,
    /atomicLoad\(&ndb\d\[gid\.x\]\)/,
    'element() on atomic storage loads atomically',
  );
  const read = new NodeMaterial({ colorNode: vec3(counter.element(0).toFloat()) });
  assert.match(read.program.declare(2), /var<storage, read> ndb0:array<u32>;/);
  assert.match(read.fragmentCode, /ndb0\[0u\]/);
  assert.throws(() => storage(1, 'f32', { atomic: true }), /u32 or i32/);
  assert.throws(() => storage(1, 'u32').atomicAdd(0, 1), /needs storage\(data, 'u32', \{atomic: true\}\)/);
  assert.throws(
    () => new NodeMaterial({ colorNode: vec3(counter.atomicAdd(0, 1).toFloat()) }),
    /only available in ComputePass/,
  );
  assert.throws(() => counter.atomicAdd(0, 1.5), /not a valid u32/);
  h.engine.use(pass);
  h.frame();
  assert.equal(h.counts.compute, 1);
  h.engine.removePlugin(pass.name);
  h.cleanup();
});

test('atomic methods are typed for u32/i32 storage only', async () => {
  const { execFileSync } = await import('node:child_process'),
    { rm } = await import('node:fs/promises');
  const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    file = fileURLToPath(new URL('../dist/__types-check.ts', import.meta.url));
  // An unused @ts-expect-error is itself an error, so this fails if f32 storage ever accepts atomics.
  await writeFile(
    file,
    `import {storage} from './index.js';\nstorage(1, 'u32', {atomic: true}).atomicAdd(0, 1);\nstorage(1, 'i32', {atomic: true}).atomicMin(0, -1);\n// @ts-expect-error f32 storage has no atomics\nstorage(1, 'f32').atomicAdd(0, 1);\n`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--types',
        'node',
        file,
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    assert.fail(String(e.stdout));
  } finally {
    await rm(file, { force: true });
  }
});

test('importing a colour node and NodeMaterial leaves post, compute and textures out of the bundle', async (t) => {
  const { build } = await import('vite'),
    { gzipSync } = await import('node:zlib'),
    { mkdtemp, writeFile: write, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const dist = JSON.stringify(fileURLToPath(new URL('../dist/index.js', import.meta.url)).replaceAll('\\', '/'));
  const folder = await mkdtemp(join(tmpdir(), 'margoengine-shader-shake-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let n = 0;
  const bundle = async (code) => {
    const file = join(folder, `entry${n++}.js`);
    await write(file, code);
    const out = await build({
      root: folder,
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: true,
        target: 'es2022',
        lib: { entry: file, formats: ['es'], fileName: 'entry' },
        rollupOptions: { external: (id) => id.startsWith('@margoengine/'), output: compactOutput },
      },
    });
    const text = (Array.isArray(out) ? out[0] : out).output
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');
    return { text, gzip: gzipSync(text).length };
  };
  const all = await bundle(`export * from ${dist};`),
    minimal = await bundle(`export {NodeMaterial, mix, uv, color, vec3} from ${dist};`);
  console.log(`shader gzip: whole package ${all.gzip} B, NodeMaterial + mix/uv/color ${minimal.gzip} B`);
  for (const marker of ['@compute', 'texture_depth_2d', 'textureSampleLevel', 'read_write', 'aces('])
    assert.ok(!minimal.text.includes(marker), marker + ' (compute, post or texture code) was not shaken out');
  assert.ok(minimal.gzip < all.gzip * 0.6, `minimal ${minimal.gzip} vs all ${all.gzip}`);
  assert.ok(minimal.gzip < 6500 && all.gzip < 12500, `size budget: minimal ${minimal.gzip}, whole ${all.gzip}`);
});
