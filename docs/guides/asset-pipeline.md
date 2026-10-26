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

margo-convert web preset

file                   kind   status        in       out  saved
Fox.glb                model  built   162.9 kB   99.4 kB  39.0%
characters/Knight.glb  model  built   341.7 kB  151.7 kB  55.6%
props/dagger.gltf      model  built    25.7 kB   20.1 kB  21.9%

3 inputs: 3 built, 0 cached, 0 copied, 0 skipped, 0 failed
total 530.3 kB -> 271.2 kB (48.9% saved)
```

(`dagger.gltf` is counted with the `.bin` and `.png` it reads, and is written as `props/dagger.glb`.)

Run it again and every unchanged input says `cached`: an input is skipped when its content hash, the preset and the tool
version are the same and its outputs still match the manifest. `--force` rebuilds everything.

## What the manifest holds

`dist/margo-manifest.json` has one entry per input: relative path, size and SHA-256, a status (`built`, `cached`,
`copied` unchanged, `skipped`, `failed`), each output's path, size and SHA-256, notes (what was done, or what could not be
and why) and, for models, vertex and triangle counts before and after. It has no timestamps, so the same inputs give the
same manifest. Use it to upload only changed files, to set cache headers, or to find the hashed name of a file:

```bash
npx margo-convert build ./assets --out dist --hash-names   # Fox.85828f49.glb, name chosen by content
```

```ts
import {loadGLTF} from '@margoengine/gltf-pro';

const manifest = await (await fetch('/dist/margo-manifest.json')).json();
const fox = manifest.files.find((f) => f.source === 'Fox.glb').outputs[0].path; // 'Fox.85828f49.glb'
const loaded = await loadGLTF(engine, `/dist/${fox}`);
```

## One model

```bash
npx margo-convert optimize helmet.glb                 # helmet.optimized.glb, web preset
npx margo-convert optimize helmet.glb out/helmet.glb --preset unity
npx margo-convert optimize bracket.step bracket.glb   # STEP, IGES and BREP are converted first
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

`Knight.glb` (character with a skin and a texture atlas) goes from 341,688 to 151,712 bytes (115,164 with gzip, from
164,673). `RiggedFigure.glb` 50,116 to 29,340. `OrientationTest.glb`, a hierarchy of separate meshes, 38,920 to 18,520 with
them merged. Models whose bytes are mostly texture (`Lantern.glb`, `BoomBox.glb`) shrink by their geometry only.

### mobile

The `web` model settings, for phones. Differences apply to textures and audio only.

```bash
npx margo-convert build ./assets --out public/models --preset mobile
```

### unity, unreal, godot, roblox

Plain GLB with no required extension, no quantisation and no merging, so an importer sees what the artist made:
node hierarchy, empty nodes (often used as attachment points) and mesh names are kept. Duplicate materials, textures
and meshes are still merged and unused data still removed.

```bash
npx margo-convert build ./assets --out Assets/Models --preset unity
npx margo-convert build ./assets --out Content/Models --preset unreal
npx margo-convert build ./assets --out models --preset godot
npx margo-convert build ./assets --out upload --preset roblox
```

## What is not done

- Draco compression: the repository has a Draco decoder only, no encoder. Meshopt is used instead.
- Level of detail: there is no mesh simplifier in the repository.
- Models that use `KHR_draco_mesh_compression`, `KHR_animation_pointer` or the metadata extensions are copied
  unchanged, with the reason in the manifest.
- Textures and audio are copied unchanged in this version.

The reference for every option is the [margo-convert README](../../tools/margo-convert/README.md).
