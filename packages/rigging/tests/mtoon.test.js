import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MToon } from '../dist/mtoon.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf/dist/pbr.js';
import { animatedTriangle } from '../../../tests/support/gltf-pbr-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
async function fixture(definitions = [{ specVersion: '1.0' }], modes = definitions.map(() => 'OPAQUE'), image) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  const data = animatedTriangle(),
    primitive = data.doc.meshes[0].primitives[0];
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  data.doc.materials = definitions.map((extension, i) => ({
    alphaMode: modes[i],
    pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.8, 1] },
    extensions: { VRMC_materials_mtoon: extension },
  }));
  data.doc.meshes[0].primitives = definitions.map((_, material) => ({ ...primitive, material }));
  if (image) {
    data.doc.images = [{}];
    data.doc.textures = [{ source: 0 }];
  }
  const model = parseGLTF(engine, data.doc, data.buffers, image ? [image] : []);
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const context = { ...gpu.context, camera: engine.camera };
  return {
    gpu,
    engine,
    model,
    frame() {
      model.draw(context, 'beauty', context.color, context.depth);
    },
  };
}
test('MToon uploads retained Node texture pixels without a browser image source', async () => {
  const image = { width: 2, height: 2, data: new Uint8Array(16).fill(127) };
  const f = await fixture([{ specVersion: '1.0', shadeMultiplyTexture: { index: 0 } }], ['OPAQUE'], image);
  const writes = [],
    device = f.engine.gpu;
  const write = device.queue.writeTexture;
  device.queue.writeTexture = (to, bytes, layout, size) => {
    writes.push({ bytes, layout, size });
    write(to, bytes, layout, size);
  };
  try {
    MToon.attach(f.model);
    f.frame();
    assert.ok(writes.some((w) => w.bytes === image.data && w.layout.bytesPerRow === 8));
  } finally {
    f.engine.dispose();
  }
});
test('MToon belongs to the model scene and disposal restores author records without disposing the model', async () => {
  const f = await fixture(),
    original = f.model.primitives.map((p) => p.material),
    before = f.gpu.resources.length,
    effect = MToon.attach(f.model);
  try {
    assert.equal(f.engine.sceneOf(effect), f.engine.sceneOf(f.model));
    assert.equal(effect.materials.size, 1);
    assert.throws(() => {
      effect.disposed = true;
    }, TypeError);
    f.frame();
    const textures = f.gpu.resources.slice(before).filter((r) => typeof r.createView === 'function');
    assert.ok(textures.length > 0);
    effect[Symbol.dispose]();
    await Promise.resolve();
    assert.equal(effect.disposed, true);
    assert.equal(f.model.disposed, false);
    assert.deepEqual(
      f.model.primitives.map((p) => p.material),
      original,
    );
    assert.equal(f.engine.sceneOf(effect), undefined);
    assert.ok(textures.every((t) => t.destroyed));
    f.frame();
  } finally {
    effect.dispose();
    f.engine.dispose();
  }
});
test('model-first disposal takes its MToon adapter and GPU resources with it', async () => {
  const f = await fixture(),
    effect = MToon.attach(f.model);
  try {
    f.frame();
    f.model.dispose();
    assert.equal(effect.disposed, true);
    assert.equal(f.engine.sceneOf(effect), undefined);
    effect.dispose();
  } finally {
    f.engine.dispose();
  }
});

for (const [mode, outline] of [
  ['OPAQUE', false],
  ['MASK', true],
  ['BLEND', true],
])
  test(`mixed MToon and ${mode} materials each reach the beauty pass exactly once (outline ${outline})`, async () => {
    const f = await fixture(
        [
          {
            specVersion: '1.0',
            outlineWidthMode: outline ? 'worldCoordinates' : 'none',
            outlineWidthFactor: outline ? 0.01 : 0,
          },
          undefined,
        ],
        ['OPAQUE', mode],
      ),
      original = f.model.primitives.map((p) => p.material),
      effect = MToon.attach(f.model),
      selected = f.model.primitives.map((p) => p.material),
      draws = [];
    const begin = f.gpu.context.encoder.beginRenderPass;
    f.gpu.context.encoder.beginRenderPass = (...args) => {
      const pass = begin(...args);
      let pipeline;
      return {
        ...pass,
        setPipeline(value) {
          pipeline = value;
        },
        drawIndexed() {
          draws.push(pipeline.fragment.module.code);
        },
      };
    };
    try {
      f.frame();
      const visible = draws.filter((code) => !/@fragment fn fragment\([^{]*\{\s*discard;/.test(code));
      assert.equal(visible.length, outline ? 3 : 2, 'each body and enabled outline must draw once');
      assert.deepEqual(
        f.model.primitives.map((p) => p.material),
        selected,
      );
      effect.dispose();
      assert.deepEqual(
        f.model.primitives.map((p) => p.material),
        original,
      );
    } finally {
      effect.dispose();
      f.engine.dispose();
    }
  });
test('all material validation completes before earlier records or scene ownership change', async () => {
  const f = await fixture([{ specVersion: '1.0' }, { specVersion: '1.0', outlineWidthFactor: -1 }]),
    original = f.model.primitives.map((p) => p.material);
  try {
    assert.throws(() => MToon.attach(f.model), RangeError);
    assert.deepEqual(
      f.model.primitives.map((p) => p.material),
      original,
    );
  } finally {
    f.engine.dispose();
  }
});
test('authored queue offsets respect both blend ranges; opaque and mask offsets are ignored', async () => {
  // VRMC_materials_mtoon 1.0: "renderQueueOffsetNumber only works when alphaMode is BLEND" (audit p4 R20).
  for (const [mode, writing, offset, refused] of [
    ['OPAQUE', false, 1, false],
    ['MASK', false, -1, false],
    ['BLEND', false, 1, true],
    ['BLEND', true, -1, true],
  ]) {
    const f = await fixture(
      [{ specVersion: '1.0', transparentWithZWrite: writing, renderQueueOffsetNumber: offset }],
      [mode],
    );
    try {
      if (refused) assert.throws(() => MToon.attach(f.model), RangeError);
      else {
        MToon.attach(f.model);
        f.frame();
      }
    } finally {
      f.engine.dispose();
    }
  }
});
test('expression texture moves leave the matcap alone and an absent matcap samples black (audit p4 R17, R18)', async () => {
  const image = { width: 2, height: 2, data: new Uint8Array(16).fill(127) };
  const f = await fixture(
    [{ specVersion: '1.0', shadeMultiplyTexture: { index: 0 }, matcapTexture: { index: 0 } }],
    ['OPAQUE'],
    image,
  );
  const expressions = {
    evaluate: () => ({
      morphs: [],
      colors: [],
      transforms: [{ material: 0, parts: [{ value: 1, scale: [2, 2], offset: [0.5, 0.25] }] }],
    }),
  };
  try {
    const mtoon = MToon.attach(f.model, { expressions });
    f.frame();
    const v = mtoon.states[0].values,
      rowOf = (k) => Array.from(v.subarray((8 + k * 3) * 4, (8 + k * 3) * 4 + 8));
    assert.deepEqual(rowOf(0), [2, 0, 0.5, 0, -0, 2, 0.25, 0], 'the shade map moves');
    assert.deepEqual(rowOf(2), [1, 0, 0, 0, -0, 1, 0, 0], 'the matcap keeps its own transform');
  } finally {
    f.engine.dispose();
  }
  const g = await fixture([{ specVersion: '1.0' }]),
    writes = [],
    queue = g.engine.gpu.queue,
    write = queue.writeTexture;
  queue.writeTexture = (to, bytes, layout, size) => {
    writes.push(Array.from(bytes));
    write.call(queue, to, bytes, layout, size);
  };
  try {
    MToon.attach(g.model);
    g.frame();
    // Six 1x1 stand-ins: shading shift and matcap black, the multiply maps and the mask white.
    assert.equal(writes.filter((w) => w.join() === '0,0,0,255').length, 2);
    assert.equal(writes.filter((w) => w.join() === '255,255,255,255').length, 4);
  } finally {
    g.engine.dispose();
  }
});
test('blended MToon queues draw across models by renderQueueOffsetNumber, then in model order (KB5289a)', async () => {
  const gpu = optionalGPU(),
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  const load = (offsets) => {
    const data = animatedTriangle(),
      primitive = data.doc.meshes[0].primitives[0];
    delete data.doc.skins;
    delete data.doc.animations;
    delete data.doc.nodes[0].skin;
    data.doc.materials = offsets.map((renderQueueOffsetNumber) => ({
      alphaMode: renderQueueOffsetNumber === undefined ? 'OPAQUE' : 'BLEND',
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.8, 0.5] },
      extensions: {
        VRMC_materials_mtoon: { specVersion: '1.0', renderQueueOffsetNumber: renderQueueOffsetNumber ?? 0 },
      },
    }));
    data.doc.meshes[0].primitives = offsets.map((_, material) => ({ ...primitive, material }));
    return parseGLTF(engine, data.doc, data.buffers, []);
  };
  // Scene order A, B; queues A0 2991, A1 3000, B0 2995. Unity and UniVRM draw 2991, 2995, 3000.
  const a = load([-9, 0]),
    b = load([-5]),
    still = load([undefined]);
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const effects = [MToon.attach(a), MToon.attach(b), MToon.attach(still)],
    labels = new Map(),
    stack = [],
    drawn = [];
  for (const [name, model] of [
    ['A', a],
    ['B', b],
    ['S', still],
  ]) {
    model.primitives.forEach((p, i) => labels.set(p.material, name + i));
    const draw = model.draw;
    model.draw = function (...args) {
      stack.push(model);
      try {
        return draw.apply(this, args);
      } finally {
        stack.pop();
      }
    };
  }
  const context = { ...gpu.context, camera: engine.camera, draw() {} },
    begin = context.encoder.beginRenderPass;
  context.encoder.beginRenderPass = (...args) => {
    const pass = begin(...args);
    let pipeline;
    return {
      ...pass,
      setPipeline(value) {
        pipeline = value;
      },
      drawIndexed() {
        if (/@fragment fn fragment\([^{]*\{\s*discard;/.test(pipeline.fragment.module.code)) return;
        const model = stack[stack.length - 1];
        drawn.push(...model.primitives.map((p) => labels.get(p.material)).filter(Boolean));
      },
    };
  };
  try {
    // An opaque-only avatar adds no passes, so its models keep one render pass run.
    let added = 0;
    effects[2].registerPasses({ add: () => added++ });
    assert.equal(added, 0);
    engine.frameGraph.execute(context);
    // The opaque avatar draws in the models' pass; the blended queues follow in queue order across models.
    assert.deepEqual(drawn, ['S0', 'A0', 'B0', 'A1']);
    // A draw outside a scene frame (a probe, an imposter) still draws every queue of its model inline.
    drawn.length = 0;
    a.draw(context, 'beauty', context.color, context.depth);
    assert.deepEqual(drawn, ['A0', 'A1']);
    // The next frame draws the same order (nothing from the earlier frame is left behind).
    drawn.length = 0;
    engine.frameGraph.execute(context);
    assert.deepEqual(drawn, ['S0', 'A0', 'B0', 'A1']);
  } finally {
    for (const effect of effects) effect.dispose();
    engine.dispose();
  }
});

// The MToon UV animation as the shaders evaluate it in float32 (mtAnimate and shared/caster.js margoAnimatedUV), for a
// mask value m: phase x m + period x fract(k x m), periods 2, 2 and 1 turn.
const f32 = Math.fround;
const animated = (phase, k, period, m) => {
  const km = f32(k * m);
  return f32(f32(phase * m) + f32(f32(km - Math.floor(km)) * period));
};
test('MToon UV animation keeps 1/60 s steps after a day of running (audit p4 R22)', async () => {
  const f = await fixture(
    [
      {
        specVersion: '1.0',
        uvAnimationScrollXSpeedFactor: 0.1,
        uvAnimationScrollYSpeedFactor: -0.25,
        uvAnimationRotationSpeedFactor: 0.5,
      },
    ],
    ['MASK'],
  );
  try {
    const mtoon = MToon.attach(f.model);
    f.frame();
    mtoon.onPreUpdate(86_400);
    const frames = [];
    for (let i = 0; i < 4; i++) {
      mtoon.onPreUpdate(1 / 60);
      f.frame();
      const v = mtoon.states[0].values,
        cast = mtoon.states[0].castValues;
      frames.push({
        x: animated(v[24], v[23], 2, 1),
        y: animated(v[25], v[30], 2, 1),
        turns: animated(v[26], v[31], 1, 1),
        cast: cast && [
          animated(cast[0], cast[3], 2, 1),
          animated(cast[1], cast[11], 2, 1),
          animated(cast[2], cast[19], 1, 1),
        ],
      });
    }
    for (let i = 1; i < frames.length; i++) {
      const [a, b] = [frames[i - 1], frames[i]];
      const step = (from, to, period) => (((to - from) % period) + period) % period;
      assert.ok(Math.abs(step(a.x, b.x, 2) - 0.1 / 60) < 1e-6, `scroll x steps ${step(a.x, b.x, 2)}`);
      assert.ok(Math.abs(step(a.y, b.y, 2) - (2 - 0.25 / 60)) < 1e-6, `scroll y steps ${step(a.y, b.y, 2)}`);
      assert.ok(Math.abs(step(a.turns, b.turns, 1) - 0.5 / 60 / (2 * Math.PI)) < 1e-7, 'rotation steps');
      assert.ok(b.cast, 'a MASK material hands its casters the motion');
      assert.deepEqual(b.cast, [b.x, b.y, b.turns], 'shadow cut-outs move with the colour pass');
    }
  } finally {
    f.engine.dispose();
  }
});

test('MToon UV animation phases wrap scroll by 2 only where every map samples the same texel', async () => {
  const { scrollWraps, uvAnimationPhases } = await import('../src/mtoon-data.ts');
  const out = new Float64Array(6);
  uvAnimationPhases(out, [0.1, -0.25, Math.PI], 86_400.5, true, false);
  assert.ok(Math.abs(out[0] + 2 * out[3] - 8_640.05) < 1e-9 && out[0] >= 0 && out[0] < 2);
  assert.deepEqual([out[1], out[4]], [-0.25 * 86_400.5, 0], 'an unwrapped axis keeps the whole scroll');
  assert.ok(Math.abs(out[2] - 0.25) < 1e-9 && out[5] === 43_200, 'half a turn a second');
  // A fractional mask keeps the exact product: m x s = m x phase + 2 m k, and 2 fract(m k) differs from 2 m k by an even number.
  const m = 0.37,
    s = 0.1 * 86_400.5;
  const wrapped = (animated(out[0], out[3], 2, m) - ((m * s) % 2) + 4) % 2;
  assert.ok(Math.min(wrapped, 2 - wrapped) < 1e-3, `fractional mask ${wrapped}`);
  assert.equal(scrollWraps(undefined, [undefined, undefined], 0), true);
  assert.equal(scrollWraps({ index: 0 }, [undefined, undefined], 0), true, 'REPEAT, no transform');
  assert.equal(scrollWraps({ index: 0 }, [33648, 33648], 1), true, 'MIRRORED_REPEAT');
  assert.equal(scrollWraps({ index: 0 }, [33071, undefined], 0), false, 'a clamped axis the scroll reaches');
  assert.equal(scrollWraps({ index: 0 }, [33071, undefined], 1), true, 'a clamped axis the scroll does not reach');
  const half = { index: 0, extensions: { KHR_texture_transform: { scale: [0.5, 2] } } };
  assert.equal(scrollWraps(half, [undefined, undefined], 0), false, 'a half scale');
  assert.equal(scrollWraps(half, [undefined, undefined], 1), true, 'a whole scale');
  assert.equal(
    scrollWraps({ index: 0 }, [undefined, undefined], 0, [{ value: 1, scale: [0.5, 1], offset: [0, 0] }]),
    false,
  );
});
