# Release notes

## Unreleased

Verified on 16 October 2026. These changes are available in source; this entry
does not announce an npm publication or a package version change.

### Public API migrations retained during consolidation

The optional-package hygiene changes remain in place. Shared shapes and error
codes follow [the package conventions](docs/conventions.md); update imports as
follows when moving an earlier checkout to the consolidated tree:

| Earlier API | Current API |
| --- | --- |
| Geometry `Vec2` / `Vec3` | `MutableVec2` / `MutableVec3` from `@margoengine/math` (same tuple shapes) |
| Navigation `Vector3` | `Vec3Like` from `@margoengine/math` (same object shape) |
| Lines `ExpandOptions` | `ExpandLineOptions` |
| Points `projectPoint`, `PickHit`, `Blending`, `TextureSource` | `projectToPixels`, `PointsPickHit`, `PointsBlending`, `PointsTextureSource` |
| Procedural `SurfaceOptions` | `MarchingCubesOptions` |
| Tween `smoothstep` | `easeSmoothstep` |
| Shader `Input`, `Stage`, `TextureSource` | `NodeInput`, `ShaderStage`, `BindableTexture` |
| VFX `texture` feature (`@margoengine/vfx/texture`) | `textureFeature`; pass it as `new VFX(options, { texture: textureFeature })` |
| LOD `Vec3` | `MutableVec3` for results (`octDecode`, `frameDirection`, `frameBasis`, `Imposter.center`) and `Vec3` for inputs, from `@margoengine/math` |
| Sky and terrain colour type `Color` | `Vec3` from `@margoengine/math` (same tuple shape) |
| Terrain `HeightField` | `HeightField` from `@margoengine/math`, re-exported by terrain (same shape) |

Math is the shared home for vector, quaternion, matrix, color and geometric
shape types. Core's `Vec3` remains available and is re-exported by math. Lines,
points and text continue to re-export their color and mesh-world helpers from
math. Optional packages use `MargoError` with a stable `code`; core and stage
retain their frozen error contract. Shader operations carry typed result nodes
instead of public `Node<any>` results.

The lighting, post and environment packages (environment, post, creative,
clustered, tonemap, shadows, taa, sky, water, terrain, dof, oit, toon,
transitions, splats, vfx, scatter, lod, webgl, culling) now follow the same
conventions: every former bare `Error` is a `MargoError` with a `code`, or a
`TypeError` / `RangeError` for malformed input, and keeps its old text as the
start of the message. Environment's EXR, inflate and UltraHDR decoders throw
`MargoError` `'failed'` for damaged files and `'unsupported'` for features
they do not decode, as its HDR decoder already did. A lost WebGL context now
reports `MargoError: WebGL context lost; create a new engine`. Private
pass-context aliases visible in the published types are named per package
(`PostPassContext`, `ShadowPassContext`, `SkyPassContext`,
`TerrainPassContext`, `ScatterPassContext`); vfx's `Owned` is
`OwnedResources`. Environment, sky, water, terrain, oit, toon, transitions,
vfx, scatter, lod, webgl and culling list `@margoengine/math` under
`dependencies`; dof and tonemap list it under `devDependencies`, as post,
clustered, shadows, taa, splats and creative already did.

The scenery `sky-moon` implementation was deliberately replaced by the
`SkyMoon` preset over `@margoengine/sky`. Keep that single implementation rather
than restoring `SkyMoonPass`. The consolidation record
lists all 74 public packages, preserved optional entries and audit decisions.

### USDZ dependency cleanup

- `@margoengine/usdz` reads USDA and USDC with its own parsers (`src/crate.ts` and
  the shared `readUSDA`). The unused vendored Three.js parsers and their
  `THIRD-PARTY-NOTICES.txt` were removed on 2026-10-21; the package ships only `dist`.
- Removed `three` and `@types/three` from the root development dependencies and
  lockfile. Benchmark and visual-parity tooling uses a separately cached,
  integrity-checked Three.js 0.186.1 reference.
- USDA and USDC parsing remains synchronous; USDZ archive parsing and model
  creation remain asynchronous. Existing USDA/USDC fixture output is unchanged.
  USDZ remains an ancillary format outside the six core launch packages; no new
  package was introduced.

### Compressed glTF in glTF Pro

- `@margoengine/gltf-pro` uses its `@margoengine/decoders` dependency to load
  `KHR_draco_mesh_compression` primitives and `EXT_meshopt_compression` buffer
  views from glTF and GLB. Unknown required extensions still reject.
- `parseGLTF(engine, input, buffers, images)` keeps its synchronous return value
  for uncompressed and Meshopt input. Meshopt uses the TypeScript decoder at the
  buffer-view boundary, caches decoded bytes and needs no workers or Wasm.
- `parseGLTFAsync(engine, input, buffers, images, options)` supports compressed
  in-memory input. `loadGLTF(engine, url, options)` handles compressed downloads
  automatically. Both accept `{signal, draco}`; caller-supplied decoders remain
  caller-owned. Default Draco workers and bundled Wasm start lazily and temporary
  workers are released on success, failure and cancellation.
- Draco extraction honors accessor component types so integer UVs and colors
  normalize once. Triangle extraction promotes to Uint32 at 65,536 vertices.
  Decoded counts, attribute widths, index ranges and output-byte budgets are
  checked before GPU construction; output preflight does not cap Draco's
  internal Wasm geometry allocations.
- The basic `@margoengine/gltf` subset is unchanged. `gltf-pro` also loads
  `KHR_texture_basisu` textures lazily, uploads complete GPU-ready mip chains,
  and releases loader-owned transcoder workers.

### Optional material and asset extensions

- `@margoengine/materials` adds clearcoat, transmission, IOR, volume and a closed
  TypeScript node graph through the isolated group 3 material slot. It now also
  supports sheen, specular color, anisotropy and iridescence through caller
  factories or explicit installation of optional Khronos material metadata.
  Color textures decode sRGB; data textures remain linear. The new lobes affect
  directional and fixed hemisphere lighting; clustered and environment lighting
  retain the base PBR response.
- Zero sheen, anisotropy and iridescence and neutral specular preserve baseline
  pixels exactly. Specular factor zero removes dielectric reflection, as glTF
  requires. Core, stage and the baseline PBR shader remain unchanged.
- `KHR_texture_transform` and UV1 use the existing vertex layout and optional
  group 3 factors. Standard UV0 primitives retain their original bindings.
  `@margoengine/animation` supports four or eight normalized joint influences,
  with separate kernels and unchanged single-clip allocation behavior.
- The React package adds its declarative `Stage` wrapper and lowercase element
  aliases. The FBX suite includes a reproducible CC0 Blender rig and required
  real-file skinning, playback, seek and restoration checks.

### Local-light shadows

- `@margoengine/clustered` adds opt-in point and spot shadow maps with explicit
  caster registration, alpha-mask/UV1 transforms, per-light bias settings and
  device restoration. Core, PBR and terrain receive the shadows; directional
  cascades and frozen core/stage sources remain unchanged. The GPU checks cover
  45 captures, all six point faces, TAA and directional composition, and release
  all 288 tracked GPU resources. Unshadowed shaders and bindings remain exact.

### React scene ergonomics

- Canvas-level pointer events use the engine's existing picking path, serialize
  GPU readbacks, and coalesce hover updates. Clicks distinguish dragging; the
  WebGL fallback skips unsupported picking.
- Suspense, a canvas-owned source cache and `preload()` retain independent model
  instances and abort unused pending loads. Hooks expose camera, size, engine,
  clock and invalidation; `Group`/`group`, demand rendering and optional `Html`
  stay in `@margoengine/react`. All 45 React lifecycle tests pass on Node 24.

### Optional React scene components

- `@margoengine/react/kit`, `/post`, `/physics` and `/xr` expose native scene
  helpers, FBX loading, effects, Rapier bodies and XR controllers through lazy
  optional peers. Loaded-model colliders support bounds fallbacks and explicit
  cuboid/ball children with live transform updates. Conflicting post-effect
  capture owners report an error. React 18 packed consumers pass 118 behavioral
  tests; the React 19 workspace suite passes 123 tests.

### Loaded PBR geometry consumers

- A canonical weak registry now feeds inspector overlays, line helpers, static
  raycasts/AssemblyBVH, automatic picking/selection, direct mesh shadow casters,
  TAA and native XR. Multiple primitives retain their identities even when they
  share GPU buffers. Disposal, hidden ancestors and reused mesh slots are guarded.
- Native XR owns PBR resources and skin/morph kernels on its compatible device,
  with separate eye uniforms and live animation/extension replacement handling.
  Static TAA storage is allocated only when used; standard PBR buffer flags stay
  unchanged. Current COPY_SRC deformation is copied from the GPU.
- Four original stage-facade audits remain executable TODOs: mixed `Stage.fit`
  and its internal raw adapter still read core geometry only. Supported model
  bounds/raw and explicit camera-fitting alternatives have passing regressions.
  Core and stage stay frozen; these four limitations are not reported as fixed.
- Physics, glTF export and CAD grouping read loader-owned bind-pose primitives
  through an optional CPU geometry bridge. Loaded glTF/FBX meshes retain their
  original core geometry slots and hierarchy. Unsupported export data and
  operations without usable triangles report explicit errors. Ten real-loader
  regressions and twelve WebGPU audit checks pass.

### Attached PBR model colliders

- `physics.addBody(model.root)` now gathers static descendants of a geometry-free
  root into one fitted box. Authored hierarchy, offsets, rotations and scales
  remain intact; Rapier's rigid frame retains root scale exactly once.
- Skinned or morphed geometry-derived colliders reject with
  `Skinned mesh needs an explicit collider`. Explicit capsules/dimensions and
  direct-node fitting retain their existing behavior. Failed fits leave no body.
- Eleven standalone built-entry Box regressions and five real-Rapier cases cover
  attached roots, transformed hierarchies, export, CAD/BVH/helpers and cleanup.
  The native GPU gate also loads complete Draco Avocado with all three original
  textures, verifies the exact synchronous diagnostic, and releases its worker.

### Optional mixed scene helpers

- `@margoengine/gltf-pro/scene` exposes `getSceneBounds`, `fitScene`, and
  `gatherSceneBuffers` for selected core/PBR mesh roots and their descendants.
  Mixed bounds use actual CPU vertices under current world transforms; camera
  fitting includes offscreen geometry and filters hidden ancestors by default.
- GPU records borrow existing core/PBR buffers with explicit 24/80-byte strides,
  world matrices, index counts and primitive metadata. Overlapping selections
  do not duplicate nodes; shared buffers retain distinct node/primitive records.
  Fresh queries follow animation and device restoration without uploading or
  owning geometry. WebGL2 bounds/fitting work; GPU gathering returns `null`.
- Both real Box and FBX assets have helper regressions. The four original
  frozen-facade TODOs remain unchanged: callers opt into the new entry instead
  of replacing `Stage.fit` or its internal raw adapter.

### Picking on skinned and morphed meshes

- Registered PBR models support current-pose GPU picking and selection outlines
  through `@margoengine/selection`; the existing core hook serves `engine.pick`.
  Four/eight-influence skinning, morphs, alpha/UV1 transforms, mip filtering,
  shared depth and both outline algorithms pass hardware and SwiftShader checks.
  `Raycaster.intersectModel()` snapshots the same GPU output for CPU triangle
  queries, with BVH refitting and coherent world transforms. Pending reads,
  replacement, disposal and restoration invalidate stale results and release
  staging resources. Core and stage are unchanged; baseline PBR layouts and pixels
  are preserved. The shader's generated names now describe their contents.

### Verification and footprint

- The workspace build passes. The full Node 24 suite passes **1,318 tests**, with
  zero failures or skips and **four known frozen-stage TODO audits** that retain
  their original failing assertions. Strict TypeScript checks and packed exports/imports
  pass across **all 63 packages**, including strict Bundler and NodeNext consumers.
- Regression coverage includes real normalized Draco UV/color data, index
  extraction at 65,535 / 65,536 / 65,537 vertices, Meshopt fallback buffers,
  interleaving, offsets, all supported modes/filters and malformed layouts.
- The production Vite/WebGPU browser check passes for Meshopt and Draco glTF/GLB.
  Meshopt and uncompressed synchronous parsing produce the expected geometry
  without decoder workers or Wasm requests. Draco worker assets resolve,
  temporary workers terminate, and tested model disposal leaves no meshes or
  WebGPU validation errors.
- The combined extension browser suite also passes 42 node-material, 59 new-lobe
  and 82 texture-coordinate captures, complete Khronos material/KTX2/UV1 assets,
  and independent eight-influence GPU deformation readback. New-lobe assets
  restore bit for bit and release every tracked GPU resource and decoder worker.
- The silent-geometry browser suite passes 36 captures on hardware and
  SwiftShader, compiles 67 shader modules, and destroys all 337 tracked resources.
  Inspector overlays survive frustum edges; native-device PBR eye kernels match
  the desktop FBX pose bit for bit. No GPU or page errors are reported.
- The attached-root Box and complete Avocado browser gate passes on RTX A6000
  and SwiftShader: six captures, five shaders, all 35 tracked GPU resources
  released, one decoder worker terminated, and no GPU/page errors. Attaching
  physics preserves Box pixels bit for bit; local export and world geometry
  survive reimport.
- Mixed scene helpers pass on RTX A6000 and SwiftShader with both real Box/FBX
  assets and core geometry. Each adapter checks six captures and eight shaders,
  releases all 64 tracked GPU resources across device restoration, and reports
  zero GPU/page errors. Helper queries perform no GPU work; query and restoration
  frames preserve pixels exactly. Fifteen new Node regressions also pass.
- `npm run measure:size` reports **50,207 bytes raw / 21,107 bytes gzip** for
  core + stage, including embedded Wasm and both backends. Core and stage remain
  feature-frozen. CI rejects **25,000 gzip bytes or above** and checks package
  isolation; optional parser/decoder features add no base-bundle code.
- CI runs `npm run typecheck` after package builds and retains the production
  compression browser report as a build artifact.

Repeat the checks from a built checkout with `npm run typecheck`,
`npm run test:modules:packages`, `npm run modern:test:usdz`,
`npm run modern:test:gltf-compression`, `npm run modern:test:extensions` and
`npm run measure:size`.
`npm run test:all` rebuilds the workspace and runs the full suite; use Node 24
to match CI. See the [USDZ](packages/usdz/README.md),
[glTF Pro](packages/gltf-pro/README.md) and [decoder](packages/decoders/README.md)
guides for API details and supported subsets.
