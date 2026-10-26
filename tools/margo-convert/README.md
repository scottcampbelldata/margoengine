# margo-convert

The asset pipeline for [Margo Engine](https://margoengine.com): one command that imports, optimises, compresses and
packages models for the web and for each export target, plus an offline
STEP / IGES / BREP to GLB converter.

```sh
npx margo-convert build ./assets --out dist                  # web preset (default)
npx margo-convert build ./assets --out dist --preset mobile
npx margo-convert optimize helmet.glb                       # one model -> helmet.optimized.glb
npx margo-convert part.step part.glb                        # CAD to GLB (below)
```

## Build and optimize

`build` takes a folder (or one file) and writes optimised copies, a manifest and a size report to `--out` (default
`dist`). `optimize` does the same for one model. Both take `--preset`:

| Preset | Models |
| --- | --- |
| `web` (default) | quantised, meshopt-compressed GLB; static meshes merged; empty nodes removed |
| `mobile` | as `web` |
| `unity` | plain GLB, hierarchy and empty nodes kept, no required extensions |
| `unreal` | as `unity` |
| `godot` | as `unity` |
| `roblox` | as `unity` |

Textures and audio files are copied to the output unchanged for now; the presets already carry their texture sizes and
audio settings, which later versions apply.

See [docs/guides/asset-pipeline.md](../../docs/guides/asset-pipeline.md) for examples of each.

What happens to a model (`.glb`, `.gltf` with its external files, or STEP/IGES/BREP, which are converted first):

- **Prune.** Texture coordinate sets no material reads, tangents without a normal map, then unused nodes, meshes,
  materials, textures, samplers, images, skins and cameras. Nodes that carry nothing are removed only for the web
  presets (game engines use empty nodes as attachment points).
- **Dedupe.** Identical images (by content), samplers, textures, materials and meshes are merged.
- **Weld.** Identical vertices are merged (every attribute and morph target equal), unreferenced vertices and
  triangles with no area are dropped, vertices are numbered in order of first use.
- **Merge** (web presets). Static, unskinned meshes that share a material and attribute layout become one primitive,
  baked into world space. Safe means: no animation on the node or an ancestor, no morph targets, no node extensions,
  and the mesh used by one node only (shared meshes stay instanced).
- **Quantise** (web presets, KHR_mesh_quantization). Positions to 16-bit with the mesh bounds folded into the node
  transform (one scale on all axes, so normals stay correct; a node with children or animation gets a child node for
  the mesh), normals and tangents to 8 bits, texture coordinates in 0..1 to 16 bits, colours and skin weights to 8
  bits. Meshes with morph targets are left alone; skinned meshes keep float positions.
- **Compress** (web presets, EXT_meshopt_compression). Vertex attributes and triangle indices are written with the
  meshopt codecs by an encoder written for Margo from the extension specification (`pipeline/meshopt-encode.js`);
  Margo's decoder (`@margoengine/decoders/meshopt`) reads them, and so do other glTF loaders that support the
  extension. The output lists the extension as required.
- A model is never written larger than it came in, and a model that uses an extension the optimiser does not rewrite
  (Draco, `KHR_animation_pointer`, EXT_structural_metadata and similar) is copied unchanged with the reason in the
  manifest.

### Manifest, size report, incremental builds

`build` writes `margo-manifest.json` and `margo-size-report.txt` to the output folder. The manifest has one entry per
input with its relative path, size and SHA-256, the status (`built`, `cached`, `copied`, `skipped`, `failed`), every
output with its path, size and SHA-256, what was done or could not be done, and counts from the model passes. It
names no times, so the same inputs and settings give the same manifest. `--hash-names` puts the first eight digits
of the content hash in output names (`Fox.85828f49.glb`) for long-lived caching; the manifest maps each source to its
file.

An input is skipped when its content hash, the preset and the tool version match the previous manifest and every output
still exists with the recorded hash. Change a file, switch the preset or damage an output and only that is rebuilt;
`--force` rebuilds everything. Outputs of inputs that no longer exist are removed. A failed input is recorded and the
build goes on; the exit code is 1 if any failed.

From code: `import {build} from 'margo-convert/build'`, `import {optimizeModel} from 'margo-convert/optimize'`,
`import {PRESETS} from 'margo-convert/presets'`.

### Not done, and why

- **Draco encoding.** No Draco encoder is installed (the repository ships only the decoder), so Draco is not written.
  Meshopt covers the same job and is smaller to decode.
- **Level of detail.** The repository has no mesh simplifier, so no LODs are generated.
- **KTX2 / Basis Universal textures.** No encoder is installed.

## CAD to GLB

Offline STEP / IGES / BREP to GLB: tessellate once at build time and ship a small GLB instead of the 3.1 MB (gzip) OCCT
runtime that `loadCAD` downloads for STEP and IGES.

```sh
npx margo-convert part.step                 # writes part.glb next to it
npx margo-convert assembly.stp out/assembly.glb --linear-deflection 0.05 --angular-deflection 15
npx margo-convert bracket.igs --merge       # one node per colour, no tree
npx margo-convert line.step --edges         # also bake feature edges
npx margo-convert part.brep --units in      # BREP has no unit
```

| Option | Default | |
| --- | --- | --- |
| `--linear-deflection <mm>` | 0.1% of the model's average bounding-box size | Largest chord-to-surface distance (OCCT `absolute_value`) |
| `--angular-deflection <deg>` | 28.65 (0.5 rad) | Largest angle between neighbouring facets |
| `--merge` | off | One node per material with world-space geometry: fewest nodes, no part names, no instancing |
| `--no-instancing` | instancing on | Write every repeated part as its own mesh |
| `--edges`, `--edge-angle <deg>` | off, 30 | Bake feature edges (below) |
| `--units <mm\|cm\|m\|in\|ft>` | `mm` | Units of a `.brep` file; STEP and IGES carry their own |
| `--quiet` | | Print nothing on success |

The defaults are exactly what `loadCAD` uses (same OCCT build, occt-import-js 0.0.23, `linearUnit: 'meter'`, no
deflection parameters), so a converted file has the same triangles as the browser import. From code:
`import {convert, formatOf} from 'margo-convert'` then `const {glb, stats} = await convert(bytes, formatOf(name), options)`.

Load the result like any GLB:

```ts
import {loadGLTF} from '@margoengine/gltf';          // core meshes: FeatureEdges, AssemblyBVH, sections, ExplodedView
const model = await loadGLTF(engine, '/assembly.glb'); // or @margoengine/gltf-pro's loadGLTF for its PBR path
```

## What it writes

- **Units.** Metres. OCCT converts STEP and IGES from the unit in the file (`linearUnit: 'meter'`, as `loadCAD`). BREP
  files carry no unit: `--units` (default millimetres) scales them. Axes are unchanged, as with `loadCAD` (most CAD is
  Z-up; glTF viewers assume Y-up, so rotate the root in the app if needed).
- **Assembly tree and names.** The STEP product structure becomes the node tree (`as1` > `rod-assembly` > `nut`, ...),
  each part a node named as in the file. Assembly nodes carry no transform; a part node carries its position, and its
  vertices are stored relative to the part's bounding-box centre (node translations are JSON doubles, so float32
  vertices stay precise far from the origin).
- **Colours.** One glTF material per colour (named `#rrggbb`), STEP/IGES colours read as sRGB and written linear,
  roughness 0.4, metalness 0.3 (machinery's CAD material). Parts without a colour get `loadCAD`'s `#a6b9c8`. A part
  whose faces have different colours becomes a node with one child mesh per colour.
- **Instancing.** OCCT reuses one triangulation for every placement of a shape, so repeated parts are found by equal
  index buffers and colours, then a rigid transform (rotation + translation from three anchor vertices, every vertex
  within 1e-6 of the part size; mirrored copies are not matched). Copies share one glTF mesh and get their own node
  rotation and translation. The light loader turns a shared mesh into one shared `Geometry`, which core draws instanced.
  `EXT_mesh_gpu_instancing` is not written: the exporter's data-scene writer has no instancing, and the light loader
  rejects node extensions; gltf-pro handles shared meshes too.
- **Normals.** OCCT's surface normals: smooth across a curved face, crisp at B-Rep edges. (`loadCAD` instead welds
  vertices and smooths by default, which also rounds sharp corners; triangles are identical.)
- **Feature edges (`--edges`).** machinery's `featureEdges` (what `FeatureEdges` computes at load time) runs offline on
  each written geometry. Each glTF mesh gets `extras: {featureEdges: <accessor>, featureAngle: 30}`: a `uint32` SCALAR
  accessor of vertex index pairs into that mesh's primitive 0 `POSITION`. glTF line primitives were not used because
  both Margo loaders accept triangles only. Margo's `FeatureEdges` does not read the accessor yet: it recomputes the
  same edges at load, about 1 ms per 1,000 distinct triangles in Node (1.8 ms for `as1-oc-214`'s 1,996, 4.0 ms for
  4,348; diagnostic, busy machine), so baking only pays off for models with hundreds of thousands of distinct triangles
  once `FeatureEdges` takes precomputed edges.
- **Not written:** Draco compression (no encoder is installed). Run `margo-convert build` on the result for meshopt
  compression, or serve the GLB with gzip or brotli.

## Why a separate package

`@margoengine/machinery` is a browser runtime package: it ships `loadCAD`, the CAD worker and the OCCT assets that run
in a page. The converter reads and writes files (`node:fs`), parses arguments and depends on `@margoengine/exporters`;
as a `bin` in machinery that Node-only code and dependency would land in every app that installs machinery. As its
own unscoped package (like `create-margo`), `npx margo-convert` works without installing anything, and the runtime
packages stay free of Node code. It reuses machinery's pieces rather than copying them: the same occt-import-js
build and parameters, machinery's `featureEdges`, and `@margoengine/exporters`' validated GLB writer.

Dependencies: `occt-import-js` 0.0.23 (LGPL-2.1, loaded as a separate npm package, as in machinery),
`@margoengine/core`, `@margoengine/exporters`, `@margoengine/machinery`, `@margoengine/math`. Node 22.12 or later.

## Results

occt-import-js sample files (`node_modules/occt-import-js/test/testfiles`), default tessellation, Node 24
(`examples/package-benchmarks/margo-convert.mjs --diagnostic`, results/margo-convert-diagnostic.json: the quiet gate
was skipped, CPU at 91% from other work, so times are upper bounds; the same as1 conversion took 1.18 s on a calmer
run). Every GLB: Khronos glTF-Validator 0 errors, 0 warnings, 0 infos (with `--edges`, one UNUSED_OBJECT info per
edge accessor, since only extras reference it).

| File | Input (gzip) | GLB (gzip) | `--edges` GLB | Parts / meshes / triangles | Tessellate + write | Parse GLB in Node (gltf / gltf-pro) |
| --- | --- | --- | --- | --- | --- | --- |
| `cax-if/as1-oc-214.stp` | 441,968 (81,383) | 68,352 (25,579) | 77,168 | 18 / 5 / 5,040 | 2,095 + 11 ms | 3.8 / 4.5 ms |
| `cax-if/as1-tu-203.stp` | 142,057 (27,351) | 64,644 (22,783) | 72,964 | 18 / 5 / 4,688 | 376 + 12 ms | 2.0 / 5.4 ms |
| `cax-if/dm1-oc-214.stp` | 226,281 (43,244) | 35,408 (15,642) | 40,076 | 7 / 3 / 1,904 | 366 + 4 ms | 1.6 / 3.1 ms |
| `cube-10x10mm/Cube 10x10.stp` | 9,404 (2,844) | 1,748 (645) | 2,004 | 1 / 1 / 12 | 16 + 0.4 ms | 1.5 / 1.9 ms |
| `cube-10x10mm/Cube 10x10.igs` | 11,562 (1,475) | 1,736 (642) | 1,992 | 1 / 1 / 12 | 28 + 0.6 ms | 1.4 / 1.5 ms |
| `cax-if-brep/as1_pe_203.brep` | 42,186 (5,700) | 53,648 (14,994) | 60,624 | 18 / 5 / 3,848 | 88 + 8 ms | 3.4 / 3.3 ms |

Bytes are raw (gzip -9 in brackets). Add OCCT's one-time load per process (85-250 ms); a cold `npx margo-convert` of
`as1-oc-214.stp` (new Node process) took 4.1 s on the busy machine. Compare the browser path for the same files
(docs/cad-performance.md, Edge on the Arc 140V laptop): `as1-oc-214.stp` 1,403-1,715 ms from request to model and
`Cube 10x10.igs` 361-456 ms, after downloading 3.1 MB (gzip) of OCCT Wasm plus 32 kB of worker JavaScript. With the
GLB the page downloads 25.6 kB (gzip) instead of 81 kB of STEP + 3.1 MB of OCCT, and parsing takes milliseconds.
Instancing matters: `as1-oc-214.stp` with `--no-instancing` writes 18 meshes and a GLB more than twice the size.

## Limits

- OCCT runs in 32-bit Wasm: very large assemblies are bounded by its 2-4 GB heap, and conversion is single-threaded.
- Loaders bound what a GLB may hold: the light loader takes up to 1,000,000 vertices in total and gltf-pro up to
  1,000,000 per primitive. OCCT keeps separate vertices per B-Rep face, so a converted part has more vertices than
  `loadCAD`'s welded one (same triangles); use a coarser `--linear-deflection` for huge models.
- Instancing finds rigid copies only; mirrored or scaled copies, and copies OCCT triangulated separately, are written
  as their own meshes.
- No PMI, layers, transparency (occt-import-js reports RGB only), metadata or textures.
- `--edges` data is not consumed by `FeatureEdges` yet (a small option there, e.g. a geometry -> edges lookup, would).

## Tests

`node --test tests/margo-convert.test.js` from the repository root (after `npm run build:packages`; part of
`npm run verify`; skipped when the OCCT Wasm cannot load). It converts the occt-import-js sample files, runs the
Khronos glTF-Validator on every GLB (0 errors), loads each with gltf-pro and the light loader, and compares triangles,
world bounds (1e-6 m) and part names with machinery's `loadCAD` of the same file run in Node (a stand-in `Worker`
executes the built CAD worker in-process). It also checks instancing (18 parts, 5 meshes, same bounds as
`--no-instancing`), `--merge`, `--edges` (equal to `featureEdges` on the written geometry), tessellation options, BREP
units, the CLI's errors, and type-checks the tool (`tsc --checkJs --strict`). Measurements:
`node examples/package-benchmarks/margo-convert.mjs` (results/margo-convert.json).

Apache-2.0 licensed (OCCT and occt-import-js: LGPL-2.1, installed as their own package).
