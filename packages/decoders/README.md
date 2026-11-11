# @margoengine/decoders

Import `margoengine/decoders` from the `margoengine` package, or `@margoengine/decoders` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Worker-pooled Draco geometry decoding, KTX2/Basis Universal texture transcoding and EXT_meshopt_compression decoding, and synchronous PNG, TGA, PCX, TIFF, DDS and KTX 1 reading (`@margoengine/decoders/png`, `/tga`, `/tiff`, `/dds`, `/ktx`), for Margo Engine.

Build from source with `npm run build` in `packages/decoders`.

```ts
import {DracoDecoder, KTX2Decoder} from 'margoengine/decoders';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const bytes = new Uint8Array(await (await fetch('/mesh.drc')).arrayBuffer());

const draco = new DracoDecoder({workerLimit: 4});
const ktx2 = new KTX2Decoder({device: engine.gpu!, workerLimit: 4});

// A KHR_draco_mesh_compression bufferView, with the extension's attribute ids.
const geometry = await draco.decode(bytes, {attributeIds: {POSITION: 3, NORMAL: 1, TEXCOORD_0: 0}});
geometry.positions; // Float32Array
geometry.indices;   // Uint16Array or Uint32Array

// Transcodes to BC7, ASTC 4x4, ETC2 or RGBA8, whichever the device has enabled, then writes every mip level.
const texture = await ktx2.createTexture(await (await fetch('/albedo.ktx2')).arrayBuffer());

// On teardown:
draco.dispose(); ktx2.dispose();
```

Here `/mesh.drc` is the unmodified compressed bufferView of Khronos Avocado (Microsoft, CC0),
whose extension assigns POSITION=3, NORMAL=1 and TEXCOORD_0=0. IDs belong to the file;
read `KHR_draco_mesh_compression.attributes` for another asset. Run
`node packages/decoders/scripts/make-readme-streams.mjs` from a clone to extract the
two README streams into `packages/decoders/tests/fixtures/readme/`; serve `avocado.drc`
as `/mesh.drc` and the matching 2D KTX2 texture as `/albedo.ktx2`.

A standalone `.ktx2` goes on a material map through `@margoengine/materials`: `loadKTX2Texture(url, {decoder: ktx2})`,
or `new Texture(await ktx2.transcode(bytes))`, which uploads the transcoded mips on each device that draws it.

## Meshopt

`decodeMeshoptBuffer(source, count, stride, mode, filter)` decodes one `EXT_meshopt_compression` or `KHR_meshopt_compression` bufferView (ATTRIBUTES, TRIANGLES or INDICES, with the OCTAHEDRAL, QUATERNION, EXPONENTIAL and COLOR filters) and returns a `Uint8Array`. It is pure TypeScript, written from the two extension specifications, synchronous and needs no Wasm. Output matches the meshoptimizer reference decoder bit for bit, with one deliberate difference: a TRIANGLES or INDICES stream decoded into a 16-bit index buffer (byteStride 2) that holds an index past 65,535 fails as damaged, where the reference keeps the low 16 bits and so joins the wrong vertices. Attribute streams of vertex codec version 0 (the only one `EXT_meshopt_compression` defines) and version 1 (added by `KHR_meshopt_compression`) are both decoded, whichever extension names the bufferView; any other version is rejected with a clear error. `MeshoptDecoder` has the members of the meshoptimizer project's own decoder object (`supported`, `ready`, `decodeGltfBuffer`), so glTF loaders written against that interface work unchanged.

## Meshopt on Wasm SIMD (`@margoengine/decoders/meshopt-simd`)

`meshoptDecodeGltfBufferSIMD` takes the arguments of `meshoptDecodeGltfBuffer` and gives the same bytes and the same errors, on a
25 KB Wasm module built from `native/meshopt-simd` in this package. It is embedded in the entry, so importing it costs nothing
elsewhere and nobody who installs the package needs Rust. Until `ready` resolves, on a runtime without Wasm SIMD, and on any
stream the module will not read, the TypeScript decoder runs instead.

```ts
import {MeshoptSIMDDecoder, meshoptDecodeGltfBufferSIMD} from 'margoengine/decoders/meshopt-simd';
const bytes = new Uint8Array(await (await fetch('/meshopt.bin')).arrayBuffer());

await MeshoptSIMDDecoder.ready;
const positions = meshoptDecodeGltfBufferSIMD(bytes, 24, 12, 'ATTRIBUTES');
```

This stream is `MeshoptCubeTest` bufferView 25 (Arseny Kapoulkine, CC0): 97 compressed
bytes, 24 positions of 12 bytes each, mode ATTRIBUTES and filter NONE. Serve the extracted
`cube-positions.bin` as `/meshopt.bin`. For another view use its extension's `count`,
`byteStride`, `mode` and `filter`; a whole glTF buffer can contain several streams.

`MeshoptSIMDDecoder` has the members of `MeshoptDecoder` (`supported`, `ready`, `decodeGltfBuffer`), so a loader written against
that interface can take either. After changing the Rust source run `node scripts/meshopt-simd-build.mjs`; a test fails while the
embedded module and the source differ. To time both decoders on a file: `node scripts/meshopt-simd-bench.mjs <file.glb>`.

## JPEG XL (`@margoengine/decoders/jxl`)

`JXLDecoder` decodes `.jxl` files to RGBA8: straight alpha, sRGB, top row first. A browser that reads JPEG XL does the work; anywhere
else a module worker loads a Wasm build of jxl-oxide on the first decode, so importing the entry downloads no Wasm until a file
needs it. `jxlTextureFile` turns the result into a `TextureFile`.

```ts
import {JXLDecoder, jxlTextureFile, uploadTexture} from 'margoengine/decoders/jxl';
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const file = await (await fetch('/texture.jxl')).arrayBuffer();

using decoder = new JXLDecoder();
const image = await decoder.decode(file);
const texture = uploadTexture(device, jxlTextureFile(image));
```

`readJXLHeader(bytes)` reads the size, bit depth, alpha, orientation and colour encoding without decoding. `decode` takes `signal`,
`maxPixels` (default 2^26) and `transfer`; `new JXLDecoder({browser: false})` always uses the Wasm, and `decoderPath` names another
folder for `jxl_oxide_wasm_bg.wasm`. `image.decoder` says which ran. Bit depths above 8 come out as 8, an animation gives its first
frame, and CMYK files are refused. The Wasm path gives sRGB whatever the file is stored in: it converts through a matrix and curve or
grey ICC profile, and only an RGB profile built on lookup tables alone comes out as stored (`docs/limits.md`).

## PVR (`@margoengine/decoders/pvr`)

`parsePVR(bytes)` reads PVR files of PVRTC 1 data, 2 or 4 bits a texel, version 3 or the older 52 byte header, and decodes every level,
surface and cube face to RGBA8 on the CPU, because WebGPU has no PVRTC format. Old iOS asset packs keep working this way. It costs 4
bytes a texel on the GPU and a pass on the calling thread, so ship KTX2 for anything new.

```ts
import {parsePVR, uploadTexture} from 'margoengine/decoders/pvr';
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const bytes = new Uint8Array(await (await fetch('/texture.pvr')).arrayBuffer());

const texture = uploadTexture(device, parsePVR(bytes));
```

The result is a `TextureFile` with `target: 'pvr'`, sRGB when the file says so. `decodePVRTC(data, width, height, twoBit)` decodes one
level of bare PVRTC data. PVRTC 2, 3D textures, big-endian files and sizes that are not powers of two are refused.

## Draco point clouds (`@margoengine/decoders/draco-points`)

`DracoPointsDecoder` returns a whole Draco point cloud: `pointCount`, `indices` (one per point, 32-bit from 65,536 points) and every
attribute in the type the file stores, generic ones included. The glTF Draco build behind `DracoDecoder` has no point cloud decoder, so
this entry brings Google's full build, in its own worker pool; nothing loads it until a cloud is decoded.

```ts
import {DracoPointsDecoder} from 'margoengine/decoders/draco-points';
const file = await (await fetch('/points.drc')).arrayBuffer();

using decoder = new DracoPointsDecoder();
const {pointCount, indices, attributes} = await decoder.decode(file);
const intensity = attributes.find((attribute) => attribute.name === 'intensity');
```

Each attribute has `name` (the file's `name` metadata, or `POSITION`, `NORMAL`, `COLOR_0`, `TEXCOORD_0`, `GENERIC_0` counting up), `semantic`,
`uniqueId`, `array`, `itemSize` and `normalized`. `decode` takes `signal`, `transfer` and `limits` (`maxVertices`, `maxDecodedBytes`), which are
checked before any output is allocated; `decoderPath` names another folder for the two decoder files.

## WebP (`@margoengine/decoders/webp`)

`parseWebP(bytes)` reads lossy (VP8), lossless (VP8L) and extended WebP files to RGBA8 in plain TypeScript, with no image API, so it runs in Node and in a worker. Written from RFC 6386 and RFC 9649. `alpha` chunks of every coding and filter are read. An animated file gives its first frame. Colour profiles are ignored. `decodeWebpLossless` from `/webp-lossless` is the VP8L part alone.

```ts
import {parseWebP} from 'margoengine/decoders/webp';

// The smallest lossless file: one transparent pixel.
const file = Uint8Array.from(atob('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='), (c) => c.charCodeAt(0));
const {width, height, data, lossless} = parseWebP(file);
console.log(width, height, data.length, lossless); // 1 1 4 true
```

Checked against dwebp 1.4.0, run as an outside tool, on 139 real files: the Y, U and V planes byte for byte on every lossy file and RGBA exact on every lossless file. After upsampling, RGB is at most 1 of 255 from dwebp's. `packages/decoders/scripts/test-real-textures.mjs <folder>` repeats it.

## Any image to pixels (`@margoengine/decoders/image`, `/bc`)

`decodeImage(bytes, {signal, maxPixels})` turns a PNG, WebP, DDS, KTX or KTX2 file into RGBA8 rows, whichever it is: the file's signature picks the reader, and each reader loads only when a file needs it. `maxPixels` (default 2^26, 8192 squared) bounds PNG, WebP, JPEG and AVIF before their pixels are allocated: a larger image throws `RangeError`. `imageFormat(bytes)` names the format. `textureFileToRGBA(file)` does it for a parsed `TextureFile`. `decodeBC(format, blocks, width, height)` from `/bc` decodes BC1 to BC7 on the CPU. Basis Universal KTX2 goes through a worker in a browser and through the shipped Wasm in the calling thread in Node.

```ts
import {decodeImage, imageFormat} from 'margoengine/decoders/image';

const file = Uint8Array.from(atob('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='), (c) => c.charCodeAt(0));
console.log(imageFormat(file)); // webp
const {width, height, data} = await decodeImage(file);
console.log(width, height, data.length); // 1 1 4
```

A JPEG and AVIF are refused with code `unsupported`, as are native ETC, EAC and ASTC blocks. Signed formats map -1..1 to 0..255, as a normal map held in an unsigned image does. Float formats clamp to 0..1 and come out sRGB encoded.

In Node, which has no Web Worker for `KTX2Decoder`, pass `nodeKTX2` as the `ktx2` option of `loadGLTF` to load a Basis Universal model. Install the `webgpu` binding (`npm install webgpu`, tested with 0.6.2) and `@margoengine/headless` alongside Margo. It transcodes to RGBA8, four times the bytes of a GPU format, so a large model needs a larger `maxDownloadBytes`, which sets the decoded budget too. This example loads the complete CC0 FlightHelmet by Gary Hsu and Microsoft from a pinned Khronos sample revision:

```ts
import {Engine} from 'margoengine/core';
import {nodeKTX2} from 'margoengine/decoders/image';
import {loadGLTF} from 'margoengine/gltf-pro';
import {createHeadlessCanvas, installGPU} from 'margoengine/headless';
import {create} from 'webgpu';

const gpu = create([]);
using installed = installGPU({gpu});
using engine = await Engine.create(createHeadlessCanvas({width: 256, height: 256}), {backend: 'webgpu'});
using model = await loadGLTF(engine,
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/8f492390/Models/FlightHelmet/glTF-KTX-BasisU/FlightHelmet.gltf',
  {ktx2: nodeKTX2, maxDownloadBytes: 2 ** 29, signal: AbortSignal.timeout(20_000)});
console.log(model.primitives.length); // 6
```

After building a clone and fetching its pinned inputs with `node scripts/reference-rendering/fetch-skip-assets.mjs`, run `node scripts/gpu-lock.mjs run --owner=readme-node -- node packages/decoders/scripts/test-node-gltf.mjs`. It executes this Node setup and glTF load, checks every decoded mip and the complete geometry counts, and reads back the rendered model without GPU validation errors. This is integration evidence for that asset; it does not compare decoded pixels against an independent Basis decoder or establish rendering quality or speed.

## Texture upload (`@margoengine/decoders/texture`)

`getSupportedTranscodeFormat`, `getBytesPerRow` and `createKTX2Texture` (also on the root) without the transcoder or the
Draco and meshopt modules, for code that uploads textures a `KTX2Decoder` already transcoded. gltf-pro imports these
from here and loads the root only when a file needs decoding.

## Brotli (`@margoengine/decoders/brotli`)

`decodeBrotli(bytes)` decodes one Brotli stream on the calling thread, written from RFC 7932. Browsers undo Brotli on HTTP
responses but give a page no way to run it on bytes it holds, and some formats store Brotli inside a file: Potree 2.0
keeps each node as its own stream, and `@margoengine/points/potree` reads those with this entry.

```ts
import { decodeBrotli } from '@margoengine/decoders/brotli';

const bytes = decodeBrotli(new Uint8Array(await (await fetch('/node.br')).arrayBuffer()), { maxBytes: 1 << 26 });
```

| Option | Default | What it does |
| --- | --- | --- |
| `maxBytes` | 2^30 (1 GiB) | Largest output; a stream that would pass it throws, so a small file cannot fill memory. |
| `stopAt` | none (decode to the end) | Return exactly the first `stopAt` bytes and decode nothing past them. |

A stream that breaks the format, ends early or passes `maxBytes` throws a `MargoError` with code `failed`. The RFC's 122,784-byte
dictionary ships in this entry (about 60 KB compressed in the bundle) and unpacks the first time a stream refers to it. The
tests read every quality, window size and mode of the reference encoder (`node:zlib`).

## bzip2 and xz (`@margoengine/decoders/bzip2`, `/xz`)

`decodeBzip2(bytes)` reads `.bz2` data, `decodeXz(bytes)` reads `.xz` data and `decodeLzma(bytes)` the older `.lzma` form, on the
calling thread. Browsers have no way to undo either. `@margoengine/loaders/nrrd` reads `encoding: bzip2` volumes with the
first, and `@margoengine/loaders/vtk-xml` reads `vtkLZMADataCompressor` blocks with the second.

```ts
import { decodeBzip2 } from '@margoengine/decoders/bzip2';
import { decodeXz } from '@margoengine/decoders/xz';

const bz2 = new Uint8Array(await (await fetch('/floats.1.bz2')).arrayBuffer()),
  xz = new Uint8Array(await (await fetch('/floats.crc64.xz')).arrayBuffer());
const fromBzip2 = decodeBzip2(bz2, { maxBytes: 1 << 28 });
const fromXz = decodeXz(xz);
console.log(fromBzip2.length, fromXz.length);
```

| Option | Default | What it does |
| --- | --- | --- |
| `maxBytes` | 2^30 (1 GiB) | Largest output; a stream that would pass it throws, so a small file cannot fill memory. |

Concatenated streams read as one. Every bzip2 block and stream CRC is checked. `decodeBzip2(bytes, { stopAt })` returns
exactly the first `stopAt` bytes and decodes nothing past them, for containers such as NRRD whose header gives the size and
whose data may run on; the CRC of the block holding the last of those bytes is then not checked. In `.xz`, the CRC32s of the headers, index and
footer are checked, and each block's own CRC32, CRC64 or SHA-256. `.lzma` has no
check, so damage shows only as a broken stream. Only the LZMA2 filter is read: BCJ and delta filters throw `unsupported`, and so
do bzip2's randomised blocks, which nothing has written since 1999. A stream that breaks the format, ends early or passes
`maxBytes` throws a `MargoError` with code `failed`. The tests read files from the outside libbzip2 and liblzma.

## PNG (`@margoengine/decoders/png`)

`decodePNG(bytes, {maxPixels?, bitDepth?})` reads any valid PNG (W3C PNG Specification, Third Edition) to
`{width, height, data}`: RGBA8 rows, top first, or `bitDepth: 16` for a `Uint16Array` of 0-65535 that loses nothing. Every colour type and bit depth (16-bit keeps the high byte, sub-byte
grey scales to 0-255), all five filters, Adam7, palette and `tRNS` alpha. Chunk CRCs, chunk order and the exact
decompressed size are checked; a broken file throws `MargoError` `failed`, an image over `maxPixels` (default 2^26,
an 8192 x 8192 image) a RangeError. Ancillary chunks are skipped, so samples come out as stored, without gamma or ICC
colour management. It is synchronous and runs on the calling thread (no worker), with the engine's shared zlib
inflater (the one EXR uses); it does not load the Draco or Basis decoders.

```ts
import {decodePNG} from 'margoengine/decoders/png';
const pngBytes = new Uint8Array(await (await fetch('/image.png')).arrayBuffer());

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
  KTX `COMPRESSED_RGB_S3TC_DXT1` (and its sRGB form) has no alpha, so `hasAlpha` is false: WebGPU samples a
  three-colour block's black texel with alpha 0, which an opaque material must ignore.
- `uploadTexture(device, file, {label?, usage?})` (on both `/dds` and `/ktx`) creates the GPUTexture and writes every
  level and layer. On a device without the feature (`texture-compression-bc`, `-etc2` or `-astc`) it throws
  `MargoError` `unsupported` naming the feature to request in `requestDevice`.

Broken files throw `MargoError` `failed` naming the problem; a non-`Uint8Array` input is a TypeError and an image over
`maxPixels` a RangeError.

```ts
import {parseTGA} from 'margoengine/decoders/tga';
import {parseTIFF} from 'margoengine/decoders/tiff';
import {parseDDS, uploadTexture} from 'margoengine/decoders/dds';
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const tgaBytes = new Uint8Array(await (await fetch('/image.tga')).arrayBuffer());
const tiffBytes = new Uint8Array(await (await fetch('/image.tiff')).arrayBuffer());
const ddsBytes = new Uint8Array(await (await fetch('/texture.dds')).arrayBuffer());

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

## PCX (`@margoengine/decoders/pcx`)

`parsePCX(bytes, {maxPixels?})` returns `{width, height, data}`, RGBA8 rows top first, like `parseTGA`. It is written from
the ZSoft PCX technical reference: run-length encoded or plain scanlines of 8-bit images with 1, 3 or 4 planes (a palette
after the image, RGB, RGBA) and of 16-colour and 2-colour images, with the header palette or, in version 3 files, the
standard EGA colours. An 8-bit image with no palette reads as grey. Quake II skins are the 8-bit palette kind. Other
layouts, and a header whose line size is too short for its width, throw `MargoError` `failed`.

```ts
import {parsePCX} from 'margoengine/decoders/pcx';

const skinBytes = new Uint8Array(await (await fetch('/skin.pcx')).arrayBuffer());
const skin = parsePCX(skinBytes); // {width, height, data: RGBA8}
console.log(skin.width, skin.height);
```

`tests/pcx.test.js` builds every layout and checks pixels exactly. `npm run test:real-files -w @margoengine/loaders` reads
three real files and compares every pixel with Pillow 13.0.0.

## KTX2 cube maps and arrays (`@margoengine/decoders/ktx2-layers`)

`KTX2LayerDecoder` reads every level, face and layer of a KTX2 file, so skyboxes, reflection probes and terrain layer
stacks can ship compressed. Basis Universal files (ETC1S and UASTC, with or without Zstandard) transcode in the decoder
workers to BC7, ASTC 4x4, ETC2 or RGBA8, as `KTX2Decoder` does. Files that store a GPU format (`vkFormat` set: BC, ETC2,
ASTC, float and the rest of the table in `parseKTX2`) need no Wasm: `parseKTX2(bytes)` reads them, undoing zlib or
Zstandard, and adds an opaque alpha to 8-, 16- and 32-bit RGB files, because WebGPU has no three-channel formats.
`decode` picks the route.

```ts
import {KTX2LayerDecoder} from 'margoengine/decoders/ktx2-layers';
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const skyBytes = new Uint8Array(await (await fetch('/sky.ktx2')).arrayBuffer());
const terrainBytes = new Uint8Array(await (await fetch('/terrain.ktx2')).arrayBuffer());

const decoder = new KTX2LayerDecoder({device});

const sky = await decoder.createTexture(skyBytes); // a cube file: six layers, every mip, BC7 on a desktop GPU
const skyView = sky.createView({dimension: 'cube'});

const file = await decoder.decode(terrainBytes); // a TextureFile, before any upload
file.dimension; // '2d-array'
file.layers; // layers, counting each cube face
file.transcoded; // 'bc7', or 'native' when the file stored a GPU format

decoder.dispose();
```

The result is the `TextureFile` the DDS and KTX readers return, with `target: 'ktx2'`; each level holds its images back to
back in WebGPU layer order, so `uploadTexture` writes one level in one call. `loadKTX2Texture(url, {decoder})` in `@margoengine/materials`
takes this decoder and gives a CubeTexture or an array Texture that survives a lost device. A six-layer GPUTexture goes
straight on `Material.envMap` too, and `new Texture(gpuTexture, {dimension: 'cube'})` or `'2d-array'`
binds it on a map. 3D textures are refused. `KTX2Decoder` stays 2D and points here if it is given layers.
`tests/ktx2-layers.test.js` checks every image of eight real files against `ktx extract`; `scripts/ktx2-oracle.mjs`
rewrites those records.

## HDR KTX2 (`@margoengine/decoders/ktx2-hdr`)

`KTX2HDRDecoder` reads UASTC HDR 4x4 files, 2D, array or cube, so HDR environments ship at a fraction of EXR size: two
real EXR files came to 20.6 and 29.2 percent of theirs, mips included (`memorial.exr` 2,371,897 B, `Desk.exr` 2,424,523 B).
It uses the same Basis worker and Wasm as the 8-bit files, and transcodes to BC6H where the device has
`texture-compression-bc`, otherwise to half float. Pass `target` for `'rgba16float'`, `'rgb9e5'`, or `'astc-hdr-4x4'`,
which gives ASTC HDR blocks for tools: WebGPU has no ASTC HDR format, so `createTexture` refuses that target. BC6H falls
back to half float when level 0 is not a multiple of 4. UASTC HDR holds no alpha, so `hasAlpha` is false and half-float
alpha is 1.

```ts
import {Environment} from 'margoengine/environment';
import {KTX2HDRDecoder, toEnvironmentImage} from 'margoengine/decoders/ktx2-hdr';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const bytes = new Uint8Array(await (await fetch('/environment.ktx2')).arrayBuffer());

// As a texture: BC6H on a desktop GPU.
const decoder = new KTX2HDRDecoder({device: engine.gpu!});
const texture = await decoder.createTexture(bytes);

// As image-based lighting: an equirect or a cube, as floats.
const floats = new KTX2HDRDecoder({target: 'rgba16float'});
const environment = await Environment.create(engine, toEnvironmentImage(await floats.decode(bytes)));
```

Files come from the `basisu` tool or encoder (`-hdr`). The bundled transcoder is Basis Universal 1.50, so it reads UASTC
HDR 4x4 and refuses the later 6x6 HDR formats with `MargoError` `failed`. `tests/ktx2-hdr.test.js` checks real files
against pixels of the EXR files they were made from.

## Streaming KTX2 mips (`@margoengine/decoders/ktx2-stream`)

KTX 2.0 stores the smallest level first, so `KTX2Streamer` reads the head of a file with a Range request and has a picture
on the GPU after a small part of the file: `cubemap_yokohama_basis_rd.ktx2` 65,618 of 2,621,370 B, `cubemap_goldengate_uastc_rdo4_zstd5_rd.ktx2` 65,819 of 4,043,747 B on real files. Finer levels load as `want` asks for them, largest on
screen first, inside `budgetBytes` (default 256 MiB), and levels nothing needs are dropped to make room. A server that
ignores Range sends the whole file once, which still works. 8-bit and HDR files both stream; each level goes through the same
worker transcode as a whole file, so its bytes are that level's bytes in the whole file.

```ts
import {KTX2Streamer} from 'margoengine/decoders/ktx2-stream';
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const useTexture = (texture: GPUTexture) => console.log('sharpest level now', texture.width, 'wide');
const pixelsOnScreen = 512;

const streamer = new KTX2Streamer({device, budgetBytes: 128 * 1024 * 1024});
const rock = await streamer.open('/rock.ktx2');
useTexture(rock.texture);
rock.onChange = useTexture;

// Each frame:
rock.want(pixelsOnScreen);
streamer.update();
```

WebGPU textures cannot grow, so a texture is replaced each time a level arrives or leaves: existing levels move by
`copyTextureToTexture`, the old texture is destroyed, and `onChange` (or `for await` over `updates()`) hands over the new
one. Keep the texture only until then. A level that fails to load leaves the stream as it was, calls `onError` once, and
sets `error`; clear it to try again. Block formats start at the coarsest level whose size is a whole number of blocks, since
WebGPU wants that of level 0; `bytes()` and `usedBytes` report what the streams hold, and `dispose` frees it all. Lower
`budgetBytes` under memory pressure and the next `update` drops levels to fit.

`open` takes `offset` and `length` for a KTX2 file inside a larger file, such as an image in a GLB's binary chunk, and `colorViews` for a loader that picks sRGB or linear by how a texture is used: every texture it makes then allows views in the format's twin (`colorTwin(format)`).

## Basis on the GPU (`@margoengine/decoders/ktx2-gpu`)

`KTX2GPUDecoder` transcodes Basis Universal KTX2 files with compute shaders, so a page that only needs textures skips the Wasm
transcoder and its worker: 13,579 B gzip of JavaScript and WGSL against 260,468 B gzip (527,333 B of Wasm and 57,529 B of
JavaScript raw). Zstandard files add 7,774 B on first use. UASTC blocks decode on the GPU; ETC1S streams are Huffman coded, so
the CPU reads them to codebook indices and the GPU expands those.

```ts
import {KTX2GPUDecoder} from 'margoengine/decoders/ktx2-gpu';
const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
const file = await (await fetch('/texture.ktx2')).arrayBuffer();

const decoder = new KTX2GPUDecoder({device});
const texture = await decoder.createTexture(file);
```

2D, array and cube files work, every level, sRGB when the file says so. The output is RGBA8, byte for byte what the Wasm `rgba8`
target gives, which costs 4 bytes a texel on the GPU where BC7 costs 1. Use `KTX2Decoder` or `KTX2LayerDecoder` where GPU memory
matters more than the download. Texture video, HDR files and files that store a GPU format are refused; a device with a small
`maxStorageBufferBindingSize` gets the level in bands.

## How it works

- **Workers, not the main thread.** Each decoder owns a lazily grown pool of classic workers, by default `Math.min(navigator.hardwareConcurrency || 4, 4)`. Jobs go to an idle worker, then a new one while under the limit, then the least loaded. A crashed worker rejects only its own jobs and is replaced on the next call.
- **Zero-copy results.** Every decoded array owns its own buffer and returns through `postMessage` transfer lists. KTX2 mip levels are views into one transferred buffer and go straight to `device.queue.writeTexture`. Inputs are copied by default so the caller keeps its buffer; pass `{transfer: true}` to move a whole `ArrayBuffer` instead.
- **Memory release.** The worker destroys every Draco decoder, buffer and mesh handle and frees every heap allocation after each decode, including on errors. KTX2 files are closed and deleted the same way.
- **Hardware format negotiation.** `getSupportedTranscodeFormat(device)` checks `texture-compression-bc`, then `-astc`, then `-etc2`, and falls back to `rgba8`. A device only reports these features when they were requested in `requestDevice`, so an engine that requests none always gets RGBA8. Compressed targets fall back to RGBA8 when level 0 is not a multiple of 4 pixels. sRGB files get the `-srgb` format variant.
- **Bundler and SSR safety.** Workers run the prebuilt classic script `decoder.worker.js`, found by `new URL('./decoder.worker.js?no-inline', import.meta.url)`, and the Wasm decoders are referenced the same way. Vite, webpack 5 and Next.js therefore emit them as assets. Nothing touches `window`, `Worker` or `navigator` at import time, so construction is safe during SSR. Decoding on the server rejects with a clear error.

## Options

| Option | Decoder | Default |
| --- | --- | --- |
| `decoderPath` | Draco | Bundled copy. Point at a CDN folder holding `draco_wasm_wrapper.js` and `draco_decoder.wasm`, e.g. `https://www.gstatic.com/draco/versioned/decoders/1.5.7/` |
| `transcoderPath` | KTX2 | Bundled copy. Folder holding `basis_transcoder.js` and `basis_transcoder.wasm` |
| `workerLimit` | both | Hardware threads, capped at 4 (allowed range 1 to 16) |
| `device` | KTX2 | None. Picks the target and is required by `createTexture` |
| `target` | KTX2 | Negotiated from `device`. Set `'rgba8'` for CPU access to texels |
| `timeout` | both | 10 s plus 4 s per MiB of input. Most milliseconds one decode may run; past it the worker is restarted and the decode rejects (`Draco decode timed out after ... ms`). `Infinity` disables it |

`decode` and `transcode` also accept an `AbortSignal` as `signal`. The classic worker loads the Emscripten wrappers with `importScripts`. Wasm compilation needs `'wasm-unsafe-eval'` in `script-src` on worker responses; JavaScript `'unsafe-eval'` is unnecessary. See [Content Security Policy](../../docs/csp.md).

Draco `attributeIds` selects unique attribute IDs; `componentTypes` specifies the glTF accessor type for each requested channel. Named positions, normals, UVs and colors return `Float32Array` values. Requested integer UVs retain their encoded values for the loader's accessor normalization, while colors are normalized once by the decoder. Extra channels retain their requested typed-array type. Triangle indices use `Uint16Array` below 65,536 vertices and `Uint32Array` at or above that boundary.

Draco `decode` accepts `limits: {maxVertices, maxIndices, maxDecodedBytes, attributeWidths}`.
Limits are validated before copying/transferring the input and are enforced again in
the worker. All requested attribute widths, the actual vertex/index counts and the
combined output size must pass before any output `_malloc`, attribute extraction,
or typed-array copy. Defaults cap vertices at 16,777,216 and combined output at
384 MiB (402,653,184 B); caller limits may lower these ceilings. 384 MiB is the most
whose measured peak Wasm memory (up to 4.5 bytes per output byte) fits 90% of the
prebuilt module's 2 GiB; a 10M-triangle scan with normals and UVs decodes to about
280 MB in 1.7 s (`node scripts/draco-scale.mjs`). `attributeWidths` maps requested
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

`KTX2Decoder` reads one 2D texture; cube maps and arrays go through `@margoengine/decoders/ktx2-layers`. HDR files go through `@margoengine/decoders/ktx2-hdr`. `DracoDecoder` reads meshes; a point cloud goes through `@margoengine/decoders/draco-points`. `@margoengine/gltf-pro` automatically uses Draco and meshopt through `loadGLTF` and `parseGLTFAsync`; `parseGLTF` stays synchronous for uncompressed and meshopt assets. Its async loaders dispose their temporary Draco decoder after success, failure or cancellation. A supplied reusable `draco` hook remains owned by its caller. The pro async loaders also load KTX2/Basis textures; supply `nodeKTX2` in Node as above. The basic `@margoengine/gltf` loader is unchanged.

## Tests

The real meshopt bufferView checks require their Khronos buffers. Missing data or a Git LFS pointer
fails with the exact file path; run `git lfs pull` from the repository root to fetch the buffers.

`npm test` in `packages/decoders` runs Node checks with mock and real Wasm: SSR safety, target negotiation, row pitch, mip upload, pool limits and recovery, transfer instead of copy, handle and heap release, the Khronos Box, Avocado and AnisotropyBarnLamp assets, meshopt vectors produced by the meshoptimizer 1.1.1 reference encoder and decoder, and round trips through the repository's own test encoder (`tests/support/meshopt-encode.js`, written from the extension specifications). It also covers a real normalized UV/color triangle and index promotion at 65,535, 65,536 and 65,537 vertices. The triangle was generated with pinned `draco3d@1.5.7`; `tests/generate-normalized-fixture.mjs` regenerates it from an external encoder installation without adding a runtime dependency. `npm run test:browser` adds module workers in Chromium, a 64-decode burst, a compressed upload with no validation errors, byte-identical RGBA8 GPU readback, and a production Vite consumer build that must emit the worker and decoders as assets.

The Draco and Basis Universal binaries are Apache-2.0. See `vendor/NOTICE.md`.

## Optional clean-room Draco (`@margoengine/decoders/draco-native`)

This entry exports `DracoDecoder` and `DracoPointsDecoder` with the existing decode
contracts, pooling, AbortSignal, transfer, timeout and disposal. It lazily loads
one clean-room Rust Wasm per worker through `new URL(..., import.meta.url)`.
The default entries and loaders continue to use the bundled prebuilts.

```ts
import {DracoDecoder} from '@margoengine/decoders/draco-native';
using decoder = new DracoDecoder({workerLimit: 2});
const geometry = await decoder.decode(await (await fetch('/mesh.drc')).arrayBuffer(), {
  attributeIds: {POSITION: 3, NORMAL: 1, TEXCOORD_0: 0},
});
geometry.positions;
```

Use the same Avocado `/mesh.drc` described above. `decoderPath`, when set, is a
folder containing `draco-native.wasm`; unset uses the bundled asset. Other
constructor defaults are four workers capped by hardware threads and the existing
10 s plus 4 s/MiB timeout. Output limits are the same 384 MiB; the native
workspace (output and scratch together) has a 1.5 GiB ceiling and the input 256 MiB. Source builds require
Cargo and the `wasm32-unknown-unknown` target; installed tarballs contain the asset.

Warm performance parity remains open: the prior 1,937-input campaign has 365
full-flavor and 288 glTF-flavor total-output losses. Historical (version 1.0 to 1.2)
texture-coordinate predictor 3 decodes and matches the full prebuilt. Cold/RSS and
the rest of the historical feature inventory remain incomplete; neither prebuilt is replaced. See
[the evidence and limits](../../docs/limits.md#batch-133-optional-decoder-landing)
and [native regression instructions](native/draco/README.md). `npm test` retains
all native/Wasm cases, including 2,160 predictive cases and hostile input tests.

Apache-2.0 licensed.

## Content Security Policy

Wasm initialization needs `'wasm-unsafe-eval'` in `script-src` on restricted pages and worker responses. Blocked compilation rejects with MargoError code `failed` and a help link. See [the exact header and package requirements](../../docs/csp.md).

The optional decoder matches short metadata name conversion and exact raw name
keys on1,445 crafted bounded-read cases. Malformed trailing groups remain an
open equivalence gate:22 of1,613 observations differ where the opaque binding
consumes storage beyond the value and terminal NUL. Missing bytes are treated
as zero, with no read outside the owned value. See
[the retained cases](../../docs/whitepaper/results/batch-133-metadata-strings.json).
