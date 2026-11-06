import { DracoDecoder, KTX2Decoder, createKTX2Texture, getSupportedTranscodeFormat } from '@margoengine/decoders';
import { KTX2HDRDecoder } from '../dist/ktx2-hdr.js';
import { KTX2LayerDecoder } from '../dist/ktx2-layers.js';
import { KTX2GPUDecoder } from '../dist/ktx2-gpu.js';
import { KTX2Streamer } from '../dist/ktx2-stream.js';
import { JXLDecoder, jxlTextureFile, uploadTexture } from '../dist/jxl.js';
import { decodePNG } from '../dist/png.js';
import jxlRecords from './fixtures/jxl/records.json';
import { parsePVR } from '../dist/pvr.js';
import { DracoPointsDecoder } from '../dist/draco-points.js';

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

// Every level of a texture as tight RGBA8 rows, layer after layer, in the shape of TextureFile.mipmaps.
async function readLevels(device, texture) {
  const levels = [],
    layers = texture.depthOrArrayLayers;
  for (let level = 0; level < texture.mipLevelCount; level++) {
    const width = Math.max(1, texture.width >> level),
      height = Math.max(1, texture.height >> level),
      rowBytes = Math.ceil((width * 4) / 256) * 256,
      read = device.createBuffer({ size: rowBytes * height * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, mipLevel: level },
      { buffer: read, bytesPerRow: rowBytes, rowsPerImage: height },
      [width, height, layers],
    );
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const rows = new Uint8Array(read.getMappedRange()),
      tight = new Uint8Array(width * height * layers * 4);
    for (let y = 0; y < height * layers; y++)
      tight.set(rows.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
    read.destroy();
    levels.push(tight);
  }
  return levels;
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

  // UASTC HDR: BC6H on the real device decodes to the same light as the half-float texels, values over 1 included. BC6H is
  // a second lossy step after UASTC: the worst face channel of this real file measured 1.46 percent, so the bound is 2.
  const hdrFile = await (await fetch('/tests/fixtures/ktx2-hdr/cube-uastc-hdr.ktx2')).arrayBuffer(),
    half = new KTX2HDRDecoder({ device, target: 'rgba16float', workerLimit: 1 }),
    native = new KTX2HDRDecoder({ device, workerLimit: 1 }),
    halfCube = await half.createTexture(hdrFile);
  device.pushErrorScope('validation');
  const nativeCube = await native.createTexture(hdrFile),
    hdrError = await device.popErrorScope(),
    halfMeans = await layerMeans(device, halfCube, 96, 6),
    nativeMeans = await layerMeans(device, nativeCube, 96, 6);
  check(!hdrError, `HDR cube validation: ${hdrError?.message}`);
  check(halfCube.format === 'rgba16float' && halfCube.depthOrArrayLayers === 6, 'half-float HDR cube');
  check(nativeCube.format === (native.hdrTarget === 'bc6h' ? 'bc6h-rgb-ufloat' : 'rgba16float'), nativeCube.format);
  check(
    nativeMeans.every((v, i) => Math.abs(v - halfMeans[i]) <= 0.02 * Math.max(halfMeans[i], 0.05)),
    `${native.hdrTarget} faces match the half-float faces: ${[...nativeMeans]} vs ${[...halfMeans]}`,
  );
  report.hdr = { target: native.hdrTarget, means: [...nativeMeans], halfMeans: [...halfMeans] };
  half.dispose();
  native.dispose();
  checks.push(`UASTC HDR cube transcodes to ${native.hdrTarget} in workers and reads back on the GPU`);

  // Streaming: real Range reads, then a texture that grew level by level holds what the whole file gave, bit for bit.
  const statuses = [],
    streamFetch = async (...args) => {
      const response = await fetch(...args);
      statuses.push(response.status);
      return response;
    },
    streamer = new KTX2Streamer({ device, fetch: streamFetch, headBytes: 4096 }),
    toFull = async (stream) => {
      const changes = stream.updates();
      stream.want(1 << 20);
      streamer.update();
      for await (const _texture of changes) if (stream.residentLevel === 0) break;
    };
  device.pushErrorScope('validation');
  const streamCube = await streamer.open('/tests/fixtures/ktx2-layers/cube-uastc-zstd.ktx2'),
    hdrStream = await streamer.open('/tests/fixtures/ktx2-hdr/cube-uastc-hdr.ktx2'),
    firstLevel = streamCube.residentLevel;
  check(statuses.every((status) => status === 206), `Range reads answered ${statuses}`);
  check(firstLevel > 0 && streamCube.texture.width < 64, `a stream starts small, at level ${firstLevel}`);
  check(streamCube.format === packedCube.format, `${streamCube.format} stream of a ${packedCube.format} cube`);
  await toFull(streamCube);
  await toFull(hdrStream);
  const streamError = await device.popErrorScope(),
    streamMeans = await layerMeans(device, streamCube.texture, 64, 6),
    hdrStreamMeans = await layerMeans(device, hdrStream.texture, 96, 6);
  check(!streamError, `stream validation: ${streamError?.message}`);
  check(
    streamMeans.every((v, i) => v === packedMeans[i]),
    `streamed cube equals the whole file: ${[...streamMeans]} vs ${[...packedMeans]}`,
  );
  check(
    hdrStreamMeans.every((v, i) => v === nativeMeans[i]),
    `streamed HDR cube equals the whole file: ${[...hdrStreamMeans]} vs ${[...nativeMeans]}`,
  );
  streamCube.want(8);
  hdrStream.want(8);
  streamer.budgetBytes = streamCube.bytes(1) + hdrStream.bytes(1);
  streamer.update();
  check(streamCube.residentLevel === 1 && streamCube.texture.width === 32, 'a smaller budget drops the finest level');
  streamer.dispose();
  checks.push(`KTX2 mips stream by Range reads from level ${firstLevel} up and equal the whole file on the GPU`);

  // Basis on the GPU: every level, layer and face equals the Wasm transcoder's RGBA8, byte for byte, on real files.
  const gpuDecoder = new KTX2GPUDecoder({ device }),
    wasmRGBA = new KTX2LayerDecoder({ device, target: 'rgba8', workerLimit: 1 }),
    gpuFiles = [
      'ktx2-layers/cube-uastc-zstd.ktx2',
      'ktx2-layers/array-uastc.ktx2',
      'ktx2-layers/cube-etc1s.ktx2',
      'ktx2-layers/cube-array-etc1s.ktx2',
      'Dot_C.ktx2',
      'Rib_N.ktx2',
      'AnisotropyBarnLamp_normalbump.ktx2',
      'ktx2-gpu/alpha-uastc-zstd.ktx2',
      'ktx2-gpu/alpha-etc1s.ktx2',
      'ktx2-gpu/odd-uastc-zstd.ktx2',
      'ktx2-gpu/odd-etc1s.ktx2',
    ];
  report.gpuTranscode = [];
  for (const name of gpuFiles) {
    const bytes = await (await fetch(`/tests/fixtures/${name}`)).arrayBuffer(),
      wasmStart = performance.now(),
      expected = await wasmRGBA.decode(bytes.slice(0)),
      wasmMs = performance.now() - wasmStart;
    device.pushErrorScope('validation');
    const gpuStart = performance.now(),
      texture = await gpuDecoder.createTexture(bytes, { usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    await device.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - gpuStart,
      gpuError = await device.popErrorScope();
    check(!gpuError, `${name} GPU transcode validation: ${gpuError?.message}`);
    const levels = await readLevels(device, texture);
    check(levels.length === expected.mipmaps.length, `${name} levels ${levels.length}`);
    let differ = 0,
      worst = 0;
    levels.forEach((level, i) => {
      const wanted = expected.mipmaps[i].data;
      check(level.length === wanted.length, `${name} level ${i} holds ${level.length} bytes, not ${wanted.length}`);
      for (let at = 0; at < level.length; at++)
        if (level[at] !== wanted[at]) {
          differ++;
          worst = Math.max(worst, Math.abs(level[at] - wanted[at]));
        }
    });
    report.gpuTranscode.push({ name, levels: levels.length, layers: texture.depthOrArrayLayers, differ, worst, wasmMs, gpuMs });
    check(differ === 0, `${name}: ${differ} bytes differ from the Wasm transcoder, worst ${worst}`);
    texture.destroy();
    // A small storage buffer limit splits a level into bands; the bytes must not change.
    if (name.includes('cube-')) {
      const limits = { maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 4096 },
        small = new Proxy(device, {
          get: (target, key) => {
            if (key === 'limits') return limits;
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
        banded = new KTX2GPUDecoder({ device: small }),
        cut = await banded.createTexture(bytes, { usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }),
        cutLevels = await readLevels(device, cut);
      cutLevels.forEach((level, i) => {
        check(level.every((value, at) => value === levels[i][at]), `${name} level ${i} changes when it is cut into bands`);
      });
      cut.destroy();
      banded.dispose();
    }
  }
  gpuDecoder.dispose();
  wasmRGBA.dispose();
  checks.push('Basis on compute shaders equals the Wasm transcoder byte for byte on real UASTC and ETC1S files');
  // JPEG XL: the Wasm module in a module worker gives the bytes Node gives, and the result reads back from the GPU.
  // Vite turns the dynamic URL in `fixture` into a glob of one folder, so files in a subfolder are fetched by path.
  const jxlFile = async (name) => new Uint8Array(await (await fetch(`/tests/fixtures/jxl/${name}`)).arrayBuffer()),
    jxl = new JXLDecoder({ browser: false, workerLimit: 1 }),
    sha = async (data) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((v) => v.toString(16).padStart(2, '0')).join('');
  for (const [name, record] of Object.entries(jxlRecords)) {
    const image = await jxl.decode(await jxlFile(`${name}.jxl`));
    check(image.decoder === 'wasm', `${name} went through ${image.decoder}`);
    check((await sha(image.data)) === record.sha256, `${name} decodes to other bytes in the worker`);
  }
  check(spawned.some(({ url, type }) => url.includes('jxl.worker') && type === 'module'), 'JPEG XL ran in a module worker');
  const jxlBytes = await jxlFile('bicycles.jxl');
  let jxlCut;
  await jxl.decode(jxlBytes.subarray(0, jxlBytes.length - 1)).catch((error) => (jxlCut = error));
  check(/cut short/.test(jxlCut?.message), `a file cut short gave ${jxlCut}`);
  const jxlStop = new AbortController(),
    jxlAborted = jxl.decode(jxlBytes, { signal: jxlStop.signal });
  jxlStop.abort();
  let jxlAbort;
  await jxlAborted.catch((error) => (jxlAbort = error));
  check(jxlAbort?.name === 'AbortError', `abort gave ${jxlAbort}`);
  const jxlImage = await jxl.decode(jxlBytes),
    jxlTexture = uploadTexture(device, jxlTextureFile(jxlImage), {
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    }),
    [jxlTexels] = await readLevels(device, jxlTexture);
  check(jxlTexels.every((value, at) => value === jxlImage.data[at]), 'JPEG XL texels read back differ');
  jxlTexture.destroy();
  jxl.dispose();
  checks.push('JPEG XL decodes in a module worker to the bytes of the Node run, stops on abort, and reads back from the GPU');
  // The browser path. A real browser with JPEG XL is reported when there is one; on this Chromium a PNG stands in for it, so the
  // read back through the canvas is tested and the browser's own decoder is not.
  const jxlPNG = await jxlFile('blendmodes-reference.png'),
    { createImageBitmap: realBitmap } = window,
    plainPNG = decodePNG(jxlPNG).data;
  window.createImageBitmap = (blob, options) => {
    check(blob.type === 'image/jxl', `the browser was handed ${blob.type}`);
    return realBitmap.call(window, new Blob([jxlPNG], { type: 'image/png' }), options);
  };
  const jxlNative = new JXLDecoder({ workerLimit: 1 }),
    standIn = await jxlNative.decode(await jxlFile('blendmodes.jxl'));
  window.createImageBitmap = realBitmap;
  check(standIn.decoder === 'browser' && standIn.width === 1024, `stand-in went through ${standIn.decoder}`);
  for (let at = 3; at < plainPNG.length; at += 4)
    check(standIn.data[at] === plainPNG[at], `alpha at ${at} changed through the canvas`);
  report.jxlBrowser = (await jxlNative.decode(jxlBytes)).decoder;
  check((await jxlNative.decode(jxlBytes)).decoder === report.jxlBrowser, 'the second decode took another path');
  jxlNative.dispose();
  checks.push(`JPEG XL with no option: this browser went through ${report.jxlBrowser}; the canvas read back passed on a stand-in`);
  // PVR: every level of a real file, decoded on the CPU, reads back from the GPU as it was written.
  const pvr = parsePVR(new Uint8Array(await (await fetch('/tests/fixtures/pvr/fern.pvr')).arrayBuffer())),
    pvrTexture = uploadTexture(device, pvr, {
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    }),
    pvrLevels = await readLevels(device, pvrTexture);
  check(pvrLevels.length === pvr.mipmaps.length, `PVR uploaded ${pvrLevels.length} of ${pvr.mipmaps.length} levels`);
  pvrLevels.forEach((level, i) => {
    check(level.every((value, at) => value === pvr.mipmaps[i].data[at]), `PVR level ${i} reads back differently`);
  });
  pvrTexture.destroy();
  checks.push(`A real PVRTC file uploads as ${pvr.format}, ${pvr.mipmaps.length} levels, and reads back as decoded`);
  // Draco point clouds: the full build in a classic worker, with generic attributes and transferred arrays.
  const points = new DracoPointsDecoder({ workerLimit: 1 }),
    survey = await points.decode(await (await fetch('/tests/fixtures/draco-points/survey.drc')).arrayBuffer()),
    intensity = survey.attributes.find(({ name }) => name === 'intensity');
  check(survey.pointCount === 1000 && survey.indices.length === 1000 && survey.indices[999] === 999, 'survey cloud size');
  check(intensity?.array instanceof Float32Array && intensity.array[999] === 999 / 4, 'generic attribute through the worker');
  let pointsRefused;
  await points
    .decode(await (await fetch('/tests/fixtures/draco-points/survey.drc')).arrayBuffer(), { limits: { maxVertices: 10 } })
    .catch((error) => (pointsRefused = error));
  check(/raise maxVertices/.test(pointsRefused?.message), `limit gave ${pointsRefused}`);
  points.dispose();
  checks.push('Draco point clouds decode in a worker with indices, generic attributes and limits');
  rgba.dispose();
  negotiated.dispose();
  device.destroy();
  window.Worker = NativeWorker;
  return report;
};
