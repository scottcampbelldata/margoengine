import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, parseGLTF } from '../dist/index.js';
import { PBRInstances } from '../dist/instancing.js';
import { SectionPlanes } from '../../machinery/dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';
import { pbrShader } from '../src/shader.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function fixture(t, { transmission = false } = {}) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    input = await readFile(new URL('../../exporters/tests/fixtures/Box.glb', import.meta.url)),
    model = parseGLTF(engine, input),
    context = { ...gpu.context, camera: engine.camera },
    draws = [],
    sections = [];
  assert.ok(model.asset instanceof GLTFAsset, 'exercise the actual GLB container, accessor and primitive loader');
  assert.equal(model.primitives.length, 1);
  assert.equal(model.primitives[0].indices.length, 36);
  if (transmission) {
    const material = model.primitives[0].material;
    // Keep the real loaded geometry and install a native physical transmission material.
    material.physical = [0, 0, 0, 0.6, 1, 1, 1, 1, 0, 0, 0, 0];
    material.tint = [0.4, 0.5, 0.6];
    material.volume = [1, 1, 1, 1];
  }
  context.encoder.beginRenderPass = () => {
    let pipeline;
    const groups = new Map();
    return {
      setPipeline(value) {
        pipeline = value;
      },
      setBindGroup(index, value) {
        groups.set(index, value);
      },
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed(count, instances = 1) {
        draws.push({ pipeline, count, instances, groups: new Map(groups) });
      },
      end() {},
    };
  };
  engine.camera.update(128 / 96, true);
  store.tick(false);
  t.after(() => {
    for (const section of sections) section.value.dispose();
    engine.dispose();
    gpu.cleanup();
  });
  return {
    ...gpu,
    engine,
    model,
    context,
    draws,
    section(planes = [[1, 0, 0, 0]]) {
      const value = new SectionPlanes({ planes, cap: false });
      let clip;
      value.setup(engine);
      value.registerPasses({
        add(pass) {
          clip = pass.execute;
        },
      });
      const section = { value, clip };
      sections.push(section);
      return section;
    },
    frame(mode = 'beauty', section) {
      context.shader = wgsl;
      context.bindings = [];
      section?.clip(context);
      draws.length = 0;
      model.draw(context, mode, context.color, context.depth);
      return draws.slice();
    },
  };
}

function finalFragments(code) {
  const result = [];
  for (const match of code.matchAll(/@fragment\s+fn\s+(\w+)\([^]*?\{/g)) {
    const start = match.index + match[0].length;
    let end = start,
      depth = 1;
    for (; depth && end < code.length; end++) {
      if (code[end] === '{') depth++;
      if (code[end] === '}') depth--;
    }
    result.push({ name: match[1], body: code.slice(start, end - 1) });
  }
  return result;
}

function sectionBuffer(draw) {
  return draw.groups.get(0).entries.find((entry) => entry.binding === 2)?.resource.buffer;
}

function assertClipped(draw) {
  const code = draw.pipeline.fragment.module.code;
  assert.ok(/@group\(0\)\s*@binding\(2\)\s*var<uniform>/.test(code), 'the final shader declares the section binding');
  const fragments = finalFragments(code);
  assert.ok(fragments.length > 0);
  for (const { name, body } of fragments)
    assert.match(body, /dot\([^;]*i\.position[^;]*discard;/, `${name} clips the loaded asset in world space`);
  assert.ok(sectionBuffer(draw), 'the final fragment receives the live section uniform at group 0 binding 2');
}

test('loaded Box.glb retains the original PBR shader and bindings without SectionPlanes', async (t) => {
  const f = await fixture(t),
    [draw] = f.frame();
  assert.equal(draw.pipeline.fragment.module.code, pbrShader);
  assert.deepEqual(
    draw.groups.get(0).entries.map((entry) => entry.binding),
    [0],
  );
  assert.equal(draw.count, 36);
});

test('loaded Box.glb clips every PBR replay after instancing, side and occlusion transforms', async (t) => {
  const f = await fixture(t),
    section = f.section(),
    primitive = f.model.primitives[0];
  primitive.material.side = 'back';
  primitive.instances = new PBRInstances(2);
  primitive.instances.setMatrixAt(1, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
  for (const mode of ['beauty', 'ambient', 'gbuffer', 'occlusion']) {
    const draws = f.frame(mode, section);
    assert.equal(draws.length, 1, mode);
    assertClipped(draws[0]);
    assert.equal(draws[0].instances, 2, mode);
  }
});

test('loaded Box.glb section toggles and buffer replacement keep pipelines and refresh bindings', async (t) => {
  const f = await fixture(t),
    section = f.section(),
    [first] = f.frame('beauty', section),
    buffer = sectionBuffer(first);
  assertClipped(first);
  assert.equal(new Float32Array(buffer.data)[24], 1);
  section.value.enabled = false;
  const [off] = f.frame('beauty', section);
  assert.equal(off.pipeline, first.pipeline);
  assert.equal(off.groups.get(0), first.groups.get(0));
  assert.equal(new Float32Array(buffer.data)[24], 0);
  section.value.enabled = true;
  const [on] = f.frame('beauty', section);
  assert.equal(on.pipeline, first.pipeline);
  assert.equal(new Float32Array(buffer.data)[24], 1);
  const replacement = f.section([[0, 1, 0, 0.25]]),
    [next] = f.frame('beauty', replacement);
  assert.equal(next.pipeline, first.pipeline);
  assert.notEqual(next.groups.get(0), first.groups.get(0));
  assert.notEqual(sectionBuffer(next), buffer);
  assert.deepEqual([...new Float32Array(sectionBuffer(next).data).slice(0, 4)], [0, 1, 0, 0.25]);
  const [plain] = f.frame();
  assert.equal(plain.pipeline.fragment.module.code, pbrShader);
  assert.deepEqual(
    plain.groups.get(0).entries.map((entry) => entry.binding),
    [0],
  );
});

test('loaded Box.glb transmission tint binds and clips its otherwise unmapped first pass', async (t) => {
  const f = await fixture(t, { transmission: true }),
    section = f.section(),
    draws = f.frame('beauty', section);
  assert.equal(draws.length, 2);
  assert.equal(draws[0].pipeline.fragment.entryPoint, 'margoTint');
  for (const draw of draws) assertClipped(draw);
  assert.equal(sectionBuffer(draws[0]), sectionBuffer(draws[1]));
  const replacement = f.section([[0, 0, 1, 0]]),
    next = f.frame('beauty', replacement);
  for (let i = 0; i < next.length; i++) {
    assert.equal(next[i].pipeline, draws[i].pipeline);
    assert.notEqual(sectionBuffer(next[i]), sectionBuffer(draws[i]));
  }
});

for (const mode of ['capture', 'transparent'])
  test(`loaded Box.glb ${mode} replay clips its final fragment entry`, async (t) => {
    const f = await fixture(t),
      section = f.section(),
      hook = {
        targets: [{ format: 'rgba16float' }],
        bindings: () => [],
        begin: () => f.context.encoder.beginRenderPass({}),
        declarations: () =>
          mode === 'capture'
            ? 'struct MargoCapture{@location(0) color:vec4f}\nfn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {var o:MargoCapture;o.color=s.base;return o;}\n'
            : 'struct MargoTransparent{@location(0) color:vec4f}\nfn margoTransparent(color:vec4f,i:Out)->MargoTransparent {var o:MargoTransparent;o.color=color;return o;}\n',
      };
    if (mode === 'capture') f.model.setCapture(hook);
    else {
      f.model.primitives[0].material.settings[0] = 2;
      f.model.setTransparency(hook);
    }
    const [draw] = f.frame(mode, section);
    assert.equal(draw.pipeline.fragment.entryPoint, mode);
    assertClipped(draw);
  });

test('loaded Box.glb isolated renderer uses the destination view section buffer', async (t) => {
  const source = await fixture(t),
    target = await fixture(t),
    sourceSection = source.section(),
    targetSection = target.section([[0, 1, 0, 0.25]]),
    [main] = source.frame('beauty', sourceSection),
    [destination] = target.frame('beauty', targetSection),
    renderer = source.model.createRenderer(target.engine.gpu);
  t.after(() => renderer.dispose());
  target.draws.length = 0;
  renderer.prepare(target.context);
  renderer.draw(target.context, target.context.encoder.beginRenderPass({}), target.engine.camera.matrix);
  const [eye] = target.draws;
  assertClipped(eye);
  assert.equal(sectionBuffer(eye), sectionBuffer(destination));
  assert.notEqual(sectionBuffer(eye), sectionBuffer(main));
  const [again] = source.frame('beauty', sourceSection);
  assert.equal(again.pipeline, main.pipeline);
  assert.equal(sectionBuffer(again), sectionBuffer(main));
});
