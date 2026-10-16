import { DracoDecoder, KTX2Decoder, createKTX2Texture, getSupportedTranscodeFormat } from '@margoengine/decoders';

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
  rgba.dispose();
  negotiated.dispose();
  device.destroy();
  window.Worker = NativeWorker;
  return report;
};
