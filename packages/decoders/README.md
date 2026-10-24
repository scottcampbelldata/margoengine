# @margoengine/decoders

Worker-pooled Draco geometry decoding, KTX2/Basis Universal texture transcoding and EXT_meshopt_compression decoding, and synchronous PNG reading (`@margoengine/decoders/png`), for Margo Engine.

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
