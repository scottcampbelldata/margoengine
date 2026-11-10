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

For the executable README check, `/model.usdz` maps to Needle's published Blender 5.1 conversion
of Cesium's BoxTextured sample (CC-BY-4.0 with trademark limitations). Run
`node scripts/fetch-readme-assets.mjs` from the repository root to fetch its hash-checked USDZ into
the shared external cache. The example exercises the static reader, including its archived texture;
it does not require an animation or subdivision extension.

`parseUSDA(textOrBytes)`, `parseUSDC(bytes)`, and async `parseUSDZ(bytes)` return a `USDAsset` with typed mesh streams, a glTF document/buffers, and async `create(engine)` to attach PBR rendering. `loadUSDZ` fetches with streaming byte bounds and creates the model. Malformed, unsupported or oversized input throws a `LoaderError` (`error.format === 'USD'`; `error.code` is `syntax`, `unsupported` or `limit`). Options: `maxBytes`, `maxVertices`, `maxTriangles`, `maxDepth`, `signal`. Defaults: 64 MiB, one million expanded vertices/triangles, depth 32. The engine grows its store when the hierarchy plus the PBR model root exceed the initial capacity. Texture ownership passes to the PBR model and is released on destruction or failed setup.

Supports stored and Deflate ZIP entries with CRC checks, static ASCII/binary hierarchies, Y/Z up and authored units, ordered translate/scale/rotateXYZ/affine transforms, triangles and convex planar polygons, left-handed winding, authored normals and vertex/face-varying UVs including indices, inherited material bindings, and constant UsdPreviewSurface diffuse/roughness/metallic factors. UsdUVTexture diffuse and normal maps are decoded from the archive. A texture's `wrapS`/`wrapT` (`repeat`, `mirror`, `clamp`; `black` and `useMetadata` fall back to repeat) become a glTF sampler, and a `UsdTransform2d` on its `st` becomes `KHR_texture_transform` (same angle and sign, in radians). `mesh.uvs` holds `st` as authored (origin at the image's bottom left); the glTF document holds them as uvs (s, 1 - t). Separate roughness and metallic maps are packed into glTF's green/blue channels during creation.

Standard USDZ is an uncompressed, aligned archive. Deflate support accepts a broader ZIP envelope for interoperability. Stored entries reuse archive views. Decompression, Crate decoding, topology expansion, texture packing and GPU upload require allocations: this is **not** end-to-end zero-copy. Geometry conversion writes flat typed arrays without allocating an object per output vertex; metadata and hierarchy objects remain necessary.

Vertex colors read through a `UsdPrimvarReader` of `displayColor` or `displayOpacity` load as `mesh.colors` (four floats per vertex) and glTF COLOR_0, a constant `inputs:opacity` or the base colour map's alpha gives `BLEND`, or `MASK` with `inputs:opacityThreshold`; so a file from `exportUSDZ` keeps its paint and alpha. A separate opacity map and a reader of any other primvar are refused.

Without the entries below this is a static mesh subset of one flattened layer: meshes need `subdivisionScheme = "none"`, and subdivision or hole faces are refused. A prim may reference a class or other prim of the same layer (`references = </Path>`, what `exportUSDZ` writes for a shared geometry), and what it authors wins; class prims are not drawn. Other composition is refused. A mesh's `GeomSubset`s with materials are primitives of their own (`mesh.subsets`), a texture reads the primvar its `UsdPrimvarReader` names, every `xformOp` of the schema is read (`rotateX`, all six Euler orders, `orient`, suffixes such as `xformOp:translate:pivot` and `!invert!`), `!resetXformStack!` is honoured (see [Reset transform stacks](#reset-transform-stacks)), guide and proxy meshes are left out, and a mesh with no material shows its `displayColor`. Physical Apple AR Quick Look round trips are untested.

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
const figure=await loadUSDZ(engine,'/RiggedFigure.usdz',{extensions:[composition(),skeletons()]});
Animation.attach(figure).play(0);
engine.start();
```

`skeletons()` has no options. A point may have eight influences, the engine's limit: past that the strongest eight stay, scaled to the same total, and `asset.issues` says so. Bindings outside a `SkelRoot` mean nothing, as the schema says. A `skel:animationSource` on the Skeleton prim counts when nothing above the mesh binds one.

## Time-sampled transforms and visibility

`animation()` from `margoengine/usdz/anim` plays `timeSamples` on `xformOp`s and `visibility` as the stage's clip, named after its default prim and shared with `skeletons()`. Clip seconds come from `timeCodesPerSecond`. A `.usdz` also needs `composition()`; `loadUSDFiles` composes by itself.

```ts
import {Engine} from 'margoengine/core';
import {Animation} from 'margoengine/animation';
import {pointerChannels} from 'margoengine/animation/pointer';
import {loadUSDZ} from 'margoengine/usdz';
import {composition} from 'margoengine/usdz/compose';
import {animation} from 'margoengine/usdz/anim';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:100000});
const box=await loadUSDZ(engine,'/BoxAnimated.usdz',{extensions:[composition(),animation()]});
Animation.attach(box,{pointers:pointerChannels}).play(0);
engine.start();
```

`animation()` has no options. Each prim's ops are evaluated as a stage does, held past both ends and linear between samples, then split into translation, rotation and scale keys. A move two keys can carry stays two keys. One they cannot, such as a rotation after a scale, gets a key on every time code, and a turn wider than 45 degrees between keys gets more, so spins keep their turns. Visibility plays through `KHR_node_visibility` and `KHR_animation_pointer`, which is why `Animation` needs `pointerChannels`; a prim that starts invisible and shows later stays in the scene, hidden until then. Shear has no node form: the nearest rotation and scale play and `asset.issues` says so. Time-sampled `points` do not play.

## Subdivision, holes and concave polygons

`subdivision()` from `margoengine/usdz/subdiv` refines meshes by their `subdivisionScheme`: `catmullClark` (USD's default), `loop` and `bilinear`. It honours `creaseIndices`, `creaseLengths`, `creaseSharpnesses`, `cornerIndices`, `cornerSharpnesses`, `interpolateBoundary` and `faceVaryingLinearInterpolation`, leaves out `holeIndices` faces, and splits concave polygons into triangles. A `.usdz` also needs `composition()`; `loadUSDFiles` composes by itself.

```ts
import {Engine} from 'margoengine/core';
import {loadUSDFiles} from 'margoengine/usdz/compose';
import {subdivision} from 'margoengine/usdz/subdiv';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:100000});
// A cube cage that asks for catmullClark, from the AOUSD working group's test assets.
const cube=await loadUSDFiles(engine,'/subdiv_catmullClark.usda',{extensions:[subdivision({level:2})]});
engine.start();
```

`subdivision(options)` takes `level`, how many times each face is split, a whole number from 0 to 6, default 2. Each level gives four faces for one. A stage that would pass `maxTriangles` gets a lower level for all its meshes, and `asset.issues` says which. Level 0 keeps the cage but still leaves out holes and splits concave polygons.

USD's schema default is `catmullClark`, so a polygon model that forgets `subdivisionScheme = "none"` is smoothed: that is what the file asks for. Refined meshes get normals of their own, as the schema says, and an edge that stays sharp keeps a hard normal. Primvars, UVs, display colours, material subsets, joint influences and blend shape offsets follow the refined faces; a point keeps its 8 strongest influences. Without this entry a subdivided mesh loads as its cage, with an issue.

`loop` takes triangles only; other faces refine as `catmullClark`, with an issue. `triangleSubdivisionRule = "smooth"` refines by the standard rule, with an issue, and `creaseMethod = "chaikin"` refines semi-sharp creases by the uniform rule (sharpness minus 1 a level), with an issue. A face-varying value that repeats at a point joins the faces it touches: equal numbers count as one value, indexed or not.

## Lights and cameras

`lights()` from `margoengine/usdz/lux` reads `DistantLight`, `SphereLight`, `RectLight`, `DiskLight`, `CylinderLight` and `Camera` prims into the glTF document, so a lit stage opens lit: they load as `model.lights` and `model.cameras`, and `applyGLTFLights` and `viewGLTFCamera` from `margoengine/gltf-pro` use them. A `.usdz` also needs `composition()`; `loadUSDFiles` composes by itself. A stage holding only cameras or lights opens too.

```ts
import {Engine} from 'margoengine/core';
import {applyGLTFLights,viewGLTFCamera} from 'margoengine/gltf-pro';
import {loadUSDFiles} from 'margoengine/usdz/compose';
import {lights} from 'margoengine/usdz/lux';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:100000});
// The Standard Shader Ball's room, lit by rect lights, from the AOUSD working group's assets.
const room=await loadUSDFiles(engine,'/environment.usda',{extensions:[lights()]});
applyGLTFLights(room); // the sun; pass {clustered} from margoengine/clustered for lamps
if(room.cameras.length)viewGLTFCamera(room,0);
engine.start();
```

`lights()` has no options. A light's luminance is `intensity * 2^exposure * color`, with `colorTemperature` when enabled, by the LightAPI schema. A lamp gives that luminance times the area it shows along its axis, in candela, and `normalize` divides by its whole surface; sizes count the transform stack's scale. A distant light gives lux from the disc `angle` fills, and with `normalize` the luminance itself. `shaping:cone:angle` under 90 makes a spot, with `shaping:cone:softness` setting its inner angle. A glTF colour stops at 1, so a stronger black body colour moves into `intensity`.

A dome light has no punctual form. It is listed in `asset.issues`, and `domeLight(asset)` gives its `path`, `file`, `intensity` and `color` for an `Environment` from `margoengine/environment`. `blackbody(kelvin)` is exported too.

## Reset transform stacks

A prim whose `xformOpOrder` holds `!resetXformStack!` lands where it was authored, whatever its parents do: its parents' transforms are left out, moving ones included, and every op up to the last reset is ignored. It needs no entry or option, in any reader of this package. `/anim` plays what comes after the reset and nothing before it.

```ts
import {parseUSDA} from 'margoengine/usdz';

const asset=parseUSDA(`#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)
def Xform "Crane"
{
    double3 xformOp:translate = (10, 0, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]
    def Mesh "Marker"
    {
        double3 xformOp:translate = (1, 2, 3)
        uniform token[] xformOpOrder = ["!resetXformStack!", "xformOp:translate"]
        uniform token subdivisionScheme = "none"
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
    }
}
`);
const marker=asset.document.nodes?.find((node)=>node.name==='Marker');
console.log(marker?.extras); // { usdPath: '/Crane/Marker' }
```

A glTF node always follows its parent, so the node of such a prim hangs from the stage's root node, under the unit and up axis of the stage, and not from its parent's node. What is below it stays with it. Walking node names no longer gives its path, so `node.extras.usdPath` holds it; `USDAsset.meshes` keep their paths, and `PBRModel` hands the extras on. Visibility still comes down from the prims above it: with `/anim`, a parent's `visibility` samples are merged into the node's own.

## MaterialX

`materialX()` from `margoengine/usdz/materialx` reads MaterialX in USD. A `.mtlx` file opens as a layer, as OpenUSD lays it out (`/MaterialX/Materials/<name>`, `/MaterialX/Shaders`, `/MaterialX/NodeGraphs`), and a material bound through `outputs:mtlx:surface` comes in as a glTF PBR material with its textures. Where a material has both, the MaterialX surface wins over `outputs:surface`. A USD layer overrides a `.mtlx` by setting inputs on the Material prim.

```ts
import {Engine} from 'margoengine/core';
import {installNodeMaterial} from 'margoengine/materials';
import {parseUSDFiles} from 'margoengine/usdz/compose';
import {materialGraph,materialX} from 'margoengine/usdz/materialx';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu',capacity:100000});
const read=async(id:string)=>{
  const response=await fetch('/materialx/'+id);
  return response.ok?new Uint8Array(await response.arrayBuffer()):undefined;
};
// Meshes bound to the materials of a MaterialX document, from the AOUSD working group's test assets.
const asset=await parseUSDFiles('TextureCoordinateTestMaterialX.usda',read,{extensions:[materialX()]});
const model=await asset.create(engine);
engine.start();
// The whole network as a node material, where a PBR material cannot hold it.
const network=await materialGraph(asset,0);
if(network){
  installNodeMaterial(model,network.graph);
  console.log(network.skipped);
}
```

`materialX()` has no options. Surface shaders: `standard_surface`, `open_pbr_surface`, `UsdPreviewSurface`, `gltf_pbr`, `surface_unlit`, and RealityKit's `realitykit_pbr_surfaceshader` and `realitykit_unlit_surfaceshader` by Apple's published definitions. Each input and default comes from the tables of the MaterialX Physically Based Shading Nodes document. What a shader sets lands in `KHR_materials_clearcoat`, `_emissive_strength`, `_ior`, `_specular`, `_transmission`, `_volume`, `_sheen`, `_iridescence`, `_unlit`, and for `gltf_pbr` also `_anisotropy` and `_dispersion`.

A network is reduced to what a PBR material holds. Constants fold through `constant`, `dot`, `convert`, `extract`, `separate`, `combine`, `multiply`, `add`, `subtract`, `mix` and `switch` by the formulas of the Standard Nodes document. An image survives `multiply` by a constant as a factor, `extract` as a channel, and `normalmap` as a normal texture with its scale. `image`, `tiledimage`, `UsdUVTexture` and `RealityKitTexture2D` read address modes, a named primvar through `geompropvalue` or `UsdPrimvarReader`, and `uvtiling`. An unreadable image gives its `default`, which is zero when unset. Anything else is listed in `asset.issues`, and the input keeps its default.

Colour spaces go by the specification's names, old and new: `srgb_texture`, `srgb_rec709_scene`, `lin_rec709`, `lin_rec709_scene`, `data`, `none`, and USD's `sRGB` and `raw`. They follow the nearest enclosing scope, and an included document takes the working colour space of the one that includes it. A base colour image that is linear is encoded to sRGB as it decodes, as a glTF slot wants it. Any other named space is read unconverted and listed.

`materialGraph(asset, material, options)` takes a material's index or prim path and gives the whole network as a node material graph for `nodeMaterial()` or `installNodeMaterial()` of `margoengine/materials`, with what it left out in `skipped`. Pass `options.texture` to supply images, as for `toGraph` of `margoengine/loaders/materialx`; without it they are listed. It gives `undefined` for a material with no MaterialX network. The network travels on the material's `extras.materialX`, so it survives the worker of `margoengine/usdz/worker` with `{name: 'materialx'}`.
