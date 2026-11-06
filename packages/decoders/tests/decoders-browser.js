import { DracoDecoder, KTX2Decoder, createKTX2Texture, getSupportedTranscodeFormat } from '@margoengine/decoders';
import { KTX2LayerDecoder } from '../dist/ktx2-layers.js';

const fixture = async (name) =>
  new Uint8Array(await (await fetch(new URL(`./fixtures/${name}`, import.meta.url))).arrayBuffer());
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Longest gap between animation frames while `work` runs; a blocked main thread shows up as a long gap. */
async function longestFrameGap(work) {
  let running = true,
    previous = performance.now(),
    longest = 0;
  const frame = (time) => {
    longest = Math.max(longest, time - previous);
    previous = time;
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const started = performance.now();
  try {
    await work();
  } finally {
    running = false;
  }
  return { longest, elapsed: performance.now() - started };
}

/** Mean RGB of each layer of a 2D-array view of `texture`, read through the sampler path by a compute shader. */
async function layerMeans(device, texture, size, layers) {
  const code = `@group(0) @binding(0) var image: texture_2d_array<f32>;
    @group(0) @binding(1) var<storage, read_write> sums: array<vec4f>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
      var total = vec4f(0);
      for (var y = 0u; y < ${size}u; y++) {
        for (var x = 0u; x < ${size}u; x++) { total += textureLoad(image, vec2u(x, y), id.x, 0); }
      }
      sums[id.x] = total / f32(${size * size});
    }`;
  const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    }),
    sums = device.createBuffer({ size: layers * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: layers * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: { buffer: sums } },
      ],
    }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(layers);
  pass.end();
  encoder.copyBufferToBuffer(sums, 0, read, 0, layers * 16);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const means = new Float32Array(read.getMappedRange().slice(0));
  read.destroy();
  sums.destroy();
  return means;
}

window.runDecoderTests = async () => {
  const checks = [],
    report = { checks };
  const spawned = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      spawned.push({ url: String(url), type: options?.type });
    }
  };

  // Draco through classic workers (importScripts, no eval) against the glTF accessor contract.
  const draco = new DracoDecoder({ workerLimit: 2 });
  for (const name of ['Box', 'Avocado']) {
    const doc = JSON.parse(new TextDecoder().decode(await fixture(`${name}.gltf`))),
      bin = await fixture(`${name}.bin`),
      primitive = doc.meshes[0].primitives[0];
    const ext = primitive.extensions.KHR_draco_mesh_compression,
      view = doc.bufferViews[ext.bufferView];
    const result = await draco.decode(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), {
      attributeIds: ext.attributes,
      componentTypes: { TANGENT: 5126 },
    });
    check(result.vertexCount === doc.accessors[primitive.attributes.POSITION].count, `${name} vertex count`);
    check(result.indices.length === doc.accessors[primitive.indices].count, `${name} index count`);
    check(
      result.positions.buffer.byteLength === result.positions.byteLength,
      `${name} positions own a transferred buffer`,
    );
    check(bin.byteLength > 0, `${name} caller buffer kept`);
  }
  checks.push('Draco Box and Avocado decode in classic workers with transferred, owned arrays');

  const doc = JSON.parse(new TextDecoder().decode(await fixture('Avocado.gltf'))),
    bin = await fixture('Avocado.bin'),
    ids = doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.attributes;
  const burst = await longestFrameGap(() =>
    Promise.all(Array.from({ length: 64 }, () => draco.decode(bin, { attributeIds: ids }))),
  );
  check(
    spawned.length === 2 && spawned.every((w) => w.type === undefined),
    `worker limit respected: ${spawned.length}`,
  );
  report.dracoBurst = { decodes: 64, ...burst };
  checks.push('64 concurrent Draco decodes share a 2-worker pool');

  const aborted = new AbortController(),
    pending = draco.decode(bin, { attributeIds: ids, signal: aborted.signal });
  aborted.abort(new Error('cancelled'));
  check(
    await pending.then(
      () => false,
      (error) => error.message === 'cancelled',
    ),
    'abort rejects',
  );
  check(
    await draco.decode(new Uint8Array([1, 2, 3, 4])).then(
      () => false,
      (error) => /Draco/.test(error.message),
    ),
    'corrupt data rejects with a Draco error',
  );
  check((await draco.decode(bin, { attributeIds: ids })).vertexCount === 406, 'pool still healthy after errors');
  draco.dispose();
  check(
    await draco.decode(bin, { attributeIds: ids }).then(() => true),
    'a disposed decoder starts a fresh pool on next use',
  );
  draco.dispose();
  checks.push('Abort, corrupt input and disposal');

  // KTX2: negotiate against the real device, transcode in workers, upload with writeTexture and read back.
  const adapter = await navigator.gpu?.requestAdapter();
  check(adapter, 'WebGPU adapter');
  const wanted = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2'].filter((f) =>
    adapter.features.has(f),
  );
  const device = await adapter.requestDevice({ requiredFeatures: wanted });
  report.adapterFeatures = wanted;
  const ktx = await fixture('AnisotropyBarnLamp_normalbump.ktx2');
  const negotiated = new KTX2Decoder({ device, workerLimit: 2 });
  check(negotiated.target === getSupportedTranscodeFormat(device), 'decoder uses negotiated target');
  const before = spawned.length;
  const lamp = await longestFrameGap(() =>
    Promise.all([1, 2, 3, 4].map(() => negotiated.createTexture(ktx, { label: 'lamp' }))),
  );
  check(spawned.length - before === 2, 'KTX2 pool respects its limit');
  report.ktx2 = { target: negotiated.target, transcodes: 4, ...lamp };
  device.pushErrorScope('validation');
  const compressed = await negotiated.createTexture(ktx);
  const validation = await device.popErrorScope();
  check(!validation, `compressed upload validation: ${validation?.message}`);
  check(
    compressed.format.startsWith(
      { 'bc7': 'bc7', 'astc-4x4': 'astc', 'etc2': 'etc2', 'rgba8': 'rgba8' }[negotiated.target],
    ),
    `texture format ${compressed.format}`,
  );
  checks.push(`KTX2 transcodes to ${negotiated.target} and uploads with writeTexture without validation errors`);

  const rgba = new KTX2Decoder({ device, target: 'rgba8', workerLimit: 1 });
  const decoded = await rgba.transcode(ktx);
  check(
    decoded.format === 'rgba8unorm' && decoded.mipmaps[0].data.buffer.byteLength === 2048 * 2048 * 4,
    'rgba8 result in one transferred buffer',
  );
  const texture = createKTX2Texture(device, decoded, {
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: [1000, 1000, 0] },
    { buffer: readback, bytesPerRow: 256 * 4 },
    [256, 1, 1],
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const gpu = new Uint8Array(readback.getMappedRange()),
    row = 2048 * 4 * 1000 + 1000 * 4,
    cpu = decoded.mipmaps[0].data.subarray(row, row + 256 * 4);
  check(
    gpu.every((v, i) => v === cpu[i]),
    'GPU texels match the transcoded data',
  );
  readback.unmap();
  checks.push('RGBA8 upload reads back byte-identical from the GPU');

  // KTX2 cube maps: transcoded in workers, uploaded on the real device, every face where the file put it.
  const layerFile = async (name) => (await fetch(`/tests/fixtures/ktx2-layers/${name}`)).arrayBuffer(),
    cubeFile = await layerFile('cube-uastc-zstd.ktx2'),
    plain = new KTX2LayerDecoder({ device, target: 'rgba8', workerLimit: 1 }),
    packed = new KTX2LayerDecoder({ device, workerLimit: 1 }),
    plainCube = await plain.createTexture(cubeFile),
    _scope = device.pushErrorScope('validation'),
    packedCube = await packed.createTexture(cubeFile),
    packedError = await device.popErrorScope(),
    plainMeans = await layerMeans(device, plainCube, 64, 6),
    packedMeans = await layerMeans(device, packedCube, 64, 6);
  check(!packedError, `compressed cube validation: ${packedError?.message}`);
  check(plainCube.depthOrArrayLayers === 6 && plainCube.mipLevelCount === 7, 'cube texture has 6 layers and 7 mips');
  check(new Set(Array.from(plainMeans, (v) => v.toFixed(3))).size > 6, 'cube faces differ');
  check(
    packedMeans.every((v, i) => Math.abs(v - plainMeans[i]) < 2 / 255),
    `${packed.target} cube faces match the rgba8 faces: ${[...packedMeans]} vs ${[...plainMeans]}`,
  );
  plain.dispose();
  packed.dispose();
  checks.push(`KTX2 cube map transcodes to ${packed.target} in workers and each face reads back on the GPU`);
  rgba.dispose();
  negotiated.dispose();
  device.destroy();
  window.Worker = NativeWorker;
  return report;
};
