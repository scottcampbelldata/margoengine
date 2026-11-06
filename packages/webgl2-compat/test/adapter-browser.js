// The page of adapter-browser.mjs: core on a real device at compatibility level, against the same scene at the full level,
// then each listed package on it. A compatibility device on a full GPU has the limits and validation of an older one.
import { box, Engine, PbrMaterial } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { boxGeometry } from '/packages/geometry/dist/primitives.js';
import { createInstancedMesh, createMesh, Material } from '/packages/materials/dist/index.js';
import { CulledInstances } from '/packages/culling/dist/index.js';
import { Shadows } from '/packages/shadows/dist/index.js';
import { PostStack } from '/packages/post/dist/stack.js';
import { Bloom } from '/packages/post/dist/bloom.js';
import { Tonemap } from '/packages/tonemap/dist/index.js';
import { allowCompatibilityAdapters } from '/packages/webgl2-compat/dist/adapter.js';

const open = async (options) => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const kernel = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 3], target: [0, 0, 0] },
      ...options,
    }),
    engine = engineRuntime(kernel),
    errors = [];
  engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  return { canvas, engine, kernel, errors };
};
/** The canvas right after a frame, as bytes. */
const frame = async ({ canvas, engine }) => {
  engine.render({ delta: 0 });
  const image = new Image();
  image.src = canvas.toDataURL('image/png');
  await image.decode();
  const flat = new OffscreenCanvas(image.width, image.height).getContext('2d');
  flat.drawImage(image, 0, 0);
  return flat.getImageData(0, 0, image.width, image.height).data;
};
const scene = (engine) =>
  engine
    .createMesh()
    .setGeometry(box())
    .setRotation([0.4, 0.6, 0])
    .setMaterial(new PbrMaterial({ color: '#ff2000', roughness: 0.5 }));
const close = ({ canvas, engine }) => {
  engine.dispose();
  canvas.remove();
};

/** Each one sets up a scene on the engine; the check draws three frames and looks for an error or a blank canvas. */
const PACKAGES = {
  'core alone': (engine) => scene(engine),
  shadows(engine) {
    const shadows = Shadows.attach(engine, { resolution: 256, distance: 20 });
    shadows.add(scene(engine));
  },
  'materials createMesh': (engine) => createMesh(engine, boxGeometry(1, 1, 1), new Material({ color: '#ff2000' })),
  'materials createInstancedMesh': (engine) => {
    const boxes = createInstancedMesh(engine, boxGeometry(1, 1, 1), new Material({ color: '#ff2000' }), 4);
    boxes.count = 1;
  },
  culling(engine) {
    CulledInstances.attach(engine, [
      {
        geometry: box(),
        material: new PbrMaterial({ color: '#ff2000' }),
        transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      },
    ]);
  },
  'post bloom and tonemap'(engine) {
    scene(engine);
    PostStack.attach(engine, [new Bloom({ strength: 0.6 }), new Tonemap()]);
  },
};

window.check = {
  async run() {
    const full = await open({}),
      fullLimits = {
        core: full.engine.gpu.features.has('core-features-and-limits'),
        vertexStorage: full.engine.gpu.limits.maxStorageBuffersInVertexStage,
      };
    scene(full.engine);
    const expected = await frame(full);
    close(full);

    const adapters = allowCompatibilityAdapters({ force: true }),
      compat = await open({}),
      gpu = compat.engine.gpu,
      limits = {
        core: gpu.features.has('core-features-and-limits'),
        vertexStorage: gpu.limits.maxStorageBuffersInVertexStage,
        colorAttachments: gpu.limits.maxColorAttachments,
      },
      mesh = scene(compat.engine),
      pixels = await frame(compat);
    let different = 0;
    for (let i = 0; i < pixels.length; i++) different += +(pixels[i] !== expected[i]);
    const pick = await compat.kernel.pick(32, 32),
      miss = await compat.kernel.pick(1, 1);
    // A lost device comes back at the same level, since core asks through the same requestAdapter.
    const previous = compat.engine.gpu;
    await compat.engine.rebootDevice();
    const restored = compat.engine.gpu,
      afterLoss = {
        replaced: restored !== previous,
        core: restored.features.has('core-features-and-limits'),
        drew: (await frame(compat))[(32 * 64 + 32) * 4],
      };
    const coreErrors = [...compat.errors];
    close(compat);

    const packages = {};
    for (const [name, build] of Object.entries(PACKAGES)) {
      let view;
      try {
        view = await open({});
        await build(view.engine);
        let bytes;
        // fixed-wait: three frames, a count of frames rather than a time, so a package's later passes run too.
        for (let i = 0; i < 3; i++) bytes = await frame(view);
        await view.engine.gpu.queue.onSubmittedWorkDone();
        const lit = bytes.reduce((sum, value, i) => sum + +(i % 4 === 0 && value > 100), 0);
        packages[name] = view.errors.length ? `validation: ${view.errors[0].slice(0, 300)}` : `ok, ${lit} lit pixels`;
      } catch (error) {
        packages[name] = `threw: ${String(view?.errors[0] ?? error.message ?? error).slice(0, 300)}`;
      }
      if (view) close(view);
    }
    adapters.dispose();
    return { fullLimits, limits, pixels: pixels.length, different, pick: pick === mesh, miss: miss === null, afterLoss, coreErrors, packages };
  },
};
window.ready = true;
