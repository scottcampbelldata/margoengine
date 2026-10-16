import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactShadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { loadedPBRFixtures, serveLoadedPBRFixtures } from '../../../tests/support/loaded-pbr-fixtures.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function scene() {
  const h = optionalGPU(),
    engine = h.engine,
    passes = [],
    render = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    passes.push(descriptor.depthStencilAttachment ? 'plane' : descriptor.colorAttachments[0].view);
    return render(descriptor);
  };
  const vertex = engine.gpu.createBuffer({ size: 240, usage: GPUBufferUsage.VERTEX }),
    index = engine.gpu.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX });
  const node = { id: 0, engine, matrix: identity(), check() {} },
    model = { shadowPrimitives: [{ node, vertex, index, count: 3, stride: 80 }] };
  const frame = () => {
    passes.length = 0;
    engine.frameGraph.execute(h.context);
    return passes.map((p) => (p === 'plane' ? p : 'texture'));
  };
  return { h, engine, node, model, vertex, index, passes, frame };
}
const apply = (m, p) => [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

test('maps the plane footprint to the texture and the height range to depth 0..1, then blurs and draws the plane', () => {
  const s = scene(),
    contact = ContactShadows.attach(s.engine, { position: [1, 2, 3], size: [4, 2], height: 0.5, resolution: 64 });
  s.h.context.camera.position = [0, 5, 4];
  try {
    contact.add(s.model);
    assert.deepEqual(
      s.frame(),
      ['texture', 'texture', 'texture', 'texture', 'texture', 'plane'],
      'occluders, 4 blur steps, plane',
    );
    const uniform = s.h.resources.find((r) => r.size === 144 && r.data),
      m = new Float32Array(uniform.data, 0, 16);
    assert.deepEqual(
      apply(m, [-1, 2, 2]).map((v) => +v.toFixed(6)),
      [-1, -1, 0, 1],
      'min x, min z at the ground',
    );
    assert.deepEqual(
      apply(m, [3, 2.5, 4]).map((v) => +v.toFixed(6)),
      [1, 1, 1, 1],
      'max x, max z at the top',
    );
    const occluder = s.h.pipelines.find((p) => p.fragment?.targets[0].format === 'r16float' && p.vertex.buffers),
      plane = s.h.pipelines.find((p) => p.depthStencil);
    assert.equal(
      occluder.fragment.targets[0].blend.color.operation,
      'max',
      'the lowest surface wins without a depth buffer',
    );
    assert.equal(occluder.vertex.buffers[0].arrayStride, 80);
    assert.deepEqual(
      [
        plane.depthStencil.depthWriteEnabled,
        plane.depthStencil.depthCompare,
        plane.multisample.count,
        plane.fragment.targets[0].format,
      ],
      [false, 'greater-equal', 4, 'bgra8unorm'],
    );
    // Plane uniform: lifted a hair above the ground, colour + opacity.
    const p = new Float32Array(s.h.resources.find((r) => r.size === 112).data);
    assert.ok(p[17] > 2 && p[17] < 2.001);
    assert.deepEqual(
      [...p.subarray(24, 28)].map((v) => +v.toFixed(4)),
      [0, 0, 0, 0.6],
    );
    s.h.context.camera.position = [0, 1.5, 4];
    assert.deepEqual(
      s.frame(),
      ['texture', 'texture', 'texture', 'texture', 'texture'],
      'no plane seen from below the ground',
    );
  } finally {
    contact.dispose();
  }
  assert.ok(
    s.h.resources.filter((r) => r !== s.vertex && r !== s.index).every((r) => r.destroyed),
    'dispose releases every buffer and texture',
  );
});

test('instanced shadow primitives (gltf-pro PBRInstances) draw every instance in one occluder draw', () => {
  const s = scene(),
    contact = ContactShadows.attach(s.engine, { resolution: 32 }),
    buffer = s.engine.gpu.createBuffer({ size: 96 * 5, usage: GPUBufferUsage.VERTEX }),
    slots = [],
    draws = [],
    render = s.h.context.encoder.beginRenderPass;
  s.h.context.encoder.beginRenderPass = (d) => {
    const p = render(d);
    return { ...p, setVertexBuffer: (slot, b) => slots.push([slot, b]), drawIndexed: (...a) => draws.push(a) };
  };
  try {
    s.model.shadowPrimitives[0].instances = { count: 5, upload: () => buffer };
    contact.add(s.model);
    s.frame();
    assert.deepEqual(draws, [[3, 5]]);
    assert.ok(slots.some(([slot, b]) => slot === 1 && b === buffer));
    const occluder = s.h.pipelines.find((p) => p.fragment?.targets[0].format === 'r16float' && p.vertex.buffers);
    assert.equal(occluder.vertex.buffers[1].stepMode, 'instance');
    assert.equal(occluder.vertex.buffers[1].arrayStride, 96);
    s.model.shadowPrimitives[0].instances.count = 0;
    draws.length = 0;
    s.frame();
    assert.deepEqual(draws, [], 'no instances, no draw');
  } finally {
    contact.dispose();
  }
});
test('static re-renders only on transform, source, visibility or option changes', () => {
  const s = scene(),
    contact = ContactShadows.attach(s.engine, { static: true, resolution: 32 }),
    full = 6;
  try {
    const remove = contact.add(s.model);
    assert.equal(s.frame().length, full);
    assert.deepEqual(s.frame(), ['plane']);
    assert.deepEqual(contact.stats, { updates: 1, cacheHits: 1 });
    s.node.matrix[13] = 0.2;
    assert.equal(s.frame().length, full, 'moved');
    assert.deepEqual(s.frame(), ['plane']);
    s.engine.store.hidden[0] = 1;
    assert.equal(s.frame().length, full, 'hidden');
    s.engine.store.hidden[0] = 0;
    assert.equal(s.frame().length, full, 'shown');
    contact.options.blur = 0.3;
    assert.equal(s.frame().length, full, 'option');
    contact.invalidate();
    assert.equal(s.frame().length, full, 'invalidate');
    remove();
    assert.equal(s.frame().length, full, 'removed');
    assert.deepEqual(s.frame(), ['plane']);
    contact.options.static = false;
    assert.equal(s.frame().length, full);
    assert.equal(s.frame().length, full, 'dynamic: every frame');
    contact.options.resolution = 128;
    s.frame();
    assert.ok(
      s.h.resources.some((r) => r.width === 128) &&
        s.h.resources.filter((r) => r.width === 32).every((r) => r.destroyed),
      'resolution change replaces the targets',
    );
    contact.onDeviceRestored(s.engine);
    assert.equal(s.frame().length, full);
  } finally {
    contact.dispose();
  }
});

test('core meshes use the engine geometry buffers; disposed or foreign sources are rejected or dropped', () => {
  const s = scene(),
    contact = new ContactShadows(),
    geometry = { indices: new Uint32Array(36) };
  const mesh = { id: 1, engine: s.engine, matrix: identity(), geometry, check() {} };
  s.engine.meshes.set(1, mesh);
  s.engine.geometryBuffers = (g) => (g === geometry ? { vertex: s.vertex, index: s.index } : null);
  s.engine.use(contact);
  try {
    const counts = [];
    const begin = s.h.context.encoder.beginRenderPass;
    s.h.context.encoder.beginRenderPass = (d) => {
      const pass = begin(d);
      return {
        ...pass,
        drawIndexed(n) {
          counts.push(n);
        },
      };
    };
    contact.add(mesh);
    s.frame();
    assert.deepEqual(counts, [36]);
    assert.equal(
      s.h.pipelines.find((p) => p.vertex.buffers?.[0]?.arrayStride === 24).vertex.buffers[0].attributes[0].format,
      'float32x3',
    );
    assert.throws(() => contact.add(mesh), /Duplicate/);
    assert.throws(() => contact.add({ disposed: true, shadowPrimitives: [] }), /disposed/);
    assert.throws(() => contact.add({}), /Invalid/);
    assert.throws(() => contact.add({ ...mesh, id: 2, engine: {} }), /another engine/);
    s.engine.meshes.delete(1);
    counts.length = 0;
    s.frame();
    assert.deepEqual(counts, [], 'removed meshes drop out');
  } finally {
    contact.dispose();
  }
});

test('loaded gltf-pro and FBX mesh handles cast contact shadows from their current PBR buffers', async (t) => {
  const assets = await serveLoadedPBRFixtures();
  t.after(() => assets.close());
  for (const fixture of loadedPBRFixtures)
    await t.test(fixture.producer, async () => {
      const loaded = await assets.load(fixture),
        { engine, model, mesh, primitive } = loaded,
        contact = ContactShadows.attach(engine, { static: true, resolution: 32 }),
        draws = [];
      let execute;
      contact.registerPasses({
        add(pass) {
          execute = pass.execute;
        },
      });
      const context = {
        backend: 'webgpu',
        device: engine.gpu,
        camera: { matrix: identity(), position: [0, 2, 4] },
        format: 'bgra8unorm',
        descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth32float' } },
        encoder: {
          beginRenderPass() {
            let vertex, pipeline;
            return {
              setPipeline(value) {
                pipeline = value;
              },
              setBindGroup() {},
              setVertexBuffer(_slot, value) {
                vertex = value;
              },
              setIndexBuffer() {},
              drawIndexed(count) {
                draws.push({ vertex, count, stride: pipeline.vertex.buffers[0].arrayStride });
              },
              draw() {},
              end() {},
            };
          },
        },
      };
      const frame = () => {
        draws.length = 0;
        execute(context);
        return draws;
      };
      try {
        assert.equal(mesh.geometry, null);
        contact.add(mesh);
        const current = model.shadowPrimitives[0];
        assert.deepEqual(frame(), [{ vertex: current.vertex, count: primitive.indices.length, stride: 80 }]);
        assert.deepEqual(frame(), [], 'an unchanged static source reuses the contact texture');
        const deformed = engine.gpu.createBuffer({ size: primitive.vertices.byteLength, usage: GPUBufferUsage.VERTEX });
        primitive.deformed = deformed;
        try {
          assert.deepEqual(
            frame(),
            [{ vertex: deformed, count: primitive.indices.length, stride: 80 }],
            'a changed draw buffer invalidates the cached contact texture',
          );
          model.root.visible = false;
          assert.deepEqual(frame(), [], 'a hidden ancestor suppresses PBR contact draws');
          model.root.visible = true;
          assert.deepEqual(frame(), [{ vertex: deformed, count: primitive.indices.length, stride: 80 }]);
        } finally {
          primitive.deformed = undefined;
          deformed.destroy();
        }
        model.dispose();
        assert.deepEqual(frame(), [], 'disposed loader meshes no longer cast contact shadows');
      } finally {
        loaded.dispose();
      }
    });
});

test('fit centres the plane under model.bounds; options are validated', () => {
  const contact = new ContactShadows().fit([-1, 0.5, -3, 3, 2.5, 1]);
  assert.deepEqual(contact.options, { position: [1, 0.5, -1], size: 8, height: 2 });
  for (const options of [
    { size: 0 },
    { size: [1] },
    { height: -1 },
    { opacity: 2 },
    { resolution: 10 },
    { blur: -1 },
    { position: [0, 0] },
    { static: 1 },
  ])
    assert.throws(() => new ContactShadows(options), /Invalid contact shadow options/, JSON.stringify(options));
  assert.throws(() => contact.fit([0, 0, 0, 1, 1]), /bounds/);
  assert.throws(() => contact.fit([0, 0, 0, 1, 1, 1], 0.5), /bounds/);
});
