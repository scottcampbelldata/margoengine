import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '@margoengine/shadows';
import { Clustered } from '@margoengine/clustered';
import { TAA } from '@margoengine/taa';
import { XR } from '@margoengine/xr';
import { Animation } from '@margoengine/animation';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { wgsl } from '../packages/core/dist/shaders.js';
import { optionalGPU } from './support/optional-gpu.js';
import { loadedPBRFixtures, serveLoadedPBRFixtures } from './support/loaded-pbr-fixtures.js';

// Fail immediately on either real-loader failure, before registering consumer checks.
const assets = await serveLoadedPBRFixtures();
try {
  for (const fixture of loadedPBRFixtures) (await assets.load(fixture)).dispose();
} catch (error) {
  await assets.close();
  throw error;
}
after(() => assets.close());

// Instrument GPU submission only. All loaders, models, transforms, plugin validation,
// frame graph passes, and draw-selection code remain the real implementations.
function renderHarness(engine) {
  const h = optionalGPU(),
    c = h.context,
    passes = [];
  c.device = engine.gpu;
  c.camera = engine.camera;
  const encoder = {
    beginRenderPass(descriptor) {
      const record = { colors: descriptor.colorAttachments.length, indexed: [], vertices: [], draws: 0 };
      passes.push(record);
      return {
        setPipeline(pipeline) {
          record.pipeline = pipeline;
        },
        setBindGroup() {},
        setVertexBuffer(slot, buffer) {
          if (slot === 0) record.vertices.push(buffer);
        },
        setIndexBuffer() {},
        setViewport() {},
        drawIndexed(...args) {
          record.indexed.push(args);
        },
        draw() {
          record.draws++;
        },
        end() {},
      };
    },
    beginComputePass() {
      return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
    },
    copyTextureToTexture() {},
    copyBufferToBuffer(source, from, target, to, size) {
      new Uint8Array(target.data, to, size).set(new Uint8Array(source.data, from, size));
    },
    finish() {
      return {};
    },
  };
  c.encoder = encoder;
  const originalColor = c.color,
    originalDepth = c.depth;
  engine.renderer.render = (camera, _lighting, _batches, graph, delta) => {
    c.color = originalColor;
    c.depth = originalDepth;
    c.format = 'bgra8unorm';
    c.camera = camera;
    c.delta = delta;
    c.shader = wgsl;
    c.bindings = [];
    c.descriptor = {
      vertex: { entryPoint: 'vertex', buffers: [] },
      fragment: { entryPoint: 'fragment' },
      depthStencil: { format: 'depth32float' },
      multisample: { count: 4 },
    };
    graph.execute(c);
  };
  return {
    passes,
    context: c,
    encoder,
    frame(options = { culling: false }) {
      passes.length = 0;
      engine.render(options);
    },
    depthDraws() {
      return passes.filter((pass) => pass.colors === 0).flatMap((pass) => pass.indexed);
    },
    beautyDraws() {
      return passes
        .filter((pass) => pass.colors > 0 && pass.pipeline?.fragment.targets[0]?.format === 'bgra8unorm')
        .flatMap((pass) => pass.indexed);
    },
    velocityDraws() {
      return passes
        .filter((pass) => pass.pipeline?.fragment.targets[0]?.format === 'rg16float')
        .flatMap((pass) => pass.indexed);
    },
  };
}

async function withLoaded(fixture, action) {
  const loaded = await assets.load(fixture);
  try {
    const h = renderHarness(loaded.engine);
    h.frame();
    assert.equal(
      h.beautyDraws().length,
      1,
      'the genuine loader-owned primitive renders before testing a secondary pass',
    );
    await action(loaded, h);
    assert.equal(loaded.mesh.geometry, null, 'the consumer must not attach duplicate core geometry');
  } finally {
    loaded.dispose();
  }
}

for (const fixture of loadedPBRFixtures) {
  test(`${fixture.producer}: Shadows.add(loaded mesh) submits all four cascades for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({ engine, mesh, primitive }, h) => {
      const shadows = Shadows.attach(engine);
      shadows.add(mesh); // Public Mesh overload accepts this exact loaded node without an error.
      h.frame();
      assert.equal(h.beautyDraws().length, 1);
      assert.equal(h.depthDraws().length, 4, 'accepted loaded Mesh must contribute one indexed draw to each cascade');
      assert.ok(h.depthDraws().every(([count]) => count === primitive.indices.length));
    });
  });

  test(`${fixture.producer}: Clustered.addShadowCaster(loaded mesh) submits six point-light faces for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({ engine, mesh, primitive }, h) => {
      const clustered = Clustered.attach(engine, { shadows: {} });
      clustered.setLights([{ position: [0, 2, 2], range: 10, shadow: true }]);
      clustered.addShadowCaster(mesh); // The documented direct Mesh caster is accepted.
      h.frame();
      assert.equal(h.beautyDraws().length, 1);
      assert.equal(
        h.depthDraws().length,
        6,
        'accepted loaded Mesh must contribute one indexed draw to each point-light face',
      );
      assert.ok(h.depthDraws().every(([count]) => count === primitive.indices.length));
    });
  });

  // Controls establish the difference between the accepted direct Mesh overloads
  // above and PBRModel registration. A working model route does not repair Mesh drops.
  test(`${fixture.producer}: explicit PBRModel shadow registration renders real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({ engine, model, primitive }, h) => {
      const shadows = Shadows.attach(engine);
      shadows.add(model);
      h.frame();
      assert.equal(h.depthDraws().length, 4);
      assert.ok(h.depthDraws().every(([count]) => count === primitive.indices.length));
      shadows.dispose();
      const clustered = Clustered.attach(engine, { shadows: {} });
      clustered.setLights([{ position: [0, 2, 2], range: 10, shadow: true }]);
      clustered.addShadowCaster(model);
      h.frame();
      assert.equal(h.depthDraws().length, 6);
      assert.ok(h.depthDraws().every(([count]) => count === primitive.indices.length));
    });
  });

  test(`${fixture.producer}: documented TAA.add(PBRModel) supplies object motion for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({ engine, model, mesh, primitive }, h) => {
      const taa = TAA.attach(engine);
      // PBR registration is explicitly required by the TAA README; automatic core
      // mesh motion does not promise to discover a separate PBRModel.
      taa.add(model);
      h.frame();
      mesh.position.x += 0.25;
      h.frame();
      assert.equal(h.beautyDraws().length, 1);
      assert.equal(h.velocityDraws().length, 1);
      assert.equal(h.velocityDraws()[0][0], primitive.indices.length);
    });
  });

  test(`${fixture.producer}: automatic TAA and overlapping Mesh/model shadow registrations draw each primitive once`, async () => {
    await withLoaded(fixture, ({ engine, model, mesh, primitive }, h) => {
      const shadows = Shadows.attach(engine),
        removeModel = shadows.add(model, { static: true }),
        removeMesh = shadows.add(mesh),
        staticBox = fixture.asset === 'Box.glb';
      h.frame();
      assert.equal(h.depthDraws().length, 4, 'overlapping registrations submit each primitive once per cascade');
      // The undeformed Box is cached automatically; the skinned FBX registration stays dynamic and takes precedence.
      assert.equal(shadows.stats.staticDraws, staticBox ? 4 : 0);
      assert.equal(shadows.stats.dynamicDraws, staticBox ? 0 : 4);
      const cacheHits = shadows.stats.cacheHits;
      h.frame();
      assert.equal(h.depthDraws().length, staticBox ? 0 : 4, 'unchanged geometry reuses the cached atlas');
      assert.equal(shadows.stats.staticDraws, 0);
      assert.equal(shadows.stats.dynamicDraws, staticBox ? 0 : 4);
      assert.equal(shadows.stats.cacheHits, cacheHits + 1);
      removeMesh();
      h.frame();
      assert.equal(h.depthDraws().length, 4, 'remaining cached source still renders');
      assert.equal(shadows.stats.staticDraws, 4);
      removeModel();
      shadows.dispose();
      const clustered = Clustered.attach(engine, { shadows: {} });
      clustered.setLights([{ position: [0, 2, 2], range: 10, shadow: true }]);
      const removeLocalMesh = clustered.addShadowCaster(mesh);
      clustered.addShadowCaster(model);
      h.frame();
      assert.equal(h.depthDraws().length, 6);
      removeLocalMesh();
      h.frame();
      assert.equal(h.depthDraws().length, 6);
      clustered.dispose();
      const taa = TAA.attach(engine);
      h.frame();
      assert.equal(
        h.velocityDraws().length,
        1,
        'loaded nodes supply automatic motion without explicit model registration',
      );
      const removeTAA = taa.add(model);
      h.frame();
      assert.equal(h.velocityDraws().length, 1);
      removeTAA();
      h.frame();
      assert.equal(h.velocityDraws().length, 1);
      const velocity = h.passes.find(
        (pass) => pass.pipeline?.fragment.targets[0]?.format === 'rg16float' && pass.indexed.length,
      );
      assert.equal(velocity.vertices[0], model.pickingPrimitives[0].vertex);
      assert.equal(velocity.indexed[0][0], primitive.indices.length);
      model.dispose();
      h.frame();
      assert.equal(h.velocityDraws().length, 0);
      taa.dispose();
    });
  });

  test(`${fixture.producer}: isolated PBR eye renderers follow late animation and extension replacement without owning desktop resources`, async () => {
    await withLoaded(fixture, ({ engine, model, primitive }, h) => {
      const target = optionalGPU(),
        device = target.engine.gpu,
        start = target.resources.length,
        originalNodes = [...engine.meshes.values()],
        originalVertex = model.pickingPrimitives[0].vertex;
      const context = {
        ...target.context,
        camera: engine.camera,
        descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth24plus' } },
      };
      const rendered = [],
        pass = {
          setPipeline(pipeline) {
            rendered.push({ pipeline });
          },
          setBindGroup(index, group) {
            if (index === 0) rendered.at(-1).uniform = group.entries[0].resource.buffer;
          },
          setVertexBuffer(index, buffer) {
            if (index === 0) rendered.at(-1).vertex = buffer;
          },
          setIndexBuffer() {},
          drawIndexed(count) {
            rendered.at(-1).count = count;
          },
          end() {
            assert.fail('the replica must not end its caller-owned pass');
          },
        };
      let animation, left, right;
      try {
        left = model.createRenderer(device);
        right = model.createRenderer(device);
        const draw = (renderer) => {
          renderer.prepare(context);
          renderer.draw(context, pass, engine.camera.matrix);
          return rendered.at(-1);
        };
        const first = draw(left),
          second = draw(right);
        assert.notEqual(first.vertex, originalVertex);
        assert.notEqual(first.vertex, second.vertex);
        assert.notEqual(first.uniform, second.uniform);
        assert.equal(first.pipeline.vertex.buffers[0].arrayStride, 80);
        assert.equal(first.pipeline.depthStencil.depthCompare, 'less-equal');
        assert.equal(first.count, primitive.indices.length);
        assert.deepEqual([...engine.meshes.values()], originalNodes, 'replicas never allocate core nodes');
        animation = Animation.attach(model);
        animation.playing = false;
        if (animation.clips.length) animation.seek(0.125);
        const time = animation.time,
          desktopDeformed = primitive.deformed;
        const animated = draw(left);
        assert.equal(animation.time, time);
        assert.equal(primitive.deformed, desktopDeformed, 'target deformation never replaces the desktop output');
        if (desktopDeformed) {
          assert.notEqual(animated.vertex, first.vertex);
          assert.notEqual(animated.vertex, desktopDeformed);
          assert.ok(animated.vertex.usage & GPUBufferUsage.STORAGE);
        }
        const factory = model.createDeformationRenderer;
        model.createDeformationRenderer = () => {
          throw new Error('replacement deformation factory failed');
        };
        assert.throws(() => left.prepare(context), /replacement deformation factory failed/);
        model.createDeformationRenderer = factory;
        const recovered = draw(left);
        if (desktopDeformed)
          assert.ok(
            recovered.vertex.usage & GPUBufferUsage.STORAGE,
            'recovering the original factory recreates deformation instead of drawing bind-pose vertices',
          );
        assert.equal(primitive.deformed, desktopDeformed);
        assert.equal(animation.time, time);
        animation.dispose();
        animation = undefined;
        const restored = draw(left);
        assert.equal(
          restored.vertex,
          first.vertex,
          'removing source animation releases the target deformation and resumes retained static vertices',
        );
        primitive.extension = { wgsl: 's.base.rgb=vec3f(0.125,0.25,0.5);', factors: new Float32Array([1, 2, 3, 4]) };
        const changed = draw(left);
        assert.match(changed.pipeline.vertex.module.code, /0\.125,0\.25,0\.5/);
        primitive.extension = { textures: [{ view: {} }] };
        assert.throws(() => left.prepare(context), /recreating caller-owned material extension textures/);
        primitive.extension = undefined;
        draw(left);
        assert.throws(() => left.prepare({ ...context, device: engine.gpu }), /another GPU device/);
        model.dispose();
        assert.ok(
          target.resources.slice(start).every((resource) => resource.destroyed),
          'source disposal frees every owned eye resource',
        );
        assert.throws(() => left.prepare(context), /disposed/);
      } finally {
        primitive.extension = undefined;
        animation?.dispose();
        left?.dispose();
        right?.dispose();
        target.cleanup();
      }
    });
  });

  test(`${fixture.producer}: TAA snapshots a live COPY_SRC deformation without substituting bind-pose CPU vertices`, async () => {
    await withLoaded(fixture, ({ engine, model, primitive }, h) => {
      const device = engine.gpu,
        createGroup = device.createBindGroup,
        groups = [];
      device.createBindGroup = (descriptor) => {
        groups.push(descriptor);
        return createGroup(descriptor);
      };
      const current = device.createBuffer({
        size: primitive.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      const values = primitive.vertices.slice();
      for (let i = 0; i < values.length; i += 20) values[i] += 2;
      device.queue.writeBuffer(current, 0, values);
      primitive.deformed = current;
      let taa;
      try {
        taa = TAA.attach(engine);
        h.frame();
        const snapshot = groups.find(
          (group) => group.entries.length === 2 && group.entries.every((entry) => entry.resource.buffer),
        );
        assert.ok(snapshot, 'TAA created its source/snapshot compute group');
        const source = snapshot.entries[0].resource.buffer;
        assert.notEqual(source, current);
        assert.ok(source.usage & GPUBufferUsage.STORAGE);
        assert.deepEqual(
          new Float32Array(source.data),
          values,
          'the temporary storage source contains current GPU deformation',
        );
        for (let i = 0; i < values.length; i += 20) values[i] += 3;
        device.queue.writeBuffer(current, 0, values);
        h.frame();
        assert.deepEqual(
          new Float32Array(source.data),
          values,
          'the same borrowed buffer is refreshed from GPU each frame',
        );
        assert.equal(model.pickingPrimitives[0].vertex, current);
        assert.equal(current.destroyed, false);
      } finally {
        taa?.dispose();
        primitive.deformed = undefined;
        current.destroy();
        device.createBindGroup = createGroup;
      }
    });
  });

  test(`${fixture.producer}: immersive XR submits the loaded primitive to both eyes for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, async ({ engine, primitive }, desktop) => {
      const restore = installXRProtocol();
      let xr;
      try {
        engine.onError = (error) => restore.errors.push(error);
        xr = await XR.create(engine);
        await xr.requestSession();
        desktop.passes.length = 0;
        restore.frame();
        assert.equal(desktop.beautyDraws().length, 1, 'desktop PBR mirror remains visible');
        assert.deepEqual(restore.errors, [], 'the XR renderer completed without reporting an error');
        assert.equal(restore.eyePasses(), 2, 'both genuine StereoRenderer eye passes executed');
        assert.equal(
          restore.eyeDraws().length,
          2,
          'an accepted scene with one loaded primitive must submit one indexed draw per eye',
        );
        assert.ok(restore.eyeDraws().every(([count]) => count === primitive.indices.length));
      } finally {
        // Ending XR resumes the desktop RAF; capture those callbacks in the protocol shim.
        if (xr) {
          await xr.end();
          xr.dispose();
        }
        engine.stop();
        restore();
      }
    });
  });
}

test('distinct prepared primitives sharing vertex and index buffers retain separate shadow and motion draws', async () => {
  await withLoaded(loadedPBRFixtures[0], ({ engine, model, primitive }, h) => {
    const doc = structuredClone(model.asset.doc),
      meshId = doc.nodes[primitive.nodeIndex].mesh,
      definition = doc.meshes[meshId].primitives[0],
      materials = (doc.materials ??= []);
    const material = materials.length;
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1] } });
    doc.meshes[meshId].primitives = [definition, { ...definition, material }];
    const data = { vertices: primitive.vertices, indices: primitive.indices },
      prepared = doc.meshes.map((_, index) => (index === meshId ? [data, data] : [])),
      asset = new GLTFAsset(doc, model.asset.buffers);
    model.dispose();
    const replacement = new PBRModel(engine, asset, [], prepared);
    engine.use(replacement);
    const [first, second] = replacement.shadowPrimitives;
    assert.equal(first.index, second.index);
    assert.equal(first.vertex, second.vertex);
    assert.notEqual(first.primitive, second.primitive);
    const shadows = Shadows.attach(engine);
    shadows.add(replacement);
    shadows.add(replacement.primitives[0].node);
    h.frame();
    assert.equal(h.depthDraws().length, 8);
    assert.equal(h.beautyDraws().length, 2);
    shadows.dispose();
    const clustered = Clustered.attach(engine, { shadows: {} });
    clustered.setLights([{ position: [0, 2, 2], range: 10, shadow: true }]);
    clustered.addShadowCaster(replacement);
    clustered.addShadowCaster(replacement.primitives[0].node);
    h.frame();
    assert.equal(h.depthDraws().length, 12);
    clustered.dispose();
    const taa = TAA.attach(engine);
    taa.add(replacement);
    h.frame();
    assert.equal(h.velocityDraws().length, 2);
    taa.dispose();
  });
});

test('automatic TAA preserves a real loaded Box at the frustum edge when its empty core bound is culled', async () => {
  await withLoaded(loadedPBRFixtures[0], ({ engine, mesh, primitive }, h) => {
    const taa = TAA.attach(engine);
    mesh.position.x = 3.279201435678004;
    try {
      h.frame({ culling: true });
      assert.equal(engine.store.visible[mesh.id], 0, 'the core point bound is outside its frustum');
      const m = mesh.matrix,
        camera = engine.camera.matrix;
      let inside = 0;
      for (let vertex = 0; vertex < primitive.vertices.length; vertex += 20) {
        const p = primitive.vertices.subarray(vertex, vertex + 3),
          world = Array.from(
            { length: 4 },
            (_, row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row],
          );
        const clip = Array.from(
          { length: 4 },
          (_, row) =>
            camera[row] * world[0] +
            camera[4 + row] * world[1] +
            camera[8 + row] * world[2] +
            camera[12 + row] * world[3],
        );
        if (
          clip[0] >= -clip[3] &&
          clip[0] <= clip[3] &&
          clip[1] >= -clip[3] &&
          clip[1] <= clip[3] &&
          clip[2] >= 0 &&
          clip[2] <= clip[3]
        )
          inside++;
      }
      assert.ok(inside > 0, 'actual loaded triangles still intersect the camera frustum');
      assert.equal(h.beautyDraws().length, 1);
      assert.equal(
        h.velocityDraws().length,
        1,
        'PBR motion follows its visible triangles rather than an empty core bound',
      );
      mesh.visible = false;
      h.frame({ culling: true });
      assert.equal(h.beautyDraws().length, 0);
      assert.equal(h.velocityDraws().length, 0, 'explicit hidden state still suppresses motion');
    } finally {
      taa.dispose();
    }
  });
});

// Native XR/adapter protocol doubles, analogous to packages/xr/tests/xr.test.js.
// The genuine public XR manager and its StereoRenderer execute every scene decision.
function installXRProtocol() {
  const keys = ['navigator', 'XRGPUBinding', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const h = optionalGPU(),
    device = h.engine.gpu,
    passes = [],
    errors = [];
  const events = new EventTarget();
  device.addEventListener = events.addEventListener.bind(events);
  device.removeEventListener = events.removeEventListener.bind(events);
  device.lost = new Promise(() => {});
  device.destroy = () => {};
  device.queue.submit = () => {};
  device.createCommandEncoder = () => ({
    beginRenderPass(descriptor) {
      const record = { colors: descriptor.colorAttachments.length, indexed: [] };
      passes.push(record);
      return {
        setPipeline() {},
        setBindGroup() {},
        setViewport() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        drawIndexed(...args) {
          record.indexed.push(args);
        },
        draw() {},
        end() {},
      };
    },
    finish() {
      return {};
    },
  });
  class Session extends EventTarget {
    inputSources = [];
    callbacks = new Map();
    next = 0;
    async requestReferenceSpace() {
      return {};
    }
    updateRenderState(state) {
      this.state = state;
    }
    requestAnimationFrame(callback) {
      this.callbacks.set(++this.next, callback);
      return this.next;
    }
    cancelAnimationFrame(handle) {
      this.callbacks.delete(handle);
    }
    async end() {
      this.dispatchEvent(new Event('end'));
    }
  }
  const session = new Session();
  class Binding {
    getPreferredColorFormat() {
      return 'rgba8unorm';
    }
    createProjectionLayer() {
      return { destroy() {} };
    }
    getViewSubImage(_layer, view) {
      const texture = { width: 128, height: 96, format: 'rgba8unorm', createView: (descriptor) => ({ descriptor }) };
      return {
        colorTexture: texture,
        depthStencilTexture: texture,
        viewport: { x: 0, y: 0, width: 128, height: 96 },
        getViewDescriptor: () => ({
          dimension: '2d',
          baseArrayLayer: view.eye === 'right' ? 1 : 0,
          arrayLayerCount: 1,
        }),
      };
    }
  }
  const values = {
    navigator: {
      xr: { isSessionSupported: async () => true, requestSession: async () => session },
      gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) },
    },
    XRGPUBinding: Binding,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const restore = () => {
    h.cleanup();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  };
  restore.errors = errors;
  restore.frame = () => {
    const viewer = {
      views: ['left', 'right'].map((eye, index) => ({
        eye,
        projectionMatrix: identity(),
        transform: { inverse: { matrix: identity() }, position: { x: index ? 0.03 : -0.03, y: 0, z: 4 } },
      })),
    };
    const callbacks = [...session.callbacks.values()];
    session.callbacks.clear();
    assert.equal(callbacks.length, 1, 'the public XR manager scheduled its actual native frame callback');
    for (const callback of callbacks) callback(0, { session, getViewerPose: () => viewer, getPose: () => null });
  };
  restore.eyePasses = () => passes.filter((pass) => pass.colors > 0).length;
  restore.eyeDraws = () => passes.filter((pass) => pass.colors > 0).flatMap((pass) => pass.indexed);
  return restore;
}
