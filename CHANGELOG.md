# Release notes

## Unreleased

Verified on 16 October 2026. These changes are available in source; this entry
does not announce an npm publication or a package version change.

### USDZ dependency cleanup

- `@margoengine/usdz` vendors the standalone USDA and USDC parsers from Three.js
  0.186.1 in `src/vendor/`, with the MIT attribution retained in the distributed
  `THIRD-PARTY-NOTICES.txt`. Source builds no longer read installed Three.js files.
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
- The basic `@margoengine/gltf` subset is unchanged. KTX2/Basis transcoding remains
  available separately; KTX2 textures in glTF remain unsupported.

### Verification and footprint

- The workspace build passes. The full Node 24 suite passes **931 tests**, with
  zero failures or skips. Strict TypeScript checks and packed exports/imports
  pass across **all 62 packages**, including strict Bundler and NodeNext consumers.
- Regression coverage includes real normalized Draco UV/color data, index
  extraction at 65,535 / 65,536 / 65,537 vertices, Meshopt fallback buffers,
  interleaving, offsets, all supported modes/filters and malformed layouts.
- The production Vite/WebGPU browser check passes for Meshopt and Draco glTF/GLB.
  Meshopt and uncompressed synchronous parsing produce the expected geometry
  without decoder workers or Wasm requests. Draco worker assets resolve,
  temporary workers terminate, and tested model disposal leaves no meshes or
  WebGPU validation errors.
- `npm run measure:size` reports **47,983 bytes raw / 19,999 bytes gzip** for
  core + stage, including embedded Wasm and both backends. Core and stage remain
  feature-frozen. CI rejects **20,000 gzip bytes or above** and checks package
  isolation; optional parser/decoder features add no base-bundle code.
- CI runs `npm run typecheck` after package builds and retains the production
  compression browser report as a build artifact.

Repeat the checks from a built checkout with `npm run typecheck`,
`npm run test:modules:packages`, `npm run modern:test:usdz`,
`npm run modern:test:gltf-compression` and `npm run measure:size`.
`npm run test:all` rebuilds the workspace and runs the full suite; use Node 24
to match CI. See the [USDZ](packages/usdz/README.md),
[glTF Pro](packages/gltf-pro/README.md) and [decoder](packages/decoders/README.md)
guides for API details and supported subsets.
