# Prepare assets with margo-convert

`margo-convert build` takes a folder of models and writes optimised copies, a manifest with hashes and sizes, and a
size report. One preset per place the assets are going: `web` (default), `mobile`, `unity`, `unreal`, `godot` and
`roblox`. Nothing to install beyond Node 22.12 or later:

```bash
npx margo-convert build ./assets --out dist
```

```text
built    Fox.glb
built    characters/Knight.glb
built    props/dagger.gltf

margo-convert web preset (sharp 0.35.5, ffmpeg not found)

file                   kind   status        in       out  saved
Fox.glb                model  built   162.9 kB   96.0 kB  41.1%
characters/Knight.glb  model  built   341.7 kB  145.1 kB  57.5%
props/dagger.gltf      model  built    25.7 kB   12.6 kB  51.0%

3 inputs: 3 built, 0 cached, 0 copied, 0 skipped, 0 failed
  model      3 files  530.3 kB -> 253.7 kB (52.2% saved)
total 530.3 kB -> 253.7 kB (52.2% saved)

notes
  Fox.glb: image 0: png recompressed (26764 -> 23403 bytes)
  characters/Knight.glb: image knight_texture: png -> webp (12914 -> 6242 bytes)
  props/dagger.gltf: image rogue_texture: png -> webp (15026 -> 7466 bytes)
```

(`dagger.gltf` is counted with the `.bin` and `.png` it reads, and is written as `props/dagger.glb`. Those files must
be in the model's folder or below it: a URI that leaves it (`../`, an absolute path, a drive or network path, or a
symlink that points out) fails that model with a `MargoError` of code `failed`.)

Run it again and every unchanged input says `cached`: an input is skipped when its content hash, the preset and the tool
version are the same and its outputs still match the manifest. `--force` rebuilds everything. A manifest that names an
output outside the output folder is treated as damaged: everything is rebuilt and nothing it names is deleted.

## What the manifest holds

`dist/margo-manifest.json` has one entry per input: relative path, size and SHA-256, a status (`built`, `cached`,
`copied` unchanged, `skipped`, `failed`), each output's path, size and SHA-256, notes (what was done, or what could not be
and why) and, for models, vertex and triangle counts before and after. It has no timestamps, so the same inputs give the
same manifest. Use it to upload only changed files, to set cache headers, or to find the hashed name of a file:

```bash
npx margo-convert build ./assets --out dist --hash-names   # Fox.fbdf9e94.glb, name chosen by content
```

```ts
import {loadGLTF} from '@margoengine/gltf-pro';

const manifest = await (await fetch('/dist/margo-manifest.json')).json();
const fox = manifest.files.find((f) => f.source === 'Fox.glb').outputs[0].path; // 'Fox.fbdf9e94.glb'
const loaded = await loadGLTF(engine, `/dist/${fox}`);
```

## One model

```bash
npx margo-convert optimize helmet.glb                 # helmet.optimized.glb, web preset
npx margo-convert optimize helmet.glb out/helmet.glb --preset unity
```

## Presets

Every preset prunes, dedupes and welds. They differ in what they assume about the reader.

### web

For a browser. Static meshes sharing a material are merged, positions are stored as 16-bit integers (the mesh bounds
move into the node transform), normals as 8-bit, and every vertex and index buffer is meshopt-compressed. The GLB
requires `KHR_mesh_quantization` and `EXT_meshopt_compression`, which Margo's loaders (`@margoengine/gltf-pro`) read; so
do other glTF loaders that support those extensions.

```bash
npx margo-convert build ./assets --out public/models
```

`Knight.glb` (character with a skin and a texture atlas) goes from 341,688 to 145,116 bytes. `RiggedFigure.glb` 50,116 to 29,340. `OrientationTest.glb`, a hierarchy of separate meshes, 38,920 to 18,520 with
them merged. Textures are where most of the bytes are: `BoomBox.glb` (2048 px PNG maps) goes from 10,614,184 to 4,131,040 bytes, `Lantern.glb` from 9,564,264 to 3,218,672 and `ToyCar.glb` from 5,422,412 to 2,396,924.

### mobile

The `web` model settings for phones: textures up to 1024 px at power-of-two sizes (so a GPU can block-compress and
mip them cleanly), WebP quality 72, and WAV audio mixed to mono at 22.05 kHz.

```bash
npx margo-convert build ./assets --out public/models --preset mobile
```

`BoomBox.glb` goes to 1,020,084 bytes (90% smaller), `Lantern.glb` to 990,848.

### unity, unreal, godot, roblox

Plain GLB with no required extension, no quantisation and no merging, so an importer sees what the artist made:
node hierarchy, empty nodes (often used as attachment points) and mesh names are kept. Duplicate materials, textures
and meshes are still merged and unused data still removed. Textures stay PNG or JPEG, at the sizes each engine wants:

| Preset | Largest texture | Sizes | Audio |
| --- | --- | --- | --- |
| `unity` | 4096 px | multiples of 4 (block compression) | kept |
| `unreal` | 4096 px | powers of two (mip streaming) | kept |
| `godot` | 4096 px | any | kept |
| `roblox` | 1024 px | any | Ogg Vorbis with ffmpeg, otherwise WAV is reported: Roblox takes mp3 and ogg |

```bash
npx margo-convert build ./assets --out Assets/Models --preset unity
npx margo-convert build ./assets --out Content/Models --preset unreal
npx margo-convert build ./assets --out models --preset godot
npx margo-convert build ./assets --out upload --preset roblox
```

`BoomBox.glb` (2048 px PNG maps): `unity`, `unreal` and `godot` 6,451,548 bytes (the PNGs recompressed); `roblox`
1,643,508 (maps scaled to 1024 px).

Any setting can be changed for one run: `--max-texture 2048`, `--texture-format webp`, `--texture-quality 80`.

## Textures and audio on their own

Folders may hold plain textures and sounds next to models; `build` handles them with the same preset:

```bash
npx margo-convert build ./art --out public/art --preset mobile --mipmaps
```

`rock_normal.png` becomes a lossless `rock_normal.webp` (and a `rock_normal.dds` with its mip chain), `rock.png` a lossy
`rock.webp`, `zap.wav` a mono 22.05 kHz `zap.wav` (or `zap.ogg` when ffmpeg is installed). The size report ends with a
line per kind. sharp and ffmpeg are used only when already installed; the manifest's `encoders` says what was found.

## Thumbnails

`margo-convert thumbnail` renders a model to a PNG with no page. Install a WebGPU binding first: none ships with the
tool. Textured models also need sharp.

```sh
npm i webgpu sharp                                        # your choice of binding; sharp only for textured models
npx margo-convert thumbnail helmet.glb --out helmet.png --size 512
npx margo-convert thumbnail helmet.glb --out helmet.png --views front,iso   # helmet.front.png, helmet.iso.png
```

The options are in the [margo-convert README](../../tools/margo-convert/README.md#thumbnail). To render your own scene
from Node, use [`@margoengine/headless`](../../packages/headless/README.md).

## What is not done

- Draco compression: the repository has a Draco decoder only, no encoder. Meshopt is used instead.
- Level of detail: there is no mesh simplifier in the repository.
- KTX2 / Basis Universal textures: no encoder is installed.
- WebP, AVIF and JPEG need sharp, and Ogg Vorbis needs ffmpeg, already installed: without them PNG textures are
  recompressed and resized, and other images and audio pass through, with the reason in the manifest.
- Models that use `KHR_draco_mesh_compression`, `KHR_animation_pointer` or the metadata extensions are copied
  unchanged, with the reason in the manifest.

The reference for every option is the [margo-convert README](../../tools/margo-convert/README.md).
