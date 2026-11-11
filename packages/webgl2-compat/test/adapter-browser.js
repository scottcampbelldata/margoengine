// The page of adapter-browser.mjs: core on a real device at compatibility level, against the same scene at the full level,
// then each listed package on it. A compatibility device on a full GPU has the limits and validation of an older one.
import { box, Engine, PbrMaterial } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { boxGeometry } from '/packages/geometry/dist/primitives.js';
import { createInstancedMesh, createMesh, Material } from '/packages/materials/dist/index.js';
import { CulledInstances } from '/packages/culling/dist/index.js';
import { Shadows } from '/packages/shadows/dist/index.js';
import { VirtualShadows } from '/packages/shadows/dist/virtual.js';
import { PostStack } from '/packages/post/dist/stack.js';
import { Bloom } from '/packages/post/dist/bloom.js';
import { Tonemap } from '/packages/tonemap/dist/index.js';
import { allowCompatibilityAdapters } from '/packages/webgl2-compat/dist/adapter.js';
import { SceneTarget } from '/packages/shared/msaa.js';
import { PointCloud, PointsPlugin } from '/packages/points/dist/index.js';
import { Sky } from '/packages/sky/dist/index.js';
import { VolumetricFog } from '/packages/environment/dist/volumetric.js';
import { Water } from '/packages/water/dist/index.js';

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

/** A box over a floor, seen from above: the floor shows the shadow, soft by default, so the blocker search runs. */
const floorScene = (engine) => {
  const floor = engine.createMesh().setGeometry(box()).setScale([8, 0.1, 8]).setPosition([0, -1.5, 0]);
  floor.setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 0.8 }));
  return [scene(engine), floor];
};
const shadowScene = (engine) => {
  const shadows = Shadows.attach(engine, { resolution: 256, distance: 20 });
  for (const mesh of floorScene(engine)) shadows.add(mesh);
};
const postScene = (engine) => {
  scene(engine);
  PostStack.attach(engine, [new Bloom({ strength: 0.6 }), new Tonemap()]);
};
/** A bumpy sheet of points, so that eye-dome lighting has depth steps to work on. */
const sheet = () => {
  const positions = [];
  for (let z = -40; z <= 40; z++)
    for (let x = -40; x <= 40; x++) positions.push(x / 20, Math.sin(x / 3) * Math.cos(z / 4) * 0.3, z / 20);
  return positions;
};
const edlScene = (engine) => {
  const plugin = new PointsPlugin();
  engine.use(plugin);
  plugin.add(new PointCloud({ positions: sheet(), material: { size: 6, color: '#ffc040', edl: true } }));
};
/** Sky fog over PostStack's 4x capture: per sample by sample_index at the full level, by masked draws at the level. */
const fogScene = (engine, density = 0.2) => {
  floorScene(engine);
  const post = PostStack.attach(engine, [new Bloom({ strength: 0 }), new Tonemap()]);
  engine.use(new Sky({ hours: 10, timeScale: 0, fog: { depth: () => post.depthTexture, start: 1, density } }));
};
const skyScene = (engine) => fogScene(engine, 0);
/** The last of three frames of a scene seen from above, on a new engine. */
const frames = async (build) => {
  const view = await open({ camera: { position: [0, 3, 4], target: [0, 0, 0] } });
  await build(view.engine);
  let bytes;
  // fixed-wait: three frames, a count of frames rather than a time, so a package's later passes run too.
  for (let i = 0; i < 3; i++) bytes = await frame(view);
  await view.engine.gpu.queue.onSubmittedWorkDone();
  const errors = [...view.errors];
  close(view);
  return { bytes, errors };
};
/** How many bytes of two frames differ, and by how much at most. */
const compare = (a, b) => {
  let count = 0,
    largest = 0;
  const channels = [0, 0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    const difference = Math.abs(a[i] - b[i]);
    count += +(difference > 0);
    largest = Math.max(largest, difference);
    channels[i % 4] = Math.max(channels[i % 4], difference);
  }
  return { count, largest, channels };
};

/** Four different depth samples in one pixel, copied by SceneTarget into a 4x texture, read back sample by sample. */
const sampleCopy = async (device) => {
  const size = [1, 1],
    usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    color = device.createTexture({ size, format: 'rgba8unorm', usage }),
    depth = device.createTexture({ size, format: 'depth32float', usage }),
    target = new SceneTarget(device, color, depth, 4),
    copy = device.createTexture({ size, format: 'depth32float', sampleCount: 4, usage }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: target.depth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
  for (let sample = 0; sample < 4; sample++) {
    const module = device.createShaderModule({
      code: `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn fragment()->@builtin(frag_depth) f32 {return ${(sample + 1) / 8};}`,
    });
    pass.setPipeline(
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        multisample: { count: 4, mask: 1 << sample },
      }),
    );
    pass.draw(3);
  }
  pass.end();
  target.copyDepth(encoder, copy.createView(), 4, 'depth32float');
  const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', multisampled: true },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    }),
    pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({
          code: `@group(0) @binding(0) var map:texture_multisampled_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<f32,4>;
@compute @workgroup_size(1) fn main(){for(var i=0;i<4;i++){out[i]=textureLoad(map,vec2u(0),i).x;}}`,
        }),
        entryPoint: 'main',
      },
    }),
    buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    back = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    read = encoder.beginComputePass();
  read.setPipeline(pipeline);
  read.setBindGroup(
    0,
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: copy.createView() },
        { binding: 1, resource: { buffer } },
      ],
    }),
  );
  read.dispatchWorkgroups(1);
  read.end();
  encoder.copyBufferToBuffer(buffer, 0, back, 0, 16);
  device.queue.submit([encoder.finish()]);
  await back.mapAsync(GPUMapMode.READ);
  return [...new Float32Array(back.getMappedRange())];
};

/** Each one sets up a scene on the engine; the check draws three frames and looks for an error or a blank canvas. */
export const PACKAGES = {
  'core alone': (engine) => scene(engine),
  shadows(engine) {
    const shadows = Shadows.attach(engine, { resolution: 256, distance: 20 });
    shadows.add(scene(engine));
  },
  'virtual shadows soft'(engine) {
    VirtualShadows.attach(engine, { poolSize: 1024 }).add(scene(engine));
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
  // Bug (bug sweep L3): Bloom without PostStack made its 4x capture rgba16float, which the level cannot multisample,
  // and threw; it now takes PostStack's capture format (rg11b10ufloat there).
  'post bloom alone 4x'(engine) {
    scene(engine);
    Bloom.attach(engine, { strength: 0.6 });
  },
  // KB2272: these three read each sample of a 4x scene depth, by sample_index at the full level and by one masked draw
  // per sample at the compatibility level, which has no sample_index. PostStack's capture makes the scene 4x.
  'sky fog 4x'(engine) {
    scene(engine);
    const post = PostStack.attach(engine, [new Bloom({ strength: 0 }), new Tonemap()]);
    engine.use(new Sky({ hours: 10, timeScale: 0, fog: { depth: () => post.depthTexture, start: 1, density: 0.05 } }));
  },
  'environment volumetric 4x'(engine) {
    scene(engine);
    PostStack.attach(engine, [new Bloom({ strength: 0 }), new Tonemap()]);
    VolumetricFog.attach(engine, { density: 0.05 });
  },
  'water spray 4x'(engine) {
    scene(engine);
    PostStack.attach(engine, [new Bloom({ strength: 0 }), new Tonemap()]);
    const terrain = engine.gpu.createTexture({
      size: [16, 16],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    Water.attach(engine, {
      segments: 4,
      spray: true,
      terrain: { heightmap: () => terrain, origin: [-8, -8], size: [16, 16] },
    });
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
    const samplesFull = await sampleCopy(full.engine.gpu);
    close(full);
    const floorFull = await frames(floorScene),
      shadowFull = await frames(shadowScene),
      postFull = await frames(postScene),
      edlFull = await frames(edlScene),
      fogFull = await frames(fogScene),
      skyFull = await frames(skyScene);

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
    const coreErrors = [...compat.errors],
      samples = await sampleCopy(restored);
    close(compat);
    const shadowLevel = await frames(shadowScene),
      postLevel = await frames(postScene),
      edlLevel = await frames(edlScene),
      fogLevel = await frames(fogScene),
      skyLevel = await frames(skyScene),
      levels = {
        sky: compare(skyFull.bytes, skyLevel.bytes),
        fog: compare(fogFull.bytes, fogLevel.bytes),
        fogFullDrawn: compare(skyFull.bytes, fogFull.bytes),
        fogDrawn: compare(skyLevel.bytes, fogLevel.bytes),
        shadowCast: compare(floorFull.bytes, shadowFull.bytes),
        shadow: compare(shadowFull.bytes, shadowLevel.bytes),
        post: compare(postFull.bytes, postLevel.bytes),
        edl: compare(edlFull.bytes, edlLevel.bytes),
        edlLit: edlLevel.bytes.reduce((sum, value, i) => sum + +(i % 4 === 0 && value > 100), 0),
        samplesFull,
        samples,
        errors: [
          ...shadowLevel.errors,
          ...postLevel.errors,
          ...edlLevel.errors,
          ...fogFull.errors,
          ...fogLevel.errors,
          ...skyFull.errors,
          ...skyLevel.errors,
        ],
      };

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
    return {
      fullLimits,
      limits,
      levels,
      pixels: pixels.length,
      different,
      pick: pick === mesh,
      miss: miss === null,
      afterLoss,
      coreErrors,
      packages,
    };
  },
};
window.ready = true;
