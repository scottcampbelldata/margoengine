# @margoengine/decoders

Worker-pooled Draco geometry decoding, KTX2/Basis Universal texture transcoding and EXT_meshopt_compression decoding for Margo Engine.

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

## Meshopt

`decodeMeshoptBuffer(source, count, stride, mode, filter)` decodes one `EXT_meshopt_compression` bufferView (ATTRIBUTES, TRIANGLES or INDICES, with the OCTAHEDRAL, QUATERNION and EXPONENTIAL filters) and returns a `Uint8Array`. It is pure TypeScript, synchronous and needs no Wasm. Output matches the meshoptimizer reference decoder bit for bit. `MeshoptDecoder` exposes the same `decodeGltfBuffer` signature as the object three.js loaders expect. The extension only allows vertex codec version 0, so version 1 streams are rejected with a clear error.

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

`decode` and `transcode` also accept an `AbortSignal` as `signal`. The decoders evaluate the Emscripten wrappers inside the worker, so a strict Content Security Policy needs `'unsafe-eval'` in `worker-src`/`script-src` for the worker.

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

## Limits

KTX2 cube maps, texture arrays and HDR (UASTC HDR) files are rejected. Draco point clouds return no `indices`. `@margoengine/gltf-pro` automatically uses Draco and meshopt through `loadGLTF` and `parseGLTFAsync`; its synchronous parser also supports meshopt. These loaders accept an optional reusable `draco` hook. KTX2 remains a standalone decoder and is not wired into glTF texture loading. The basic `@margoengine/gltf` loader is unchanged.

## Tests

`npm test` in `packages/decoders` runs Node checks with mock and real Wasm: SSR safety, target negotiation, row pitch, mip upload, pool limits and recovery, transfer instead of copy, handle and heap release, the Khronos Box, Avocado and AnisotropyBarnLamp assets, and meshopt vectors produced by the meshoptimizer 1.1.1 reference encoder and decoder. `npm run test:browser` adds module workers in Chromium, a 64-decode burst, a compressed upload with no validation errors, byte-identical RGBA8 GPU readback, and a production Vite consumer build that must emit the worker and decoders as assets.

The Draco and Basis Universal binaries are Apache-2.0. See `vendor/NOTICE.md`.

MIT licensed.
