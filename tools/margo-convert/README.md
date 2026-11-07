# margo-convert

The asset pipeline for [Margo Engine](https://margoengine.com): one command that imports, optimises, compresses and
packages models, textures and audio for the web and for each export target.

```sh
npx margo-convert build ./assets --out dist                  # web preset (default)
npx margo-convert build ./assets --out dist --preset mobile
npx margo-convert optimize helmet.glb                       # one model -> helmet.optimized.glb
```

## Build and optimize

`build` takes a folder (or one file) and writes optimised copies, a manifest and a size report to `--out` (default
`dist`). `optimize` does the same for one model. Both take `--preset`:

| Preset | Models | Textures | Audio |
| --- | --- | --- | --- |
| `web` (default) | quantised, meshopt-compressed GLB; static meshes merged; empty nodes removed | up to 2048 px, WebP (lossless for normal and data maps) | WAV and FLAC to Ogg Vorbis if ffmpeg is installed |
| `mobile` | as `web` | up to 1024 px at power-of-two sizes, WebP quality 72 | as `web`, mono, at most 22.05 kHz |
| `unity` | plain GLB, hierarchy and empty nodes kept, no required extensions | PNG/JPEG up to 4096 px, multiples of 4 | kept |
| `unreal` | as `unity` | PNG/JPEG at power-of-two sizes up to 4096 px | kept |
| `godot` | as `unity` | PNG/JPEG up to 4096 px | kept |
| `roblox` | as `unity` | PNG/JPEG up to 1024 px | Ogg Vorbis if ffmpeg is installed, otherwise WAV is reported (Roblox takes mp3 and ogg) |

See [docs/guides/asset-pipeline.md](../../docs/guides/asset-pipeline.md) for examples of each.

What happens to a model (`.glb` or `.gltf` with its external files):

- **Prune.** Texture coordinate sets no material reads, tangents without a normal map, then unused nodes, meshes,
  materials, textures, samplers, images, skins and cameras. Nodes that carry nothing are removed only for the web
  presets (game engines use empty nodes as attachment points).
- **Dedupe.** Identical images (by content), samplers, textures, materials and meshes are merged.
- **Weld.** Identical vertices are merged (every attribute and morph target equal), unreferenced vertices and
  triangles with no area are dropped, vertices are numbered in order of first use.
- **Merge** (web presets). Static, unskinned meshes that share a material and attribute layout become one primitive,
  baked into world space. Safe means: no animation on the node or an ancestor, no morph targets, no node extensions,
  and the mesh used by one node only (shared meshes stay instanced).
- **Reorder** (every preset). Triangles in the order the GPU's vertex cache and early depth test read fastest, then
  vertices in order of first use, from `@margoengine/geometry/optimize`. A `BLEND` primitive keeps its triangle order, which
  decides how it layers. The pass counts as `reorderedPrimitives`; `reorder: false` in a preset's `model` turns it off.
- **Quantise** (web presets, KHR_mesh_quantization). Positions to 16-bit with the mesh bounds folded into the node
  transform (one scale on all axes, so normals stay correct; a node with children or animation gets a child node for
  the mesh), normals and tangents to 8 bits, texture coordinates in 0..1 to 16 bits, colours and skin weights to 8
  bits. Meshes with morph targets are left alone; skinned meshes keep float positions.
- **Compress** (web presets, EXT_meshopt_compression). Vertex attributes and triangle indices are written with the
  meshopt codecs by an encoder written for Margo from the extension specification (`@margoengine/exporters/meshopt`);
  Margo's decoder (`@margoengine/decoders/meshopt`) reads them, and so do other glTF loaders that support the
  extension. The output lists the extension as required.
- A model is never written larger than it came in, and a model that uses an extension the optimiser does not rewrite
  (Draco, `KHR_animation_pointer`, EXT_structural_metadata and similar) is copied unchanged with the reason in the
  manifest.

### Textures

Images inside models and standalone `.png` / `.jpg` files are scaled down to the preset's limit (never enlarged),
rounded down to a power of two or a multiple of 4 where the preset asks, and re-encoded:

- **Colour maps** (base colour, emissive, sheen and specular colour) are lossy WebP at the preset's quality. **Normal
  maps and every other data map** (metal/roughness, occlusion, clearcoat and so on) are lossless. Inside a model the
  role comes from the material slot that uses the image; a standalone file's from its name (`_normal`, `_n`, `rough`,
  `metal`, `orm`, `ao`, `mask`, and similar are data).
- WebP images are referenced through `EXT_texture_webp` (listed as required: there is no PNG copy). An image whose
  WebP is not smaller keeps its PNG. The game presets keep PNG and JPEG and write no texture extension; a JPEG is
  re-encoded only when it has to be resized.
- An image is never written larger than it came in unless it had to be made smaller in pixels.
- **Encoders.** Node has no WebP, AVIF or JPEG encoder. If [sharp](https://sharp.pixelplumbing.com) is already
  installed in the project, margo-convert uses it for resizing (Lanczos) and for WebP, AVIF and JPEG; it is not a
  dependency and nothing is downloaded. Without it PNG textures are still resized (area filter, colour averaged in
  linear light and weighted by alpha) and rewritten by margo-convert's own PNG writer, which picks the narrowest colour
  type and the best filter for every row; WebP, AVIF and JPEG images are left as they are and the manifest says so.
- `--max-texture 1024`, `--texture-format webp|avif|png|jpeg|keep` and `--texture-quality 80` override the preset.
  `--no-sharp` ignores an installed sharp.
- `--mipmaps` also writes `name.dds`, an uncompressed RGBA8 file with the full mip chain, for each standalone texture
  (`@margoengine/decoders/dds` reads it). WebP, PNG and JPEG hold one level, and Margo builds the others on the GPU, so
  this is off by default. KTX2 with Basis Universal compression needs an encoder, and none is installed.

### Audio

- **WAV** (8, 16, 24 and 32-bit PCM, 32 and 64-bit float) is mixed to mono and resampled when the preset asks
  (`mobile`: mono, at most 22.05 kHz) with a Hann-windowed sinc low-pass at 95% of the new Nyquist frequency, and
  written as 16-bit PCM. Other WAV encodings are left as they are.
- **Ogg Vorbis.** Node has no audio encoder. If an `ffmpeg` with `libvorbis` is on the PATH, `web`, `mobile` and
  `roblox` convert WAV and FLAC to Ogg Vorbis (quality 4, with the preset's mono and rate); without it the files pass
  through and the manifest says why. MP3, AAC, Opus and Ogg are web formats already and are never re-encoded.
  `--no-ffmpeg` ignores an installed ffmpeg.

### Manifest, size report, incremental builds

`build` writes `margo-manifest.json` and `margo-size-report.txt` to the output folder. The manifest has one entry per
input with its relative path, size and SHA-256, the status (`built`, `cached`, `copied`, `skipped`, `failed`), every
output with its path, size and SHA-256, what was done or could not be done, and counts from the model passes. It
names no times, so the same inputs and settings give the same manifest. `--hash-names` puts the first eight digits
of the content hash in output names (`Fox.fbdf9e94.glb`) for long-lived caching; the manifest maps each source to its
file.

An input is skipped when its content hash, the preset and the tool version match the previous manifest and every output
still exists with the recorded hash. Change a file, switch the preset or damage an output and only that is rebuilt;
`--force` rebuilds everything. Outputs of inputs that no longer exist are removed. A failed input is recorded and the
build goes on; the exit code is 1 if any failed.

From code: `import {build} from 'margo-convert/build'`, `import {optimizeModel} from 'margo-convert/optimize'`,
`import {PRESETS} from 'margo-convert/presets'`.

### Not done, and why

- **Draco encoding.** No Draco encoder is installed (the repository ships only the decoder), so Draco is not written.
  Meshopt covers the same job and is smaller to decode. A Draco-compressed input is copied unchanged.
- **Level of detail.** The repository has no mesh simplifier, so no LODs are generated.
- **KTX2 / Basis Universal textures.** No encoder is installed; WebP (or PNG without sharp) is written instead.
- **Audio codecs.** Without an ffmpeg that has `libvorbis`, no Ogg, MP3 or Opus is written; MP3, AAC and Opus inputs
  are never decoded, so only WAV is mixed down and resampled.

## Thumbnail

Render one model to a PNG with no page, for server thumbnails and asset checks.

```sh
npm i webgpu sharp                                        # your choice of binding; sharp only for textured models
npx margo-convert thumbnail helmet.glb --out helmet.png --size 512
npx margo-convert thumbnail helmet.glb --out helmet.png --views front,iso   # helmet.front.png, helmet.iso.png
```

| Option | Default | What it does |
| --- | --- | --- |
| `--out <file>` | `<name>.thumb.png` | The PNG. With several views, each file adds its view: `<name>.<view>.png`. |
| `--size <px>` | `512` | Width and height, 1 to 4096. |
| `--views <list>` | `iso` | Comma-separated: `front`, `back`, `left`, `right`, `top`, `iso`. The camera fits the whole model. |
| `--gpu <module>` | `webgpu` | The WebGPU binding to import from your project, or a path to one. It exports `create(args)` or `gpu`, and optionally `globals`. |
| `--no-sharp` | off | Ignore an installed sharp. A model with textures then fails with an error. |

margo-convert ships no binding, because one is a large download that runs code when installed. A missing binding,
a textured model without sharp, and a model that uses Draco or KTX2 (their decoders need Workers) each fail with a coded
error that names the fix. For Draco or KTX2, export the model uncompressed; `margo-convert optimize` then compresses it
with meshopt, which decodes in Node. Lighting is core's default.

## Tests

`node --test tests/margo-convert-pipeline.test.js tests/margo-convert-textures.test.js tests/margo-convert-audio.test.js tests/margo-convert-paths.test.js` from the repository root (part of `npm run verify`).

Apache-2.0 licensed.
