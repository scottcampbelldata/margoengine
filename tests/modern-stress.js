import { createStage, box, PbrMaterial } from '/packages/margoengine/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { webglRenderer } from '/packages/webgl/dist/index.js';
import { Splats } from '/packages/splats/dist/index.js';
import { VFX } from '/packages/vfx/dist/index.js';
import { Terrain } from '/packages/terrain/dist/index.js';
import { SSAO } from '/packages/post/dist/index.js';
import { Shadows } from '/packages/shadows/dist/index.js';
import { Clustered } from '/packages/clustered/dist/index.js';
import { TAA } from '/packages/taa/dist/index.js';
import { Animation } from '/packages/animation/dist/index.js';
import { parseGLTF } from '/packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const wait = async (predicate) => {
  const until = performance.now() + 15000;
  while (!predicate()) {
    assert(performance.now() < until, 'Recovery timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const submitted = async (engine) => {
  if (engine.gpu) await engine.gpu.queue.onSubmittedWorkDone();
};

function cloud(count) {
  const positions = new Float32Array(count * 3),
    covariances = new Float32Array(count * 6),
    colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions.set(
      [((i % 64) - 32) * 0.08, ((Math.floor(i / 64) % 64) - 32) * 0.08, -1 - Math.floor(i / 4096) * 0.01],
      i * 3,
    );
    covariances.set([0.001, 0, 0, 0.001, 0, 0.001], i * 6);
    colors.set([0.1, 0.8, 0.4, 0.5], i * 4);
  }
  return { positions, covariances, colors };
}

window.runStress = async (profile, options) => {
  const gpu = window.stressGPU,
    scenario = profile.scenario,
    expected = [],
    frames = [],
    checks = [];
  const host = document.createElement('div');
  host.style.cssText = `width:${profile.size[0]}px;height:${profile.size[1]}px`;
  document.body.append(host);
  let app, model;
  try {
    if (scenario === 'init-failure') {
      let rejected = false;
      try {
        await createStage(host, { backend: 'webgpu', autoStart: false });
      } catch (error) {
        rejected = /Injected device creation failure/.test(String(error));
      }
      assert(rejected && host.children.length === 0, 'Failed initialization did not reject and remove canvas');
      checks.push('initialization rollback');
      return { checks, frames };
    }
    const backend = scenario === 'fallback' ? 'auto' : scenario.startsWith('webgl') ? 'webgl2' : 'webgpu';
    app = await createStage(host, {
      backend,
      fallback: webglRenderer,
      autoStart: false,
      capacity: Math.max(options.entities + 1, 16),
      camera: { position: [0, 2, 8], target: [0, 0, 0] },
      onError: (error) => expected.push(String(error)),
    });
    const engine = engineRuntime(app.engine),
      store = engine.store,
      memory = store.matrices.buffer;
    assert(engine.backend === (backend === 'auto' ? 'webgl2' : backend), 'Unexpected backend');
    if (scenario === 'fallback') {
      assert(/adapter unavailable/.test(engine.fallbackReason), 'Missing fallback diagnostic');
      checks.push('adapter fallback');
    }
    const geometry = box(),
      material = new PbrMaterial({ color: '#84d6bd', roughness: 0.5 });
    const count = scenario === 'core' ? options.entities : 12;
    for (let i = 0; i < count; i++)
      engine
        .createMesh()
        .setGeometry(geometry)
        .setMaterial(material)
        .setPosition(
          i
            ? [((i % 32) - 16) * 0.12, ((Math.floor(i / 32) % 32) - 16) * 0.12, -Math.floor(i / 1024) * 0.12]
            : [0, 0, 0],
        )
        .setScale(i ? [0.08, 0.08, 0.08] : [1, 1, 1]);
    const first = engine.meshes.get(0);
    if (scenario === 'allocation-failure') {
      const before = gpu.alive;
      gpu.failBuffer = 2;
      let rejected = false;
      try {
        app.box();
      } catch (error) {
        rejected = /Injected allocation failure/.test(String(error));
      }
      assert(
        rejected && engine.meshes.size === count && gpu.alive === before && gpu.injected === 1,
        'Allocation rollback leaked mesh or buffer',
      );
      checks.push('partial allocation rollback');
    }
    if (scenario === 'combined' || scenario === 'soak') {
      const fixture = animatedTriangle();
      model = parseGLTF(
        app.engine,
        fixture.doc,
        fixture.buffers.map((data) => new Uint8Array(data.buffer)),
      );
      Animation.attach(model).setMorph(0, 0, 0.5);
      const ssao = SSAO.attach(app.engine, { samples: 8 });
      ssao.add(model);
      const taa = TAA.attach(app.engine, { depth: () => ssao.depthTexture });
      taa.add(model);
      const shadows = Shadows.attach(app.engine, { resolution: 128, distance: 30 }),
        clustered = Clustered.attach(app.engine, { grid: [4, 3, 4] });
      shadows.add(model);
      shadows.add(first, { static: true });
      clustered.add(model);
      clustered.setLights([{ position: [0, 2, 2], range: 10, color: [1, 0.5, 0.1], intensity: 2 }]);
      const terrain = Terrain.attach(app.engine, {
        resolution: 16,
        levels: 3,
        origin: [-50, -50],
        size: [100, 100],
        heightScale: 1,
        layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
        textures: (device) => {
          const heightmap = device.createTexture({ size: [4, 4], format: 'r32float', usage: 6 }),
            layers = device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          device.queue.writeTexture({ texture: heightmap }, new Float32Array(16).fill(-2), { bytesPerRow: 16 }, [4, 4]);
          device.queue.writeTexture(
            { texture: layers },
            new Uint8Array([30, 100, 30, 255, 90, 80, 65, 255, 100, 100, 100, 255, 200, 180, 120, 255]),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      shadows.add(terrain, { static: true });
      clustered.add(terrain);
      VFX.attach(app.engine, { capacity: 1024, rate: 100, position: [0, 1, 0], lifetime: [1, 2] }).burst(256);
      Splats.attach(app.engine, cloud(128));
      checks.push('PBR skin/morph SSAO TAA shadows lights terrain VFX splats');
    }
    if (scenario === 'splats') {
      Splats.attach(app.engine, cloud(options.splats));
      checks.push(`${options.splats} splats`);
    }
    engine.render({ culling: false });
    await submitted(engine);
    const initial = [...first.matrix],
      lossFrame = Math.floor(options.frames * profile.lossFraction);
    if (scenario === 'recovery-failure' || scenario === 'dispose-recovery') {
      const old = engine.gpu;
      if (scenario === 'recovery-failure') gpu.failAdapter = true;
      else gpu.delay = 40;
      old.destroy();
      await wait(() => Boolean(engine.recovery) || expected.length > 0);
      if (scenario === 'dispose-recovery') {
        const recovery = engine.recovery;
        app.dispose();
        await recovery;
        checks.push('dispose during pending recovery');
      } else {
        await wait(() => expected.length === 1 && !engine.recovery);
        assert(/adapter unavailable/.test(expected[0]), 'Unexpected recovery error');
        checks.push('failed recovery reports once');
      }
      assert(store === engine.store && store.matrices.buffer === memory, 'Recovery replaced CPU state');
      return { checks, frames, expected };
    }
    if (scenario === 'webgl-loss') {
      let ticks = 0;
      app.onTick(() => ticks++);
      engine.start();
      await wait(() => ticks >= 2);
      const extension = app.canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
      assert(extension, 'Missing context loss extension');
      extension.loseContext();
      await wait(() => expected.length === 1);
      const before = ticks;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      assert(ticks === before && expected[0] === 'Error: WebGL context lost', 'WebGL loss failed to stop/report once');
      app.dispose();
      app = await createStage(host, { backend: 'webgl2', fallback: webglRenderer, autoStart: false });
      app.box();
      app.engine.render();
      await window.stressCapture();
      checks.push('WebGL loss stops RAF and permits remount');
      return { checks, frames, expected };
    }
    for (let frame = 0; frame < options.frames; frame++) {
      if (frame === Math.floor(options.frames / 4) || frame === Math.floor(options.frames / 2)) {
        const collapse = frame === Math.floor(options.frames / 4);
        host.style.width = collapse ? '0px' : `${profile.size[1]}px`;
        host.style.height = collapse ? '0px' : `${profile.size[0]}px`;
        app.canvas.style.minHeight = '0';
      }
      if (frame === lossFrame && engine.gpu) {
        const old = engine.gpu;
        if (profile.lossDuringPass) {
          const remove = engine.frameGraph.add({
            name: 'stress:loss',
            order: 100,
            execute() {
              old.destroy();
            },
          });
          engine.render();
          remove();
        } else old.destroy();
        await wait(() => engine.gpu !== old && !engine.recovery);
        assert(
          engine.store === store && store.matrices.buffer === memory && first === engine.meshes.get(0),
          'Device loss replaced CPU objects',
        );
        assert(
          first.matrix.every((value, i) => value === initial[i]),
          'Device loss changed transforms',
        );
        checks.push('device loss recovered');
      }
      const start = performance.now();
      engine.render({ culling: false, delta: [0, 0.001, 1 / 120, 1 / 60, 0.25, 1][frame % 6] });
      await submitted(engine);
      frames.push(performance.now() - start);
      assert(
        engine.camera.matrix.every(Number.isFinite) && store.matrices.every(Number.isFinite),
        'Nonfinite camera/transform',
      );
      assert(engine.stats.visible >= count && engine.stats.drawCalls > 0, 'Scene stopped drawing');
    }
    await window.stressCapture();
    assert(expected.length === 0, `Unexpected engine error: ${expected}`);
    const recycled = engine.createMesh(),
      id = recycled.id;
    recycled.dispose();
    const replacement = engine.createMesh();
    assert(replacement.id === id, 'Entity ID not reusable');
    replacement.dispose();
    checks.push('resize/collapse, hostile deltas, entity reuse');
    return { checks, frames, backend: engine.backend, entities: count, requests: gpu.requests };
  } finally {
    model?.dispose();
    app?.dispose();
    app?.dispose();
    host.remove();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert(document.querySelectorAll('canvas').length === 0, 'Canvas leaked after disposal');
    assert(gpu.alive === 0, `${gpu.alive} buffers/textures not explicitly destroyed`);
    assert(gpu.aliveDevices === 0, `${gpu.aliveDevices} devices not destroyed`);
  }
};
