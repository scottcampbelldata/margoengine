// Every file a package fetches or compiles on its own at runtime, outside the entry an app imports: the stage's lazy
// packs, workers, and Wasm runtimes (ours and the third-party ones a package peers on), with the call that loads each.
// examples/package-benchmarks/entry-sizes.mjs measures them into entry-sizes.json; scripts/build-sizes.js lists them on
// margoengine.com/sizes.html. tests/sizes-page.test.js fails when a built packages/*/dist worker or .wasm is missing here.
//
// `measure`: 'file' = served as is (copied by the bundler as an asset: prebuilt workers, Emscripten glue, .wasm), so the
// bytes on disk are the bytes served; 'bundle' = the app's bundler builds it into its own chunk (a dynamic import, a
// module worker, a peer package), so it is bundled and minified like entry-sizes' entries, with `external` left out.
const core = [/^@margoengine\/core(\/|$)/];

/** @type {{package: string, file: string, label: string, kind: string, measure: 'file' | 'bundle', external?: RegExp[], when: string}[]} */
export const LAZY_FILES = [
  // The stage (`margoengine`): each method imports its pack on first call; core is already loaded with the stage.
  {
    package: 'margoengine',
    file: 'packages/gltf/dist/index.js',
    label: '@margoengine/gltf',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.load()` of a .glb or .gltf URL, first call',
  },
  {
    package: 'margoengine',
    file: 'packages/machinery/dist/cad.js',
    label: '@margoengine/machinery/cad',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.load()` of a .stl, .obj, .step or .iges URL, first call',
  },
  {
    package: 'margoengine',
    file: 'packages/scenery/dist/sky.js',
    label: '@margoengine/scenery/sky',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.sky()`, first call',
  },
  {
    package: 'margoengine',
    file: 'packages/creative/dist/particles.js',
    label: '@margoengine/creative/particles',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.particles()`, first call',
  },
  {
    package: 'margoengine',
    file: 'packages/creative/dist/post.js',
    label: '@margoengine/creative/post',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.effects()`, first call',
  },
  {
    package: 'margoengine',
    file: 'packages/environment/dist/index.js',
    label: '@margoengine/environment',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.environment(url)`, first call',
  },
  {
    package: 'margoengine',
    file: 'packages/shadows/dist/index.js',
    label: '@margoengine/shadows',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`app.shadows()`, first call',
  },
  // CAD import: one worker per import; OCCT only for B-Rep formats.
  {
    package: '@margoengine/machinery',
    file: 'packages/machinery/dist/workers/cad-runtime.js',
    label: 'workers/cad-runtime.js',
    kind: 'Worker',
    measure: 'file',
    when: "Each `loadCAD()` / `parseCADAsync()` (`@margoengine/machinery/cad`, also the stage's `app.load()` of CAD files) where `Worker` exists",
  },
  {
    package: '@margoengine/machinery',
    file: 'packages/machinery/dist/workers/occt-import-js.js',
    label: 'workers/occt-import-js.js',
    kind: 'OCCT glue',
    measure: 'file',
    when: 'STEP or IGES only: the CAD worker imports it before parsing',
  },
  {
    package: '@margoengine/machinery',
    file: 'packages/machinery/dist/workers/occt-import-js.wasm',
    label: 'workers/occt-import-js.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'STEP or IGES only: right after the glue, in the same worker',
  },
  // Draco and KTX2/Basis: a pool of classic workers, each loading the decoder it is asked for once.
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/decoder.worker.js',
    label: 'decoder.worker.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First `DracoDecoder.decode()` or `KTX2Decoder.decode()`: up to `workerLimit` workers, reused until `dispose()`',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/draco/draco_wasm_wrapper.js',
    label: 'draco/draco_wasm_wrapper.js',
    kind: 'Draco glue',
    measure: 'file',
    when: 'First Draco mesh (`KHR_draco_mesh_compression`) a worker decodes, once per worker; `decoderPath` serves it from elsewhere',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/draco/draco_decoder.wasm',
    label: 'draco/draco_decoder.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'With the Draco glue above',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/basis/basis_transcoder.js',
    label: 'basis/basis_transcoder.js',
    kind: 'Basis glue',
    measure: 'file',
    when: 'First KTX2 texture (`KHR_texture_basisu`) a worker transcodes, once per worker; `transcoderPath` serves it from elsewhere',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/basis/basis_transcoder.wasm',
    label: 'basis/basis_transcoder.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'With the Basis glue above',
  },
  // Parser workers: one per call, from each package's `/worker` entry (or progressive loading).
  {
    package: '@margoengine/gltf-pro',
    file: 'packages/gltf-pro/dist/workers/gltf.js',
    label: 'workers/gltf.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Each `loadGLTFInWorker()` / `parseGLTFInWorker()` (`@margoengine/gltf-pro/worker`)',
  },
  {
    package: '@margoengine/gltf-pro',
    file: 'packages/gltf-pro/dist/workers/progressive.js',
    label: 'workers/progressive.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Each `loadGLTFProgressive()` (`@margoengine/gltf-pro/progressive`) where `Worker` exists',
  },
  {
    package: '@margoengine/fbx',
    file: 'packages/fbx/dist/workers/fbx.js',
    label: 'workers/fbx.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Each `loadFBXInWorker()` / `parseFBXInWorker()` (`@margoengine/fbx/worker`)',
  },
  {
    package: '@margoengine/usdz',
    file: 'packages/usdz/dist/workers/usdz.js',
    label: 'workers/usdz.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Each `loadUSDZInWorker()` / `parseUSDInWorker()` (`@margoengine/usdz/worker`)',
  },
  {
    package: '@margoengine/loaders',
    file: 'packages/loaders/dist/workers/usd.js',
    label: 'workers/usd.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Each `parseUSDZInWorker()` / `parseUSDAInWorker()` (`@margoengine/loaders/worker`)',
  },
  {
    package: '@margoengine/bvh',
    file: 'packages/bvh/dist/bvh.worker.js',
    label: 'bvh.worker.js',
    kind: 'Module worker',
    measure: 'bundle',
    external: [],
    when: 'First `buildAsync()` where `Worker` exists; one worker shared until `terminateBVHWorker()`',
  },
  // Third-party Wasm runtimes.
  {
    package: '@margoengine/physics',
    file: 'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs',
    label: '@dimforge/rapier3d-compat',
    kind: 'JS with inlined Wasm',
    measure: 'bundle',
    external: [],
    when: 'Your import of the Rapier peer (no separate .wasm request: the Wasm is base64 in the module); compiled by `await RAPIER.init()` before `new Physics(engine, {rapier})`',
  },
  {
    package: '@margoengine/navigation',
    file: 'node_modules/@recast-navigation/wasm/dist/recast-navigation.wasm-compat.js',
    label: 'recast-navigation (Wasm build)',
    kind: 'JS with inlined Wasm',
    measure: 'bundle',
    external: [],
    when: 'Importing `@margoengine/navigation` (no separate .wasm request: the Wasm is inlined in the module); compiled by the first `Navigation.create()`',
  },
  {
    package: '@margoengine/ifc',
    file: 'node_modules/web-ifc/web-ifc.wasm',
    label: 'web-ifc.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'Your `await api.Init()` on the web-ifc `IfcAPI` you pass to `parseIFC()`, fetched from `api.SetWasmPath()`',
  },
  {
    package: '@margoengine/ifc',
    file: 'node_modules/web-ifc/web-ifc-mt.wasm',
    label: 'web-ifc-mt.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'Instead of web-ifc.wasm when the page is cross-origin isolated (multithreaded build)',
  },
];

/** Built files that load on their own at runtime; each must be in LAZY_FILES. Paths relative to the repository root. */
export const isLazyBuildFile = (path) =>
  /^packages\/[^/]+\/dist\/(.*\.wasm|workers\/[^/]+\.js|[^/]*\.worker\.js|(draco|basis)\/[^/]+\.js)$/.test(path);
