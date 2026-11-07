# @margoengine/usdz

Import `margoengine/usdz` from the `margoengine` package, or `@margoengine/usdz` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional static USDA, USDC and USDZ ingestion into `@margoengine/gltf-pro`. Core and the stage facade are unchanged. The package uses Margo's shared bounded USDA tokenizer and ZIP reader, plus its native Crate decoder for USDC. Building and using it requires no external renderer or CAD runtime.

USDZ remains an ancillary format outside the six core launch packages and is not a core launch blocker.

```ts
import {Engine} from 'margoengine/core';
import {loadUSDZ} from 'margoengine/usdz';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:10000});
const model=await loadUSDZ(engine,'/model.usdz');
engine.start();
// model.destroy() detaches its PBR plugin and frees meshes/textures.
```

`parseUSDA(textOrBytes)`, `parseUSDC(bytes)`, and async `parseUSDZ(bytes)` return a `USDAsset` with typed mesh streams, a glTF document/buffers, and async `create(engine)` to attach PBR rendering. `loadUSDZ` fetches with streaming byte bounds and creates the model. Malformed, unsupported or oversized input throws a `LoaderError` (`error.format === 'USD'`; `error.code` is `syntax`, `unsupported` or `limit`). Options: `maxBytes`, `maxVertices`, `maxTriangles`, `maxDepth`, `signal`. Defaults: 64 MiB, one million expanded vertices/triangles, depth 32. The engine grows its store when the hierarchy plus the PBR model root exceed the initial capacity. Texture ownership passes to the PBR model and is released on destruction or failed setup.

Supports stored and Deflate ZIP entries with CRC checks, static ASCII/binary hierarchies, Y/Z up and authored units, ordered translate/scale/rotateXYZ/affine transforms, triangles and convex planar polygons, left-handed winding, authored normals and vertex/face-varying UVs including indices, inherited material bindings, and constant UsdPreviewSurface diffuse/roughness/metallic factors. UsdUVTexture diffuse and normal maps are decoded from the archive. A texture's `wrapS`/`wrapT` (`repeat`, `mirror`, `clamp`; `black` and `useMetadata` fall back to repeat) become a glTF sampler, and a `UsdTransform2d` on its `st` becomes `KHR_texture_transform` (same angle and sign, in radians). `mesh.uvs` holds `st` as authored (origin at the image's bottom left); the glTF document holds them as uvs (s, 1 - t). Separate roughness and metallic maps are packed into glTF's green/blue channels during creation.

Standard USDZ is an uncompressed, aligned archive. Deflate support accepts a broader ZIP envelope for interoperability. Stored entries reuse archive views. Decompression, Crate decoding, topology expansion, texture packing and GPU upload require allocations: this is **not** end-to-end zero-copy. Geometry conversion writes flat typed arrays without allocating an object per output vertex; metadata and hierarchy objects remain necessary.

Vertex colors read through a `UsdPrimvarReader` of `displayColor` or `displayOpacity` load as `mesh.colors` (four floats per vertex) and glTF COLOR_0, a constant `inputs:opacity` or the base colour map's alpha gives `BLEND`, or `MASK` with `inputs:opacityThreshold`; so a file from `exportUSDZ` keeps its paint and alpha. A separate opacity map and a reader of any other primvar are refused.

Without the entries below this is a static mesh subset of one flattened layer. A prim may reference a class or other prim of the same layer (`references = </Path>`, what `exportUSDZ` writes for a shared geometry), and what it authors wins; class prims are not drawn. Other composition is refused. A mesh's `GeomSubset`s with materials are primitives of their own (`mesh.subsets`), a texture reads the primvar its `UsdPrimvarReader` names, every `xformOp` of the schema is read (`rotateX`, all six Euler orders, `orient`, suffixes such as `xformOp:translate:pivot` and `!invert!`), guide and proxy meshes are left out, and a mesh with no material shows its `displayColor`. Physical Apple AR Quick Look round trips are untested.

## Composition

`composition()` from `margoengine/usdz/compose` opens real production files and Apple's samples, not only flattened ones: sublayers, references, payloads, inherits, specializes and variant sets, across any mix of text and binary layers, with list edits, layer offsets, `timeCodesPerSecond` scaling, relationship and connection paths carried through each arc, and instances expanded in place. Strength order follows the Composition chapter of the AOUSD USD Core Specification v1.1.0. A time scale at or below 0 is a composition error there: the offset counts as the default and `issues` lists `invalid-offset`.

```ts
import {Engine} from 'margoengine/core';
import {loadUSDZ} from 'margoengine/usdz';
import {composition, loadUSDFiles} from 'margoengine/usdz/compose';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:100000});
// A .usdz: its layers come from the archive.
const toy=await loadUSDZ(engine,'/toy_car.usdz',{extensions:[composition()]});
// A scene spread over a folder: each layer and texture is fetched next to the root, and only those the stage uses.
const kitchen=await loadUSDFiles(engine,'/Kitchen_set/Kitchen_set.usd',{maxVertices:8_000_000,maxTriangles:8_000_000});
// Pick a variant, as a session layer would.
const red=await loadUSDFiles(engine,'/model.usd',{variants:{'/Model':{shadingVariant:'red'}}});
engine.start();
```

`composition(options)` takes `variants` (by prim path; default the file's own selections), `layers` (id to text or bytes, for layers an archive does not hold), and `payloads` (`false` leaves them out; default true). `parseUSDFiles(root, read, options)` and `composeUSDFiles(root, read, options)` take your own reader of ids, which are paths from the root layer's folder; the second returns the composed prims as a flat spec map, for tools. A `.usdz` among the files opens as a package.

What cannot be opened is left out and listed in `asset.issues` (`{code, message}`), as OpenUSD warns and goes on: `missing-layer`, `missing-default-prim`, `cycle`, `unsupported-layer`, `unsupported`. A composed file also keeps going past what a single static layer refuses: a material it cannot read is neutral grey under its own name, a subdivision mesh draws its control cage until `/subdiv` is in use.

Not read: value clips, relocates, splines, `.abc` and other non-USD layers, implicit shapes (`Cube`, `Sphere`), `PointInstancer`, curves and points. A projective `xformOp:transform` is refused: a glTF node has no place for it.

`npm run modern:test:usdz` checks synthetic USDA/USDC equivalence, ZIP/Deflate, CRC, topology, aborts and bounds. `npm run modern:test:usdz:browser` then verifies texture-channel packing, actual WebGPU pixels, bitmap cleanup and the file-picker demo. The synthetic crate fixture was generated by OpenUSD 26.08 from the checked-in USDA; `tests/generate-fixture.py` regenerates it when OpenUSD is installed. OpenUSD is not a runtime dependency.

Build the workspace independently with `npm run build --workspace @margoengine/usdz`, or build all packages with `npm run build:packages`. Both paths need no other installed package. Run `npx vite --host 127.0.0.1` at the root and open `/examples/usdz-loader/` for the file demo. Peer ranges target core/gltf-pro 1.x. Apache-2.0 licensed.

## Skeletons and blend shapes

`skeletons()` from `margoengine/usdz/skel` imports UsdSkel, so rigged AR characters play: skeletons under a `SkelRoot`, skin weights, blend shapes with in-betweens, and their animation as one clip named after the stage's default prim. A `.usdz` also needs `composition()`; `loadUSDFiles` composes by itself.

```ts
import {Engine} from 'margoengine/core';
import {Animation} from 'margoengine/animation';
import {loadUSDZ} from 'margoengine/usdz';
import {composition} from 'margoengine/usdz/compose';
import {skeletons} from 'margoengine/usdz/skel';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:100000});
const robot=await loadUSDZ(engine,'/robot.usdz',{extensions:[composition(),skeletons()]});
Animation.attach(robot).play(0);
engine.start();
```

`skeletons()` has no options. A point may have eight influences, the engine's limit: past that the strongest eight stay, scaled to the same total, and `asset.issues` says so. Bindings outside a `SkelRoot` mean nothing, as the schema says. A `skel:animationSource` on the Skeleton prim counts when nothing above the mesh binds one.
