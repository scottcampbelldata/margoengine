// Fuzz targets for launch gate 11a part 1: the glTF, texture and image parsers. @margoengine/gltf (light loader),
// gltf-pro (main thread, the parse-worker job, KHR_texture_basisu KTX2 through the real Basis transcoder, the
// progressive range-request stream), blender's .margo, decoders (meshopt, Draco and KTX2 through their real Wasm) and
// environment (HDR, EXR, UltraHDR). Seeds are the repo's own files (helpers in formats.js); part 2's parsers are in
// targets-assets.js. Besides the harness oracle, outputs are checked (finite, in range: `GARBAGE: ...`), meshopt
// reads past its stream are caught, and every fourth input also runs inside a larger buffer: a result that changes
// with the bytes around the input means a parser ignored byteOffset.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isNamed } from './harness.js';
import {
  checkModel,
  decoder,
  digest,
  displaced,
  dist,
  encoder,
  files,
  fromGLB,
  gltfSeeds,
  hash,
  headless,
  imageBitmap,
  ktx2GLB,
  lightSeeds,
  margoWithScene,
  mutateBytesN,
  mutateDoc,
  mutateGLTF,
  read,
  root,
  splitParams,
  toGLB,
  withParams,
} from './formats.js';

const maxDownloadBytes = 8 * 1024 * 1024,
  MiB = 1024 * 1024,
  // The loaders' own message wraps JSON.parse's detail (the error position): named, though it quotes engine words.
  own = /^Invalid glTF JSON: /;

/**
 * Runs `parse` once, or (every fourth input) on a copy and on the same bytes amid junk, and compares the results.
 * Each result is reduced to its digest before the next run, so two large images are never alive at once.
 */
async function neighbours(bytes, parse) {
  if (hash(bytes) % 4) {
    await parse(bytes.slice());
    return;
  }
  const run = async (b) => {
    try {
      return { key: digest(await parse(b)).join(',') };
    } catch (error) {
      return { error, key: `throws ${error?.name}: ${error?.message}` };
    }
  };
  const a = await run(bytes.slice());
  if (a.error && !isNamed(a.error, { own })) throw a.error;
  globalThis.gc?.(); // the first result (up to MAX_PIXELS of floats) must not count twice against the memory budget
  const b = await run(displaced(bytes));
  if (a.key !== b.key)
    throw new Error(`GARBAGE: the result changes with the bytes around the input (${a.key.slice(0, 80)})`);
  if (a.error) throw a.error;
}

// --- Wasm decoders in this process, as the decoder worker runs them -------------------------------------------------
const require = createRequire(join(root, 'package.json'));
export async function wasm(kind) {
  globalThis.require ??= require;
  globalThis.__dirname ??= join(root, 'packages/decoders/dist');
  const { initDraco, initBasis } = await import(dist('decoders/dist/codec.js')),
    base = join(root, 'packages/decoders/dist', kind),
    load = async (url) => (0, eval)(readFileSync(new URL(url), 'utf8')),
    realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(readFileSync(new URL(url)));
  try {
    const url = (name) => pathToFileURL(join(base, name)).href;
    return kind === 'draco'
      ? (await initDraco(url('draco_wasm_wrapper.js'), url('draco_decoder.wasm'), load)).module
      : (await initBasis(url('basis_transcoder.js'), url('basis_transcoder.wasm'), load)).module;
  } finally {
    globalThis.fetch = realFetch;
  }
}
/** A Wasm decoder target: after an unnamed error (a trap) the module may be corrupt, so the next input gets a new one. */
async function withModule(target, kind, run) {
  if (target.poisoned) {
    target.module = await wasm(kind);
    target.poisoned = false;
  }
  try {
    return await run(target.module);
  } catch (error) {
    if (!isNamed(error, target)) target.poisoned = true;
    throw error;
  }
}

/** Offsets of the KTX2 header and level index fields (KTX 2.0, section 3), for targeted corruption. */
function ktx2Fields(bytes) {
  const out = [12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72],
    levels =
      bytes.length >= 44
        ? Math.min(16, Math.max(1, new DataView(bytes.buffer, bytes.byteOffset).getUint32(40, true)))
        : 1;
  for (let i = 0; i < levels; i++) out.push(80 + i * 24, 84 + i * 24, 88 + i * 24, 96 + i * 24);
  return out.filter((f) => f + 4 <= bytes.length);
}
const ktx2Files = () => files('packages/decoders/tests/fixtures', /\.ktx2$/);
const TRANSCODE = ['rgba8', 'bc7', 'astc-4x4', 'etc2'];

// --- gltf-pro/progressive: a mock WebGPU engine and an HTTP server for one in-memory file ------------------------
async function gpuEngine() {
  const [{ optionalGPU }, { Engine, TransformStore }] = await Promise.all([
    import(pathToFileURL(join(root, 'tests/support/optional-gpu.js')).href),
    import(dist('core/dist/extension.js')),
  ]);
  globalThis.GPUTextureUsage ??= {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  };
  globalThis.createImageBitmap = imageBitmap;
  const device = optionalGPU().engine.gpu;
  device.createSampler = (descriptor) => ({ descriptor });
  device.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  device.queue.submit = () => {};
  device.queue.copyExternalImageToTexture = () => {};
  device.queue.writeTexture = () => {};
  device.limits.maxTextureDimension2D = 8192;
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(4096),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(128 / 96, true);
  return engine;
}
// 'range' answers Range requests (206), 'plain' ignores them (200, whole file), 'short' sends half of each range under
// a header claiming all of it, 'wrong' answers a different range, 'empty' sends no body.
const SERVER = ['range', 'plain', 'short', 'wrong', 'empty'];
function server(bytes, mode) {
  return async (_url, { headers, signal } = {}) => {
    signal?.throwIfAborted();
    const range = mode !== 'plain' && /^bytes=(\d+)-(\d*)$/.exec(headers?.Range ?? headers?.range ?? '');
    if (mode === 'empty') return new Response(new Uint8Array(0), { status: range ? 206 : 200 });
    if (!range)
      return new Response(bytes.slice(), { status: 200, headers: { 'content-length': String(bytes.length) } });
    let lo = +range[1];
    const hi = Math.min(range[2] ? +range[2] : bytes.length - 1, bytes.length - 1);
    if (lo > hi) return new Response(null, { status: 416 });
    if (mode === 'wrong') lo = Math.max(0, lo - 7);
    const sent = mode === 'short' ? Math.max(1, (hi - lo + 1) >> 1) : hi - lo + 1;
    return new Response(bytes.slice(lo, lo + sent), {
      status: 206,
      headers: { 'content-range': `bytes ${lo}-${hi}/${bytes.length}`, 'content-length': String(sent) },
    });
  };
}

// --- environment seeds ------------------------------------------------------------------------------------------
function hdrSeeds() {
  const header = (w, h) => [...encoder.encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1\n\n-Y ${h} +X ${w}\n`)],
    flat = [...header(4, 2), ...Array.from({ length: 32 }, (_, i) => (i % 4 === 3 ? 130 : i * 7) & 255)],
    rle = header(8, 2);
  for (let y = 0; y < 2; y++) {
    rle.push(2, 2, 0, 8);
    for (let c = 0; c < 4; c++) rle.push(...(c === 1 ? [4, 1, 2, 3, 4, 132, 9] : [136, c * 9 + 1]));
  }
  return [...files('packages/environment/tests/fixtures', /\.hdr$/), Uint8Array.from(flat), Uint8Array.from(rle)];
}
// UltraHDR as in packages/environment/tests: a primary JPEG and a gain-map JPEG with hdrgm XMP metadata.
export function ultraSeeds() {
  const segment = (marker, payload) => [
      0xff,
      marker,
      (payload.length + 2) >> 8,
      (payload.length + 2) & 255,
      ...payload,
    ],
    ascii = (text) => [...encoder.encode(text)],
    xmp = (body) => segment(0xe1, ascii(`http://ns.adobe.com/xap/1.0/\0${body}`)),
    sof = (w, h) => segment(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    jpeg = (id, w, ...apps) =>
      [0xff, 0xd8, ...apps.flat(), ...segment(0xdb, [0, id]), ...sof(w, w)].concat(segment(0xda, [1, 2, 3]), [
        id,
        0xff,
        0,
        7,
        0xff,
        0xd3,
        9,
        0xff,
        0xd9,
      ]),
    gain = `<x:xmpmeta><rdf:Description hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2" hdrgm:Gamma="1" hdrgm:OffsetSDR="0" hdrgm:OffsetHDR="0" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2"/></x:xmpmeta>`,
    elements =
      '<rdf:Description><hdrgm:GainMapMax><rdf:Seq><rdf:li>1</rdf:li><rdf:li>2</rdf:li><rdf:li>3</rdf:li></rdf:Seq></hdrgm:GainMapMax><hdrgm:HDRCapacityMax>2</hdrgm:HDRCapacityMax><hdrgm:Gamma>1 1 2</hdrgm:Gamma></rdf:Description>';
  return [
    Uint8Array.from([
      ...jpeg(1, 16, xmp('<rdf:Description hdrgm:Version="1.0"/>'), segment(0xe2, ascii('MPF\0'))),
      0,
      0,
      ...jpeg(2, 8, xmp(gain)),
    ]),
    Uint8Array.from([...jpeg(1, 12), ...jpeg(2, 4, xmp(elements))]),
  ];
}
/** Test JPEG "decoder": the SOF size (refusing what a browser would), a deterministic gradient. */
export function fakeJPEG(jpeg) {
  for (let p = 2; p + 8 < jpeg.length; ) {
    if (jpeg[p] !== 0xff) break;
    const marker = jpeg[p + 1],
      length = (jpeg[p + 2] << 8) | jpeg[p + 3];
    if (marker === 0xc0) {
      const height = (jpeg[p + 5] << 8) | jpeg[p + 6],
        width = (jpeg[p + 7] << 8) | jpeg[p + 8];
      if (!width || !height || width * height > 1 << 20) throw new Error('JPEG decode failed');
      return { width, height, data: Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37) & 255) };
    }
    p += 2 + length;
  }
  throw new Error('JPEG decode failed');
}
// EXR may hold Inf and NaN on purpose (AllHalfValues.exr), so only the shape is checked.
const sized = (image) => {
  if (!(image?.data instanceof Float32Array) || image.data.length !== image.width * image.height * 4)
    throw new Error('GARBAGE: image data does not match width x height x 4');
  return image;
};

const gltfPro = (name, description, extra) => ({
  name,
  description,
  own,
  timeMs: 3000,
  memory: 256 * MiB,
  generators: [
    function structure(r, context) {
      return mutateGLTF(r, context.seeds);
    },
  ],
  generatorRate: 0.75,
  ...extra,
});

export default [
  {
    name: 'gltf',
    description: '@margoengine/gltf parseGLTF (light loader): JSON and GLB container, accessors, node graph',
    own,
    timeMs: 3000,
    memory: 512 * MiB,
    async setup() {
      this.parse = (await import(dist('gltf/dist/index.js'))).parseGLTF;
      this.engine = await headless();
    },
    seeds: async () => lightSeeds(gltfSeeds()),
    generators: [
      function structure(r, context) {
        return mutateGLTF(r, context.seeds);
      },
    ],
    generatorRate: 0.75,
    async run(bytes) {
      await neighbours(bytes, (b) => {
        const model = this.parse(this.engine, b);
        try {
          return model.meshes.map((m) => [m.geometry?.vertices, m.geometry?.indices]);
        } finally {
          model.dispose();
        }
      });
    },
  },
  gltfPro(
    'gltf-pro',
    'gltf-pro parseGLTFAsync: accessors (sparse, normalized, strides), images, every KHR_/EXT_ extension',
    {
      async setup() {
        const [{ parseGLTFAsync }, { instancing }, { extendedMaterials }, { MeshoptDecoder }] = await Promise.all([
          import(dist('gltf-pro/dist/index.js')),
          import(dist('gltf-pro/dist/instancing.js')),
          import(dist('gltf-pro/dist/extended.js')),
          import(dist('decoders/dist/index.js')),
        ]);
        this.parse = parseGLTFAsync;
        this.decoders = { instancing, materials: extendedMaterials, meshopt: MeshoptDecoder };
        this.engine = await headless();
      },
      seeds: async () => gltfSeeds(),
      async run(bytes) {
        await neighbours(bytes, async (b) => {
          const model = await this.parse(this.engine, b, { decoders: this.decoders, maxDownloadBytes });
          try {
            return await checkModel(model);
          } finally {
            model.dispose();
          }
        });
      },
    },
  ),
  gltfPro(
    'gltf-pro/worker',
    'gltf-pro parse-worker job: prepareGLTF, structured clone with transfers, modelFromPrepared',
    {
      async setup() {
        const [{ prepareGLTF }, { modelFromPrepared }, { instancing }, { extendedMaterials }, { transferables }] =
          await Promise.all([
            import(dist('gltf-pro/dist/prepare.js')),
            import(dist('gltf-pro/dist/worker.js')),
            import(dist('gltf-pro/dist/instancing.js')),
            import(dist('gltf-pro/dist/extended.js')),
            import(dist('shared/worker.js')),
          ]);
        Object.assign(this, { prepareGLTF, modelFromPrepared, transferables, engine: await headless() });
        this.decoders = { instancing, materials: extendedMaterials };
      },
      seeds: async () => gltfSeeds(),
      async run(bytes) {
        // The job runs in the worker; postMessage structured-clones its reply; the model is built on the main thread.
        const prepared = await this.prepareGLTF(undefined, bytes, undefined, maxDownloadBytes),
          moved = structuredClone(prepared, {
            transfer: [...this.transferables(prepared)].filter((b) => b instanceof ArrayBuffer),
          }),
          model = this.modelFromPrepared(this.engine, moved, undefined, this.decoders);
        try {
          await checkModel(model);
        } finally {
          model.dispose();
        }
      },
    },
  ),
  gltfPro('gltf-pro/ktx2', 'gltf-pro KHR_texture_basisu: KTX2 header and budget checks, the real Basis transcoder', {
    timeMs: 8000,
    memory: 1100 * MiB,
    async setup() {
      const [{ parseGLTFAsync }, codec] = await Promise.all([
        import(dist('gltf-pro/dist/index.js')),
        import(dist('decoders/dist/codec.js')),
      ]);
      this.parse = parseGLTFAsync;
      this.module = await wasm('basis');
      // The transcode target follows the file (a pure function of its bytes), as a device's formats would.
      this.decoders = {
        ktx2: {
          transcode: (data) =>
            withModule(this, 'basis', (basis) =>
              codec.transcodeKTX2(basis, data, TRANSCODE[data.length % TRANSCODE.length]),
            ),
        },
      };
      this.engine = await headless();
    },
    seeds: async () => ktx2Files().flatMap((k) => [ktx2GLB(k), ktx2GLB(k, { fallback: true })]),
    generators: [
      function structure(r, context) {
        return mutateGLTF(r, context.seeds);
      },
      function ktx2Image(r, context) {
        // The embedded KTX2 file corrupted at its header and level index fields; the GLB around it stays valid.
        const { doc, bin } = fromGLB(r.pick(context.seeds)),
          view = doc.bufferViews[3],
          image = mutateBytesN(r, bin.subarray(view.byteOffset, view.byteOffset + view.byteLength), {
            fields: ktx2Fields(bin.subarray(view.byteOffset)),
            donors: ktx2Files(),
          }),
          out = new Uint8Array(view.byteOffset + image.length);
        out.set(bin.subarray(0, view.byteOffset));
        out.set(image, view.byteOffset);
        view.byteLength = image.length;
        doc.buffers[0].byteLength = out.length;
        return toGLB(doc, out);
      },
    ],
    async run(bytes) {
      const model = await this.parse(this.engine, bytes, { decoders: this.decoders, maxDownloadBytes });
      try {
        await checkModel(model);
      } finally {
        model.dispose();
      }
    },
  }),
  gltfPro(
    'gltf-pro/progressive',
    'gltf-pro/progressive: GLB/JSON head and range requests against misbehaving servers',
    {
      timeMs: 8000,
      async setup() {
        this.load = (await import(dist('gltf-pro/dist/progressive.js'))).loadGLTFProgressive;
        this.engine = await gpuEngine();
      },
      seeds: async () => gltfSeeds(256 * 1024).map((s, i) => withParams([i % SERVER.length], s)),
      generators: [
        function structure(r, context) {
          return withParams(
            [r.int(SERVER.length)],
            mutateGLTF(
              r,
              context.seeds.map((s) => splitParams(s).body),
            ),
          );
        },
      ],
      async run(bytes) {
        const { params, body } = splitParams(bytes),
          fetch = globalThis.fetch;
        globalThis.fetch = server(body, SERVER[params[0] % SERVER.length]);
        const load = this.load(this.engine, 'https://fuzz.test/model.glb', { maxDownloadBytes });
        try {
          const model = await load.complete;
          try {
            await checkModel(model);
          } finally {
            model.dispose();
          }
        } finally {
          load.abort();
          globalThis.fetch = fetch;
        }
      },
    },
  ),
  {
    name: 'margo',
    description: '@margoengine/blender parseMargo: header, section table, scene JSON, packed geometry, PNG headers',
    own,
    timeMs: 3000,
    memory: 768 * MiB,
    async setup() {
      this.parse = (await import(dist('blender/dist/index.js'))).parseMargo;
      this.engine = await headless();
    },
    seeds: async () => files('packages/blender/tests/fixtures', /\.margo$/),
    generators: [
      function scene(r, context) {
        // The scene JSON (section 1) mutated as a glTF-like tree and re-packed with a consistent section table.
        const bytes = r.pick(context.seeds),
          view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          offset = view.getUint32(68, true),
          size = view.getUint32(72, true);
        let doc = JSON.parse(decoder.decode(bytes.subarray(offset, offset + size)));
        for (let k = 1 + r.int(3); k--; ) doc = mutateDoc(r, doc) ?? doc;
        let json;
        try {
          json = encoder.encode(JSON.stringify(doc));
        } catch {
          json = bytes.subarray(offset, offset + size);
        }
        return margoWithScene(bytes, json);
      },
      function fields(r, context) {
        const bytes = r.pick(context.seeds),
          count = Math.min(64, new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)),
          offsets = [
            8,
            12,
            16,
            24,
            ...Array.from({ length: count }, (_, i) => [64, 68, 72, 76].map((f) => f + i * 16)).flat(),
          ];
        return mutateBytesN(r, bytes, { fields: offsets, donors: context.seeds });
      },
    ],
    generatorRate: 0.8,
    async run(bytes) {
      await neighbours(bytes, async (b) => {
        const model = await this.parse(this.engine, b.byteOffset % 4 ? b.slice() : b);
        try {
          return await checkModel(model);
        } finally {
          model.dispose();
        }
      });
    },
  },
  {
    name: 'decoders/meshopt',
    description: 'decoders meshopt: vertex codec v0/v1, index codec, index sequence, every filter; reads checked',
    memory: 600 * MiB,
    // params: count u32, stride u16, mode (bits 0-1) and filter (bits 2-4), a hostile count/stride variant
    async seeds() {
      const MODE = ['ATTRIBUTES', 'TRIANGLES', 'INDICES'],
        FILTER = ['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL', 'COLOR'],
        seed = (count, stride, mode, filter, bytes) => {
          const p = new Uint8Array(8),
            v = new DataView(p.buffer);
          v.setUint32(0, count, true);
          v.setUint16(4, stride, true);
          p[6] = MODE.indexOf(mode) | (Math.max(0, FILTER.indexOf(filter ?? 'NONE')) << 2);
          return withParams(p, bytes);
        },
        out = JSON.parse(decoder.decode(read('packages/decoders/tests/fixtures/meshopt-vectors.json'))).cases.map((c) =>
          seed(
            c.count,
            c.stride,
            c.mode,
            c.filter,
            Uint8Array.from(atob(c.encoded), (ch) => ch.charCodeAt(0)),
          ),
        );
      const doc = JSON.parse(decoder.decode(read('examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.gltf'))),
        bin = read('examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.bin');
      for (const v of doc.bufferViews) {
        const m = v.extensions?.EXT_meshopt_compression;
        if (m)
          out.push(
            seed(
              m.count,
              m.byteStride,
              m.mode,
              m.filter,
              bin.subarray(m.byteOffset ?? 0, (m.byteOffset ?? 0) + m.byteLength),
            ),
          );
      }
      return out;
    },
    generators: [
      function stream(r, context) {
        const { params, body } = splitParams(r.pick(context.seeds));
        if (r.chance(0.1)) params[7] = 1 + r.int(15); // a hostile count or stride variant
        if (r.chance(0.05)) params[6] ^= 1 << r.int(6);
        return withParams(params, r.chance(0.9) ? mutateBytesN(r, body, { fields: [0, 1, 2, 4, 8] }) : body);
      },
    ],
    generatorRate: 0.85,
    async setup() {
      Object.assign(this, await import(dist('decoders/dist/index.js')));
    },
    async run(bytes) {
      const { params, view, body } = splitParams(bytes),
        raw = view.getUint32(0, true),
        variant = params[7] & 15,
        count = [raw, raw, -1, 1.5, raw + 1, raw * 2, 2 ** 20, 2 ** 31, 0, 3][variant % 10],
        stride = [view.getUint16(4, true), -4, 0, 1, 3, 252, 256, 260][(variant >> 1) % 8],
        mode = ['ATTRIBUTES', 'TRIANGLES', 'INDICES', 'X'][params[6] & 3],
        filter = ['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL', 'COLOR', undefined, 'Y', 'NONE'][
          (params[6] >> 2) & 7
        ];
      // A read outside the stream throws instead of yielding undefined (decoded as 0: garbage with no error).
      const checked = new Proxy(body, {
        get(target, key) {
          if (typeof key === 'string' && /^-?\d+$/.test(key) && (+key < 0 || +key >= target.length))
            throw new Error(`GARBAGE: meshopt read src[${key}] outside its ${target.length}-byte stream`);
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      // Both entry points: the glTF buffer helper that allocates its output, and the decoder that fills one.
      if (body.length & 1) return this.decodeMeshoptBuffer(checked, count, stride, mode, filter);
      const size = count * stride,
        out = new Uint8Array(Number.isSafeInteger(size) && size > 0 && size < 1 << 26 ? size : 0);
      this.MeshoptDecoder.decodeGltfBuffer(out, count, stride, checked, mode, filter);
    },
  },
  {
    name: 'decoders/draco',
    description: 'decoders Draco: codec.decodeDraco on the real draco_decoder.wasm, as the decoder worker runs it',
    timeMs: 5000,
    memory: 1100 * MiB,
    async setup() {
      this.codec = await import(dist('decoders/dist/codec.js'));
      this.module = await wasm('draco');
      this.attributes = this.sources.map((s) => s.attributes);
    },
    sources: ['Box', 'Avocado'].map((name) => {
      const doc = JSON.parse(decoder.decode(read(`packages/decoders/tests/fixtures/${name}.gltf`))),
        bin = read(`packages/decoders/tests/fixtures/${name}.bin`),
        ext = doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression,
        view = doc.bufferViews[ext.bufferView];
      return {
        attributes: ext.attributes,
        bytes: bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
      };
    }),
    async seeds() {
      return this.sources.map((s, i) => withParams([i], s.bytes));
    },
    generators: [
      function draco(r, context) {
        const { params, body } = splitParams(r.pick(context.seeds));
        if (r.chance(0.1)) params[1] = 1 + r.int(4);
        if (r.chance(0.2)) params[2] = 1 + r.int(7);
        return withParams(params, mutateBytesN(r, body, { fields: [0, 4, 8, 12, 16, 20] }));
      },
    ],
    generatorRate: 0.85,
    async run(bytes) {
      const { params, body } = splitParams(bytes),
        attributeIds = [
          this.attributes[params[0] % this.attributes.length],
          undefined,
          { POSITION: 7, TEXCOORD_0: 99 },
          { POSITION: -1 },
          { POSITION: 2 ** 31, NORMAL: 0 },
        ][params[1] % 5],
        componentTypes =
          params[2] % 8 ? { TANGENT: [5120, 5121, 5122, 5123, 5125, 5126, 1][(params[2] % 8) - 1] } : undefined;
      await withModule(this, 'draco', (draco) => {
        const g = this.codec.decodeDraco(draco, body, { attributeIds, componentTypes });
        if (g.indices?.some((i) => i >= g.vertexCount)) throw new Error('GARBAGE: Draco index out of range');
        // Float attributes decode as stored (NaN included): the loaders check finiteness, as for any accessor.
        if (g.positions.length && g.positions.length !== g.vertexCount * 3)
          throw new Error('GARBAGE: Draco positions length');
      });
    },
  },
  {
    name: 'decoders/ktx2',
    description: 'decoders KTX2: codec.transcodeKTX2 on the real basis_transcoder.wasm (every target format)',
    timeMs: 8000,
    memory: 1100 * MiB,
    async setup() {
      this.codec = await import(dist('decoders/dist/codec.js'));
      this.module = await wasm('basis');
    },
    seeds: async () => ktx2Files().flatMap((k) => TRANSCODE.map((_, t) => withParams([t], k))),
    generators: [
      function ktx2(r, context) {
        const { params, body } = splitParams(r.pick(context.seeds));
        return withParams(params, mutateBytesN(r, body, { fields: ktx2Fields(body), donors: ktx2Files() }));
      },
    ],
    generatorRate: 0.85,
    async run(bytes) {
      const { params, body } = splitParams(bytes);
      await withModule(this, 'basis', (basis) => {
        const result = this.codec.transcodeKTX2(basis, body, TRANSCODE[params[0] % TRANSCODE.length]);
        for (const m of result.mipmaps)
          if (m.data.byteLength !== m.byteLength) throw new Error('GARBAGE: KTX2 mip size');
      });
    },
  },
  {
    name: 'environment/hdr',
    description: 'environment parseHDR: Radiance header, flat, old-style RLE and adaptive RLE scanlines',
    memory: 1300 * MiB,
    async setup() {
      this.parse = (await import(dist('environment/dist/index.js'))).parseHDR;
    },
    seeds: async () => hdrSeeds(),
    generators: [
      function resolution(r, context) {
        const text = Buffer.from(r.pick(context.seeds)).toString('latin1'),
          head = text.indexOf('\n\n') + 2,
          end = text.indexOf('\n', head) + 1,
          line = r.pick([
            `-Y ${r.pick([0, 1, 2, 8, 65535, 2 ** 26, 2 ** 31, 1e20])} +X ${r.pick([0, 1, 4, 8, 32767, 32768, 2 ** 26])}\n`,
            '+Y 2 +X 4\n',
            '-Y 2 -X 4\n',
            '+X 4 -Y 2\n',
            'garbage\n',
          ]);
        return mutateBytesN(r, new Uint8Array(Buffer.from(text.slice(0, head) + line + text.slice(end), 'latin1')), {});
      },
      function bytes(r, context) {
        return mutateBytesN(r, r.pick(context.seeds), { donors: context.seeds });
      },
    ],
    generatorRate: 0.7,
    async run(bytes) {
      await neighbours(bytes, (b) => sized(this.parse(b)));
    },
  },
  {
    name: 'environment/exr',
    description: 'environment parseEXR: attributes, offset table, NONE/RLE/ZIPS/ZIP/PIZ chunks, Huffman, wavelet',
    memory: 1300 * MiB,
    own: /^(Invalid EXR|Unsupported EXR|Corrupt deflate stream)/,
    async setup() {
      this.parse = (await import(dist('environment/dist/index.js'))).parseEXR;
    },
    seeds: async () => files('packages/environment/tests/fixtures', /\.exr$/).filter((s) => s.length < 100_000),
    generators: [
      function attributes(r, context) {
        // Every int32 after an attribute's name and type, and the start of the offset table.
        const bytes = r.pick(context.seeds),
          fields = [4];
        for (let p = 8, guard = 0; p < bytes.length && guard < 64; guard++) {
          const n = bytes.indexOf(0, p);
          if (n < 0 || n === p) {
            fields.push(n + 1);
            break;
          }
          const t = bytes.indexOf(0, n + 1);
          if (t < 0 || t + 5 > bytes.length) break;
          fields.push(t + 1);
          const size = new DataView(bytes.buffer, bytes.byteOffset).getInt32(t + 1, true);
          for (let f = t + 5; f < t + 5 + size && f < t + 5 + 64; f += 4) fields.push(f);
          p = t + 5 + size;
        }
        return mutateBytesN(r, bytes, { fields, donors: context.seeds });
      },
    ],
    generatorRate: 0.8,
    async run(bytes) {
      await neighbours(bytes, (b) => sized(this.parse(b)));
    },
  },
  {
    name: 'environment/ultrahdr',
    description: 'environment decodeUltraHDR: JPEG marker walk, hdrgm XMP metadata, gain map application',
    memory: 256 * MiB,
    async setup() {
      this.decode = (await import(dist('environment/dist/index.js'))).decodeUltraHDR;
    },
    seeds: async () => ultraSeeds().map((s) => withParams([0], s)),
    generators: [
      function metadata(r, context) {
        const { body } = splitParams(r.pick(context.seeds)),
          name = r.pick(['GainMapMin', 'GainMapMax', 'Gamma', 'OffsetSDR', 'OffsetHDR', 'HDRCapacityMax']),
          value = r.pick([
            '0',
            '-1',
            '1e309',
            'NaN',
            '1 2',
            '1 2 3 4',
            '',
            '"',
            '-0',
            '1e-320',
            '9'.repeat(400),
            '<hdrgm:X>'.repeat(200),
          ]),
          text = Buffer.from(body)
            .toString('latin1')
            .replace(new RegExp(`hdrgm:${name}="[^"]*"`), `hdrgm:${name}="${value}"`);
        return withParams(
          [r.chance(0.9) ? 0 : 1 + r.int(5)],
          mutateBytesN(r, new Uint8Array(Buffer.from(text, 'latin1')), {}),
        );
      },
      function bytes(r, context) {
        const { params, body } = splitParams(r.pick(context.seeds));
        return withParams(params, mutateBytesN(r, body, { donors: context.seeds.map((s) => splitParams(s).body) }));
      },
    ],
    generatorRate: 0.8,
    async run(bytes) {
      const { params, body } = splitParams(bytes),
        weight = [1, 0, 0.5, -1, 2, Number.NaN][params[0] % 6];
      sized(await this.decode(body, { decode: fakeJPEG, weight }));
    },
  },
];
