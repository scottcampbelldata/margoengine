# @margoengine/decoders

Worker-pooled Draco geometry decoding, KTX2/Basis Universal texture transcoding and EXT_meshopt_compression decoding, and synchronous PNG, TGA, TIFF, DDS and KTX 1 reading (`@margoengine/decoders/png`, `/tga`, `/tiff`, `/dds`, `/ktx`), for Margo Engine.

Build from source with `npm run build` in `packages/decoders`.

```ts
import {DracoDecoder, KTX2Decoder} from '@margoengine/decoders';

const draco = new DracoDecoder({workerLimit: 4});
const ktx2 = new KTX2Decoder({device: engine.gpu, workerLimit: 4});

// A KHR_draco_mesh_compression bufferView, with the extension's attribute ids.
const geometry = await draco.decode(bytes, {attributeIds: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}});
geometry.positions; // Float32Array
geometry.indices;   // Uint16Array or Uint32Array

// Transcodes to BC7, ASTC 4x4, ETC2 or RGBA8, whichever the device has enabled, then writes every mip level.
const texture = await ktx2.createTexture(await (await fetch('/albedo.ktx2')).arrayBuffer());

// On teardown:
draco.dispose(); ktx2.dispose();
```

A standalone `.ktx2` goes on a material map through `@margoengine/materials`: `loadKTX2Texture(url, {decoder: ktx2})`,
or `new Texture(await ktx2.transcode(bytes))`, which uploads the transcoded mips on each device that draws it.

## Meshopt

`decodeMeshoptBuffer(source, count, stride, mode, filter)` decodes one `EXT_meshopt_compression` or `KHR_meshopt_compression` bufferView (ATTRIBUTES, TRIANGLES or INDICES, with the OCTAHEDRAL, QUATERNION, EXPONENTIAL and COLOR filters) and returns a `Uint8Array`. It is pure TypeScript, written from the two extension specifications, synchronous and needs no Wasm. Output matches the meshoptimizer reference decoder bit for bit. Attribute streams of vertex codec version 0 (the only one `EXT_meshopt_compression` defines) and version 1 (added by `KHR_meshopt_compression`) are both decoded, whichever extension names the bufferView; any other version is rejected with a clear error. `MeshoptDecoder` has the members of the meshoptimizer project's own decoder object (`supported`, `ready`, `decodeGltfBuffer`), so glTF loaders written against that interface work unchanged.

## Texture upload (`@margoengine/decoders/texture`)

`getSupportedTranscodeFormat`, `getBytesPerRow` and `createKTX2Texture` (also on the root) without the transcoder or the
Draco and meshopt modules, for code that uploads textures a `KTX2Decoder` already transcoded. gltf-pro imports these
from here and loads the root only when a file needs decoding.

## PNG (`@margoengine/decoders/png`)

`decodePNG(bytes, {maxPixels?})` reads any valid PNG (W3C PNG Specification, Third Edition) to
`{width, height, data}`: RGBA8 rows, top first. Every colour type and bit depth (16-bit keeps the high byte, sub-byte
grey scales to 0-255), all five filters, Adam7, palette and `tRNS` alpha. Chunk CRCs, chunk order and the exact
decompressed size are checked; a broken file throws `MargoError` `failed`, an image over `maxPixels` (default 2^26,
an 8192 x 8192 image) a RangeError. Ancillary chunks are skipped, so samples come out as stored, without gamma or ICC
colour management. It is synchronous and runs on the calling thread (no worker), with the engine's shared zlib
inflater (the one EXR uses); it does not load the Draco or Basis decoders.

```ts
import {decodePNG} from '@margoengine/decoders/png';

const {width, height, data} = decodePNG(pngBytes);
```

Measured in Node 26 on the development machine: a 2048 x 2048 RGBA PNG decodes in 110 to 130 ms (incompressible or
smooth content). All 179 PNGs in this repository decode to the same pixels as libvips (one file's embedded ICC profile,
which libvips applies, removed first).

## TGA, TIFF, DDS and KTX 1 (`@margoengine/decoders/tga`, `/tiff`, `/dds`, `/ktx`)

Four small synchronous readers, each its own entry and each written from its published specification (Truevision TGA
2.0, Adobe TIFF 6.0, Microsoft's DDS documentation, Khronos KTX 1.1). None loads the workers or Wasm decoders.

- `parseTGA(bytes, {maxPixels?})` returns `{width, height, data}`, RGBA8 rows top first, like `decodePNG`: image
  types 1, 2, 3 and their RLE forms 9, 10, 11; 8-, 15-, 16-, 24- and 32-bit pixels; colour maps of 15 to 32 bits;
  any origin corner; alpha from the descriptor bits, with a TGA 2.0 extension area's "no alpha" honoured and
  premultiplied alpha divided out.
- `parseTIFF(bytes, {maxPixels?})` reads the first image: little- or big-endian, strips or tiles, uncompressed, LZW
  (with Predictor 2 at 8 and 16 bits), PackBits or Deflate; grey (either polarity), RGB and palette at 1, 2, 4, 8 or 16 bits per
  sample, chunky or planar, with an associated or unassociated alpha extra sample. Integer images come out as
  `{width, height, format: 'rgba8unorm', data: Uint8Array}` (16-bit samples scale to 0-255), 32-bit float images as
  `{format: 'rgba32float', data: Float32Array}`. JPEG, CMYK, YCbCr, signed samples and the float predictor are refused.
- `parseDDS(bytes)` and `parseKTX(bytes)` return a `TextureFile`: `{width, height, layers, dimension, mipmaps, format,
  feature?, target, srgb, hasAlpha}` with every mip level, each level holding all its layers (cube faces in WebGPU
  order +X, -X, +Y, -Y, +Z, -Z) back to back. Block-compressed data passes through untouched: BC1 to BC7 (sRGB, BC4 and
  BC5 signed, BC6H signed and unsigned) from either file, and ETC1, ETC2, EAC and every ASTC block size from KTX.
  `feature` names the device feature such a format needs. DDS BGRA8, BGRX8, 565, 5551, 4444, 24-bit, luminance and
  alpha-only pixels, and KTX RGB8, become `rgba8unorm`; RGBA8, R8, RG8, 16- and 32-bit float and the packed
  10-bit and shared-exponent formats pass through. 2D textures, cube maps and arrays of either; volume and 1D textures
  are refused. KTX padding rules (row, cube and mip) are followed, big-endian files are swapped, and key/value data
  is skipped, so `KTXorientation` is not applied and rows come out as stored.
- `uploadTexture(device, file, {label?, usage?})` (on both `/dds` and `/ktx`) creates the GPUTexture and writes every
  level and layer. On a device without the feature (`texture-compression-bc`, `-etc2` or `-astc`) it throws
  `MargoError` `unsupported` naming the feature to request in `requestDevice`.

Broken files throw `MargoError` `failed` naming the problem; a non-`Uint8Array` input is a TypeError and an image over
`maxPixels` a RangeError.

```ts
import {parseTGA} from '@margoengine/decoders/tga';
import {parseTIFF} from '@margoengine/decoders/tiff';
import {parseDDS, uploadTexture} from '@margoengine/decoders/dds';

declare const device: GPUDevice;
declare const tgaBytes: Uint8Array, tiffBytes: Uint8Array, ddsBytes: Uint8Array;

const decal = parseTGA(tgaBytes); // {width, height, data: RGBA8}
const heightMap = parseTIFF(tiffBytes); // rgba8unorm or rgba32float
const sky = parseDDS(ddsBytes); // e.g. a BC6H cube map
if (sky.feature && !device.features.has(sky.feature)) console.warn(`${sky.format} needs ${sky.feature}`);
const texture = uploadTexture(device, sky);
```

With `@margoengine/materials`, `new Texture(decal)` and `new Texture(heightMap)` take the TGA and TIFF results as raw or
data images. A DDS or KTX result that is one 2D layer in `rgba8unorm`, `bc7-rgba-unorm`, `astc-4x4-unorm` or
`etc2-rgba8unorm` (each with or without `-srgb`) is also a transcoded texture `new Texture(file)` accepts; other formats,
cube maps and arrays go through `uploadTexture` and are handed to materials as a GPUTexture.

`tests/tga.test.js`, `dds.test.js`, `ktx.test.js` and `tiff.test.js` build every supported variant with the encoders in
`tests/support/texture-encoders.js` and check decoded pixels exactly. `scripts/texture-fixtures.mjs` uses the same
encoders to write the 64x64 demo checkerboards in `examples/assets/texture-formats/`.

## How it works

- **Workers, not the main thread.** Each decoder owns a lazily grown pool of module workers, by default `Math.min(navigator.hardwareConcurrency || 4, 4)`. Jobs go to an idle worker, then a new one while under the limit, then the least loaded. A crashed worker rejects only its own jobs and is replaced on the next call.
- **Zero-copy results.** Every decoded array owns its own buffer and returns through `postMessage` transfer lists. KTX2 mip levels are views into one transferred buffer and go straight to `device.queue.writeTexture`. Inputs are copied by default so the caller keeps its buffer; pass `{transfer: true}` to move a whole `ArrayBuffer` instead.
- **Memory release.** The worker destroys every Draco decoder, buffer and mesh handle and frees every heap allocation after each decode, including on errors. KTX2 files are closed and deleted the same way.
- **Hardware format negotiation.** `getSupportedTranscodeFormat(device)` checks `texture-compression-bc`, then `-astc`, then `-etc2`, and falls back to `rgba8`. A device only reports these features when they were requested in `requestDevice`, so an engine that requests none always gets RGBA8. Compressed targets fall back to RGBA8 when level 0 is not a multiple of 4 pixels. sRGB files get the `-srgb` format variant.
- **Bundler and SSR safety.** Workers are created with `new Worker(new URL('./decoder.worker.js', import.meta.url), {type: 'module'})`, and the Wasm decoders are referenced the same way. Vite, webpack 5 and Next.js therefore emit them as assets. Nothing touches `window`, `Worker` or `navigator` at import time, so construction is safe during SSR. Decoding on the server rejects with a clear error.

## Options

| Option | Decoder | Default |
| --- | --- | --- |
| `decoderPath` | Draco | Bundled copy. Point at a CDN folder holding `draco_wasm_wrapper.js` and `draco_decoder.wasm`, e.g. `https://www.gstatic.com/draco/versioned/decoders/1.5.7/` |
| `transcoderPath` | KTX2 | Bundled copy. Folder holding `basis_transcoder.js` and `basis_transcoder.wasm` |
| `workerLimit` | both | Hardware threads, capped at 4 (allowed range 1 to 16) |
| `device` | KTX2 | None. Picks the target and is required by `createTexture` |
| `target` | KTX2 | Negotiated from `device`. Set `'rgba8'` for CPU access to texels |
| `timeout` | both | 10 s plus 4 s per MiB of input. Most milliseconds one decode may run; past it the worker is restarted and the decode rejects (`Draco decode timed out after ... ms`). `Infinity` disables it |

`decode` and `transcode` also accept an `AbortSignal` as `signal`. The decoders evaluate the Emscripten wrappers inside the worker, so a strict Content Security Policy needs `'unsafe-eval'` in `worker-src`/`script-src` for the worker.

Draco `attributeIds` selects unique attribute IDs; `componentTypes` specifies the glTF accessor type for each requested channel. Named positions, normals, UVs and colors return `Float32Array` values. Requested integer UVs retain their encoded values for the loader's accessor normalization, while colors are normalized once by the decoder. Extra channels retain their requested typed-array type. Triangle indices use `Uint16Array` below 65,536 vertices and `Uint32Array` at or above that boundary.

Draco `decode` accepts `limits: {maxVertices, maxIndices, maxDecodedBytes, attributeWidths}`.
Limits are validated before copying/transferring the input and are enforced again in
the worker. All requested attribute widths, the actual vertex/index counts and the
combined output size must pass before any output `_malloc`, attribute extraction,
or typed-array copy. Defaults cap vertices at 16,777,216 and combined output at
256 MiB; caller limits may lower these ceilings. `attributeWidths` maps requested
semantics to their expected component counts. Limits include final Float32 storage
for named channels. Draco's internal Wasm geometry decode still allocates before
its actual counts are available; these are output extraction limits, not a cap on
the decoder's internal Wasm heap.

## Corrupt and hostile files

Every decode ends in a result or a named error: a `TypeError` or `RangeError` whose message starts with `Draco:`,
`KTX2:` or `EXT_meshopt_compression:`, or a `MargoError` with code `'failed'` (launch gate 11a; `npm run fuzz`
exercises all three). The KTX2 header and level index are bounds-checked before the transcoder sees the file, and a
Draco buffer must start with a Draco header. A Wasm trap inside Draco or Basis (`unreachable`, `memory access out of
bounds`) becomes `MargoError('failed', 'Draco: corrupt or unsupported data stopped the decoder (...)')` with the trap
as its `cause`; the worker then drops that Wasm instance and the next file gets a fresh one. `timeout` bounds a decode that
corrupt data keeps busy. An aborted decode keeps its worker busy
until it ends or times out, so no new decode queues behind it unknowingly.

## Limits

KTX2 cube maps, texture arrays and HDR (UASTC HDR) files are rejected. Draco point clouds return no `indices`. `@margoengine/gltf-pro` automatically uses Draco and meshopt through `loadGLTF` and `parseGLTFAsync`; `parseGLTF` stays synchronous for uncompressed and meshopt assets. Its async loaders dispose their temporary Draco decoder after success, failure or cancellation. A supplied reusable `draco` hook remains owned by its caller. KTX2 remains a standalone decoder and is not wired into glTF texture loading. The basic `@margoengine/gltf` loader is unchanged.

## Tests

`npm test` in `packages/decoders` runs Node checks with mock and real Wasm: SSR safety, target negotiation, row pitch, mip upload, pool limits and recovery, transfer instead of copy, handle and heap release, the Khronos Box, Avocado and AnisotropyBarnLamp assets, meshopt vectors produced by the meshoptimizer 1.1.1 reference encoder and decoder, and round trips through the repository's own test encoder (`tests/support/meshopt-encode.js`, written from the extension specifications). It also covers a real normalized UV/color triangle and index promotion at 65,535, 65,536 and 65,537 vertices. The triangle was generated with pinned `draco3d@1.5.7`; `tests/generate-normalized-fixture.mjs` regenerates it from an external encoder installation without adding a runtime dependency. `npm run test:browser` adds module workers in Chromium, a 64-decode burst, a compressed upload with no validation errors, byte-identical RGBA8 GPU readback, and a production Vite consumer build that must emit the worker and decoders as assets.

The Draco and Basis Universal binaries are Apache-2.0. See `vendor/NOTICE.md`.

MIT licensed.
