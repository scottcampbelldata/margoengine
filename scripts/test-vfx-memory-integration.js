import assert from 'node:assert/strict';
import { writeFile, appendFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5199, args: [] }),
  errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(async () => {
    const assert = (value, message) => {
        if (!value) throw new Error(message);
      },
      { FrameGraph } = await import('/packages/core/dist/extension.js');
    const classes = await Promise.all(
        ['original', 'full', 'partial'].map((name) => import(`/test-results/vfx-inplace-${name}.mjs`)),
      ),
      names = ['original', 'full', 'partial'];
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    assert(adapter && !adapter.info.isFallbackAdapter, 'Native adapter required');
    assert(adapter.features.has('depth32float-stencil8'), 'Current stencil-format fixture requires device support');
    const resources = new Set(),
      retired = new WeakSet(),
      destroys = new WeakMap(),
      modules = [],
      devices = [],
      uncaptured = [],
      reports = [],
      compilationErrors = [];
    const device = async () => {
      const replacement = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      assert(
        replacement &&
          !replacement.info.isFallbackAdapter &&
          replacement.info.vendor === adapter.info.vendor &&
          replacement.info.architecture === adapter.info.architecture,
        'Replacement adapter changed hardware',
      );
      const d = await replacement.requestDevice({ requiredFeatures: ['depth32float-stencil8'] });
      devices.push(d);
      d.pushErrorScope('validation');
      d.addEventListener('uncapturederror', (event) => uncaptured.push(event.error.message));
      const createBuffer = d.createBuffer.bind(d),
        createShader = d.createShaderModule.bind(d);
      d.createBuffer = (descriptor) => {
        const b = createBuffer(descriptor),
          destroy = b.destroy.bind(b);
        resources.add(b);
        b.destroy = () => {
          destroys.set(b, (destroys.get(b) ?? 0) + 1);
          retired.add(b);
          destroy();
        };
        return b;
      };
      d.createShaderModule = (descriptor) => {
        const m = createShader(descriptor);
        modules.push(m);
        return m;
      };
      return d;
    };
    const texture = (d, descriptor) => {
      const t = d.createTexture(descriptor);
      resources.add(t);
      return t;
    };
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      capacity = 257,
      size = 128;
    try {
      for (let variant = 0; variant < classes.length; variant++) {
        let d = await device();
        const moduleStart = modules.length,
          graph = new FrameGraph(),
          plugins = new Map(),
          engine = {
            gpu: d,
            stats: { drawCalls: 0 },
            use(plugin) {
              graph.withOwner(plugin.name, () => {
                plugin.setup(this);
                plugin.registerPasses(graph);
              });
              plugins.set(plugin.name, plugin);
            },
            removePlugin(name) {
              const plugin = plugins.get(name);
              if (plugin) {
                graph.removeOwner(name);
                plugins.delete(name);
                plugin.dispose();
              }
            },
          };
        const before = new Set(resources),
          options = {
            capacity,
            initialCount: 193,
            rate: 0,
            position: [0, 0, 0.5],
            emissionExtent: [0.5, 0.2, 0],
            gravity: [0, 0, 0],
            velocity: [0, 0, 0],
            spread: 0,
            turbulence: 0,
            lifetime: [3, 3],
            size: 0.1,
            ground: -1,
            color: [0.3, 0.2, 0.6, 0.7],
            intensity: 4,
          };
        const effect = new classes[variant].VFX(options);
        engine.use(effect);
        const firstOwned = Array.from(resources).filter((resource) => !before.has(resource)),
          initialState = effect.gpuState.particles;
        const frame = async (samples, delta, format = 'depth32float') => {
          const color = texture(d, {
              size: [size, size],
              sampleCount: samples,
              format: 'rgba16float',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.COPY_SRC : 0),
            }),
            resolved =
              samples === 1
                ? color
                : texture(d, {
                    size: [size, size],
                    format: 'rgba16float',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                  });
          const depth = texture(d, {
              size: [size, size],
              sampleCount: samples,
              format,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            }),
            colorView = color.createView(),
            depthView = depth.createView(),
            encoder = d.createCommandEncoder();
          encoder
            .beginRenderPass({
              colorAttachments: [{ view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
              depthStencilAttachment: {
                view: depthView,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 0,
                ...(format.includes('stencil')
                  ? { stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 }
                  : {}),
              },
            })
            .end();
          graph.execute({
            backend: 'webgpu',
            device: d,
            encoder,
            delta,
            draw() {},
            format: 'rgba16float',
            color: colorView,
            depth: depthView,
            width: size,
            height: size,
            camera: { matrix: identity, position: [0, 0, 4], target: [0, 0, 0] },
            descriptor: { multisample: { count: samples }, depthStencil: { format } },
          });
          if (samples === 4)
            encoder
              .beginRenderPass({
                colorAttachments: [
                  { view: colorView, resolveTarget: resolved.createView(), loadOp: 'load', storeOp: 'store' },
                ],
              })
              .end();
          const state = effect.gpuState,
            stateBytes = capacity * 64,
            read = d.createBuffer({ size: stateBytes + 24, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            image = d.createBuffer({ size: size * size * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          encoder.copyBufferToBuffer(state.particles, 0, read, 0, stateBytes);
          encoder.copyBufferToBuffer(state.indirect, 0, read, stateBytes, 20);
          encoder.copyTextureToBuffer({ texture: resolved }, { buffer: image, bytesPerRow: size * 8 }, [size, size]);
          d.queue.submit([encoder.finish()]);
          await Promise.all([read.mapAsync(GPUMapMode.READ), image.mapAsync(GPUMapMode.READ)]);
          const mapped = read.getMappedRange(),
            values = new Float32Array(mapped, 0, capacity * 16),
            args = new Uint32Array(mapped, stateBytes, 5),
            pixels = new Uint16Array(image.getMappedRange());
          let alive = 0,
            visible = 0,
            invalid = 0;
          for (let id = 0; id < capacity; id++) {
            const at = id * 16;
            for (let field = 0; field < 16; field++)
              assert(Number.isFinite(values[at + field]), 'Nonfinite actual-class field');
            if (values[at + 3] > 0) {
              alive++;
              for (let channel = 0; channel < 3; channel++)
                assert(
                  values[at + 8 + channel] === Math.fround(Math.fround(options.color[channel]) * 4),
                  'Actual class HDR uniform packing changed',
                );
              assert(
                values[at + 11] === Math.fround(0.7) && values[at + 7] === Math.fround(0.1) && values[at + 14] === 3,
                'Actual class size/alpha/lifetime changed',
              );
            }
          }
          assert(
            args[0] === 6 && args[1] === alive && alive === 193 && args[2] === 0 && args[3] === 0 && args[4] === 0,
            'Actual-class indirect population changed',
          );
          for (let pixel = 0; pixel < size * size; pixel++) {
            if (pixels[pixel * 4 + 3]) visible++;
            for (let channel = 0; channel < 4; channel++)
              if ((pixels[pixel * 4 + channel] & 0x7c00) === 0x7c00) invalid++;
          }
          assert(visible > 100 && !invalid, 'Actual-class rendered frame absent/invalid');
          read.unmap();
          image.unmap();
          return {
            samples,
            depthFormat: format,
            alive,
            visiblePixels: visible,
            currentState: state.particles,
            drawCalls: engine.stats.drawCalls,
          };
        };
        const first = await frame(1, 0),
          second = await frame(4, 0.1, 'depth32float-stencil8');
        if (variant) {
          assert(
            first.currentState === initialState && second.currentState === initialState,
            'Single-buffer current reference changed',
          );
        } else {
          assert(
            first.currentState !== initialState && second.currentState === initialState,
            'Reference baseline did not alternate',
          );
        }
        const held = effect.gpuState,
          oldDevice = d;
        d = await device();
        engine.gpu = d;
        effect.onDeviceRestored(engine);
        assert(
          firstOwned.every((buffer) => retired.has(buffer) && destroys.get(buffer) === 1),
          'Restoration did not retire each old owned buffer once',
        );
        assert(
          effect.gpuState.particles !== held.particles && effect.gpuState.indirect !== held.indirect,
          'Restoration reused old-device state',
        );
        const restored = await frame(4, 0);
        const liveOwned = Array.from(resources).filter(
          (resource) => resource instanceof GPUBuffer && !retired.has(resource),
        );
        effect.dispose();
        effect.dispose();
        assert(!plugins.has(effect.name), 'Disposed plugin remained registered');
        let throws = false;
        try {
          effect.gpuState;
        } catch {
          throws = true;
        }
        assert(throws, 'Disposed current-state getter remained usable');
        // The plugin owns six/seven buffers; readback and frame attachments remain fixture-owned.
        const currentOwnBuffers = liveOwned.filter((buffer) =>
          [224, capacity * 64, capacity * 4, 20, 8, 24].includes(buffer.size),
        );
        assert(
          currentOwnBuffers.every((buffer) => retired.has(buffer) && destroys.get(buffer) === 1),
          'Dispose did not retire each current owned buffer once',
        );
        reports.push({
          name: names[variant],
          particleRecordBytes: 64,
          firstPopulation: first.alive,
          oneSampleVisiblePixels: first.visiblePixels,
          fourSampleStencilVisiblePixels: second.visiblePixels,
          stableCurrentState: variant > 0,
          restoredPopulation: restored.alive,
          restoredStateDifferentDevice: true,
          ownedBuffers: firstOwned.length,
          stateAllocationBytes: firstOwned
            .filter((buffer) => buffer.size === capacity * 64)
            .reduce((sum, buffer) => sum + buffer.size, 0),
          oldOwnedBuffersDestroyedExactlyOnce: true,
          currentOwnedBuffersDestroyedExactlyOnce: true,
          disposedPluginUnregistered: true,
        });
        compilationErrors.push(
          ...(await Promise.all(modules.slice(moduleStart).map((m) => m.getCompilationInfo()))).flatMap((info) =>
            info.messages.filter((message) => message.type === 'error').map((message) => message.message),
          ),
        );
        for (const resource of resources)
          if (!retired.has(resource)) {
            resource.destroy();
            retired.add(resource);
          }
        const oldValidation = await oldDevice.popErrorScope(),
          newValidation = await d.popErrorScope();
        assert(!oldValidation && !newValidation, oldValidation?.message ?? newValidation?.message);
        oldDevice.destroy();
        d.destroy();
      }
      assert(!compilationErrors.length && !uncaptured.length, JSON.stringify({ compilationErrors, uncaptured }));
      return { reports, compilationErrors, uncaptured, productionEdited: false, actualCompiledClass: true };
    } finally {
      for (const resource of resources)
        if (!retired.has(resource)) {
          resource.destroy();
          retired.add(resource);
        }
      for (const d of devices) d.destroy();
    }
  });
  assert.deepEqual(errors, []);
  const report = { hardware: browser.hardware, ...result };
  await writeFile('test-results/vfx-inplace-class-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await appendFile(
    'test-results/vfx-inplace-class-failures.jsonl',
    JSON.stringify({ recordedAt: new Date().toISOString(), message: error.message, stack: error.stack }) + '\n',
  );
  throw error;
} finally {
  await browser.close();
}
