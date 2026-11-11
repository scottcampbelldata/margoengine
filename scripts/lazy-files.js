// Every file a package fetches or compiles on its own at runtime, outside the entry an app imports: the stage's lazy
// packs, workers, and Wasm runtimes (ours and the third-party ones a package peers on), with the call that loads each.
// examples/package-benchmarks/entry-sizes.mjs measures them into entry-sizes.json; scripts/build-sizes.js lists them on
// margoengine.com/sizes.html. tests/sizes-page.test.js fails when a built packages/*/dist worker or .wasm is missing here.
//
// `measure`: 'file' = served as is (copied by the bundler as an asset: prebuilt workers, Emscripten glue, .wasm), so the
// bytes on disk are the bytes served; 'bundle' = the app's bundler builds it into its own chunk (a dynamic import, a
// module worker, a peer package), so it is bundled and minified like entry-sizes' entries, with `external` left out.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const core = [/^@margoengine\/core(\/|$)/];

/** @type {{package: string, file: string, label: string, kind: string, measure: 'file' | 'bundle', external?: RegExp[], when: string}[]} */
export const LAZY_FILES = [
  {
    package: '@margoengine/compute',
    file: 'packages/compute/dist/onnx-kernel.wasm',
    label: 'onnx-kernel.wasm',
    kind: 'Rust SIMD ONNX inference',
    measure: 'file',
    when: 'loadOnnx(), only from the optional /onnx entry; one isolated instance per model',
  },
  {
    package: '@margoengine/compute',
    file: 'packages/compute/dist/cpu-kernel.wasm',
    label: 'cpu-kernel.wasm',
    kind: 'Rust SIMD CPU backend',
    measure: 'file',
    when: 'createCpuWasm(), only from the optional /cpu-wasm entry; one isolated instance per context',
  },
  {
    package: '@margoengine/compute',
    file: 'packages/compute/dist/decomp-kernel.wasm',
    label: 'decomp-kernel.wasm',
    kind: 'Rust SIMD dense decompositions',
    measure: 'file',
    when: 'solve, inv, det, cholesky, qr, svd or eigh, only from the optional /decomp entry; per-call instance',
  },
  {
    package: '@margoengine/ecs',
    file: 'packages/ecs/dist/workers/parallel.js',
    label: 'workers/parallel.js',
    kind: 'Shared numeric component worker',
    measure: 'file',
    when: 'ParallelSchedule updates, only from ecs/parallel with the default browser worker factory',
  },
  {
    package: '@margoengine/navmesh',
    file: 'packages/navmesh/dist/navmesh-raster.wasm',
    label: 'navmesh-raster.wasm',
    kind: 'Rust SIMD rasterization',
    measure: 'file',
    when: 'Optional navmesh rasterization kernel on its supported build route',
  },
  {
    package: '@margoengine/navmesh',
    file: 'packages/navmesh/dist/workers/navmesh-build.js',
    label: 'workers/navmesh-build.js',
    kind: 'Navmesh builder worker',
    measure: 'file',
    when: 'Optional asynchronous navmesh worker builds with the default browser worker factory',
  },
  {
    package: '@margoengine/worker',
    file: 'packages/worker/dist/workers/scene.js',
    label: 'workers/scene.js',
    kind: 'Offscreen scene worker',
    measure: 'file',
    when: 'runScene(), only from worker/auto when the worker route is selected',
  },
  {
    package: '@margoengine/sciviz',
    file: 'packages/sciviz/dist/flow.wasm',
    label: 'flow.wasm',
    kind: 'Rust physical-time pathline integration',
    measure: 'file',
    when: '`tracePathline()`, only from the optional /flow entry; a fresh feature-local instance per call',
  },
  {
    package: '@margoengine/sciviz',
    file: 'packages/sciviz/dist/fallback.wasm',
    label: 'fallback.wasm',
    kind: 'Rust SIMD marching cubes',
    measure: 'file',
    when: '`marchingCubes()`, only from the optional /fallback entry; no device or global installation',
  },
  {
    package: '@margoengine/sciviz',
    file: 'packages/sciviz/dist/workers/readers.js',
    label: 'workers/readers.js',
    kind: 'Scientific reader session worker',
    measure: 'file',
    when: 'readInWorker(), only from sciviz/workers; one owned worker per reader session, terminated on cancellation or disposal',
  },
  {
    package: '@margoengine/voxel-pathtracer',
    file: 'packages/voxel-pathtracer/dist/mesh.wasm',
    label: 'mesh.wasm',
    kind: 'Rust SIMD geometry builder',
    measure: 'file',
    when: 'MeshPathTracer.create() and setScene(), only from the optional /mesh entry; never loaded by the root tracer',
  },
  {
    package: '@margoengine/wfc',
    file: 'packages/wfc/dist/workers/wfc.js',
    label: 'workers/wfc.js',
    kind: 'Classic solve worker',
    measure: 'file',
    when: 'Each WFCWorkerSolve constructor, only from the optional /worker entry; Wasm is fetched in the worker only when eligible',
  },
  {
    package: '@margoengine/wfc',
    file: 'packages/wfc/dist/wfc.wasm',
    label: 'wfc.wasm',
    kind: 'Wasm SIMD solver',
    measure: 'file',
    when: 'First eligible `HeapWFC.create()` or `ChunkedWFC.solveChunk()`: at most 32 unit-weight tiles, unless backend is typescript',
  },
  {
    package: '@margoengine/procedural',
    file: 'packages/procedural/dist/caves.wasm',
    label: 'caves.wasm',
    kind: 'Rust Wasm cellular automata',
    measure: 'file',
    when: '`createCaveGenerator()`, only from the optional /caves entry',
  },
  {
    package: '@margoengine/procedural',
    file: 'packages/procedural/dist/buildings.wasm',
    label: 'buildings.wasm',
    kind: 'Rust Wasm building split grammar',
    measure: 'file',
    when: '`createBuildingGenerator()`, only from the optional /buildings entry',
  },
  {
    package: '@margoengine/procedural',
    file: 'packages/procedural/dist/sdf.wasm',
    label: 'sdf.wasm',
    kind: 'Rust Wasm dual contouring',
    measure: 'file',
    when: '`createSdfModeler()`, only from the optional /sdf entry',
  },
  {
    package: '@margoengine/procedural',
    file: 'packages/procedural/dist/trees.wasm',
    label: 'trees.wasm',
    kind: 'Rust Wasm space-colonisation skeletons',
    measure: 'file',
    when: '`createTreeGenerator()`, only from the optional /trees entry',
  },
  {
    package: '@margoengine/procedural',
    file: 'packages/procedural/dist/dungeon.wasm',
    label: 'dungeon.wasm',
    kind: 'Rust Wasm BSP layouts',
    measure: 'file',
    when: '`createDungeonGenerator()`, only from the optional /dungeon entry',
  },
  {
    package: '@margoengine/procedural',
    file: 'packages/procedural/dist/poisson.wasm',
    label: 'poisson.wasm',
    kind: 'Rust Wasm sampler',
    measure: 'file',
    when: '`createPoissonSampler()`, only from the optional /poisson entry',
  },
  // The stage (`margoengine`): each method imports its pack on first call; core is already loaded with the stage.
  {
    package: 'margoengine',
    file: 'packages/gltf/dist/index.js',
    label: '@margoengine/gltf',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addGLTF(stage, url)` (`margoengine/stage/gltf`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/scenery/dist/sky.js',
    label: '@margoengine/scenery/sky',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addSky(stage)` (`margoengine/stage/sky`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/creative/dist/particles.js',
    label: '@margoengine/creative/particles',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addParticles(stage)` (`margoengine/stage/particles`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/creative/dist/post.js',
    label: '@margoengine/creative/post',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addEffects(stage)` (`margoengine/stage/effects`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/environment/dist/index.js',
    label: '@margoengine/environment',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addEnvironment(stage, url)` (`margoengine/stage/environment`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/shadows/dist/index.js',
    label: '@margoengine/shadows',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addShadows(stage)` (`margoengine/stage/shadows`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/xr/dist/index.js',
    label: '@margoengine/xr',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addXRButton(stage)` (`margoengine/stage/xr`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/gltf-pro/dist/index.js',
    label: '@margoengine/gltf-pro',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addViewer(stage, url)` (`margoengine/stage/viewer`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/staging/dist/index.js',
    label: '@margoengine/staging',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addViewer(stage, url)` (`margoengine/stage/viewer`), first call with contact shadows',
  },
  {
    package: 'margoengine',
    file: 'packages/tonemap/dist/index.js',
    label: '@margoengine/tonemap',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addViewer(stage, url)` (`margoengine/stage/viewer`), first call with tone mapping',
  },
  {
    package: 'margoengine',
    file: 'packages/physics/dist/index.js',
    label: '@margoengine/physics',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addPhysics(stage)` or `addBody(stage, mesh)` (`margoengine/stage/physics`), first call',
  },
  {
    package: 'margoengine',
    file: 'packages/save/dist/index.js',
    label: '@margoengine/save',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`addScene(stage, source)` (`margoengine/stage/scene`), first call',
  },
  // Draco and KTX2/Basis: a pool of classic workers, each loading the decoder it is asked for once.
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/draco-native.worker.js',
    label: 'draco-native.worker.js',
    kind: 'Classic clean-room decode worker',
    measure: 'file',
    when: 'First decode on each worker, only from the optional @margoengine/decoders/draco-native entry',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/draco-native.wasm',
    label: 'draco-native.wasm',
    kind: 'Rust clean-room Draco decoder',
    measure: 'file',
    when: 'First mesh or point decode in each optional Draco worker; one module contains both flavors',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/decoder.worker.js',
    label: 'decoder.worker.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First `DracoDecoder.decode()`, `DracoPointsDecoder.decode()` or `KTX2Decoder.decode()`: up to `workerLimit` workers, reused until `dispose()`',
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
    file: 'packages/decoders/dist/draco-full/draco_wasm_wrapper.js',
    label: 'draco-full/draco_wasm_wrapper.js',
    kind: 'Draco glue',
    measure: 'file',
    when: 'First point cloud a `DracoPointsDecoder` worker decodes, once per worker; `decoderPath` serves it from elsewhere',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/draco-full/draco_decoder.wasm',
    label: 'draco-full/draco_decoder.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'With the full Draco glue above',
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
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/jxl.worker.js',
    label: 'jxl.worker.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First `JXLDecoder.decode()` the browser cannot read itself: up to `workerLimit` workers, reused until `dispose()`',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/jxl/jxl_oxide_wasm.js',
    label: 'jxl/jxl_oxide_wasm.js',
    kind: 'JPEG XL glue',
    measure: 'file',
    when: 'With the JPEG XL worker above, once per worker; `decoderPath` serves it from elsewhere',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/jxl/jxl_oxide_wasm_bg.wasm',
    label: 'jxl/jxl_oxide_wasm_bg.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'With the JPEG XL glue above',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/hdr6.worker.js',
    label: 'hdr6.worker.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First `KTX2HDR6Decoder.decode()`: up to `workerLimit` workers, reused until `dispose()`',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/avif.worker.js',
    label: 'avif.worker.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First AVIFDecoder.decode(): browser or Node module worker, retained until dispose()',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/avif.wasm',
    label: 'avif.wasm',
    kind: 'Rust SIMD AV1 still-image decoder',
    measure: 'file',
    when: 'With the AVIF worker above, once per worker; decoderPath can relocate the asset',
  },
  {
    package: '@margoengine/decoders',
    file: 'packages/decoders/dist/hdr6.wasm',
    label: 'hdr6.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'With the HDR 6x6 worker above, once per worker; `decoderPath` serves it from elsewhere',
  },
  {
    package: '@margoengine/exporters',
    file: 'packages/exporters/dist/encoder.worker.js',
    label: 'encoder.worker.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First `compressDraco()` or `compressTextures()` in a browser: one worker per call, ended when the call finishes',
  },
  {
    package: '@margoengine/exporters',
    file: 'packages/exporters/dist/basis-encoder/margo_basis_encoder.wasm',
    label: 'basis-encoder/margo_basis_encoder.wasm',
    kind: 'Rust SIMD ETC1S/UASTC encoder',
    measure: 'file',
    when: 'First default encodeKTX2 or compressTextures call from the optional ktx2 entry',
  },
  {
    package: '@margoengine/exporters',
    file: 'packages/exporters/dist/draco-native-encoder.wasm',
    label: 'draco-native-encoder.wasm',
    kind: 'Clean-room Draco encoder Wasm',
    measure: 'file',
    when: 'First compressDraco call; one lazy SIMD module in its browser worker or the Node process',
  },
  // The environment's image decoders (EXR, Radiance HDR, UltraHDR): the root re-exports them, and an app that names
  // none of them gets them as a chunk on its first URL load.
  {
    package: '@margoengine/environment',
    file: 'packages/environment/dist/loaders.js',
    label: 'loaders.js',
    kind: 'Chunk',
    measure: 'bundle',
    external: core,
    when: '`EnvironmentLighting.load(engine, url)` with a URL, first call (an app that imports no decoder itself)',
  },
  // The OpenEXR codec set of `@margoengine/environment/exr-codecs` (prebuilt OpenEXR Wasm, THIRD-PARTY-NOTICES.md).
  {
    package: '@margoengine/environment',
    file: 'packages/environment/dist/workers/exr-codecs.js',
    label: 'workers/exr-codecs.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Each `decodeEXR()` / `loadEXR()` of `@margoengine/environment/exr-codecs`: one worker per call',
  },
  {
    package: '@margoengine/environment',
    file: 'packages/environment/dist/vendor/exr-codecs/exrview.mjs',
    label: 'vendor/exr-codecs/exrview.mjs',
    kind: 'OpenEXR glue',
    measure: 'file',
    when: 'With the EXR codec worker above, in a browser',
  },
  {
    package: '@margoengine/environment',
    file: 'packages/environment/dist/vendor/exr-codecs/exrview.cjs',
    label: 'vendor/exr-codecs/exrview.cjs',
    kind: 'OpenEXR glue',
    measure: 'file',
    when: 'With the EXR codec worker above, in Node (loaded through createRequire)',
  },
  {
    package: '@margoengine/environment',
    file: 'packages/environment/dist/vendor/exr-codecs/exrview.wasm',
    label: 'vendor/exr-codecs/exrview.wasm',
    kind: 'Wasm',
    measure: 'file',
    when: 'With the OpenEXR glue above',
  },
  // Parser workers: one per call, from each package's `/worker` entry (or progressive loading).
  // Draco and KTX2 are not inside these scripts. A compressed file is handed back to the owning thread,
  // which uses @margoengine/decoders' own worker and Wasm.
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
  {
    package: '@margoengine/bvh',
    file: 'packages/bvh/dist/parallel.worker.js',
    label: 'parallel.worker.js',
    kind: 'Module coordinator worker',
    measure: 'bundle',
    external: [],
    when: 'buildParallel(), only from bvh/parallel; one coordinator per build',
  },
  {
    package: '@margoengine/bvh',
    file: 'packages/bvh/dist/parallel-leaf.worker.js',
    label: 'parallel-leaf.worker.js',
    kind: 'Module leaf worker',
    measure: 'bundle',
    external: [],
    when: 'The coordinator of buildParallel() starts its leaf worker pool',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/workers/biomes.js',
    label: 'workers/biomes.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First tile, placement or view job of a `BiomeWorld` with workers (the default in browsers): up to `workers` workers, each a replica of the world, reused until `dispose()`',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/erosion.wasm',
    label: 'erosion.wasm',
    kind: 'Rust SIMD ordered erosion',
    measure: 'file',
    when: 'createErosionKernel(), only from biomes/erosion-wasm; no renderer or worker required',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/workers/biomes-splines.js',
    label: 'workers/biomes-splines.js',
    kind: 'Worker part',
    measure: 'file',
    when: 'Each biome worker of a world with carved paths (`height: { carve }`), once, by `importScripts` (a world without it never loads the file)',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/workers/biomes-erosion.js',
    label: 'workers/biomes-erosion.js',
    kind: 'Worker part',
    measure: 'file',
    when: 'Each biome worker of a relief world with `erosion`, once, by `importScripts` (a world without it never loads the file)',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/workers/biomes-graph.js',
    label: 'workers/biomes-graph.js',
    kind: 'Worker part',
    measure: 'file',
    when: 'Each biome worker of a placement with a `graph`, once, by `importScripts` (a world without it never loads the file)',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/workers/biomes-zones.js',
    label: 'workers/biomes-zones.js',
    kind: 'Worker part',
    measure: 'file',
    when: 'Each biome worker of a world with the Whittaker or Holdridge classifier, once, by `importScripts` (a world without it never loads the file)',
  },
  {
    package: '@margoengine/biomes',
    file: 'packages/biomes/dist/workers/biomes-multinoise.js',
    label: 'workers/biomes-multinoise.js',
    kind: 'Worker part',
    measure: 'file',
    when: 'Each biome worker of a world with a multi-noise classifier, once, by `importScripts` (a world without it never loads the file)',
  },
  {
    package: '@margoengine/voxel',
    file: 'packages/voxel/dist/workers/light.js',
    label: 'workers/light.js',
    kind: 'Worker',
    measure: 'file',
    when: 'Creating a `VoxelLightWorker` (`@margoengine/voxel/light-worker`): one worker holding a copy of the world, until `dispose()`',
  },
  {
    package: '@margoengine/voxel',
    file: 'packages/voxel/dist/workers/mesher.js',
    label: 'workers/mesher.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First `VoxelMesher.mesh()` calls (`@margoengine/voxel/mesher`): up to `workers` workers, reused until `dispose()`',
  },
  {
    package: '@margoengine/voxel',
    file: 'packages/voxel/dist/workers/terrain.js',
    label: 'workers/terrain.js',
    kind: 'Worker',
    measure: 'file',
    when: 'First chunks a `VoxelStreamer` with `generator: NoiseTerrainOptions` generates (`@margoengine/voxel/stream`): up to `workers` workers, reused until `dispose()`',
  },
  // Third-party Wasm runtimes.
  {
    package: '@margoengine/physics',
    file: 'packages/physics/dist/rapier3d.wasm',
    label: 'rapier3d.wasm',
    kind: 'Rapier Wasm (@dimforge/rapier3d, bundled)',
    measure: 'file',
    when: '`await Physics.load()`, once per app, compiled while it downloads; its JavaScript is the lazy rapier-solver chunk of the entry',
  },
];

/**
 * Entries whose bundle has a lazy part inside it: a chunk its own `import()` loads only when a feature is used. The
 * size records and the sizes gate measure the entry in two numbers, `base` (every chunk the entry loads without that
 * chunk, `install()`-style first calls included) and the lazy chunk alone, so a lazy runtime is not billed to the
 * apps that never use it. `chunk` matches the lazy chunk's built file name (rollup hashes it); the lazy boundary is
 * checked at the source by tests/lazy-boundary.test.js. `baseTarget` is the base's gzip limit (Scott, 2026-10-30: 73,000 B, an accepted difference), enforced by the sizes
 * baseline.
 * @type {{package: string, entry: string, specifier: string, dist: string, chunk: RegExp, lazyLabel: string, source: string, baseTarget: number, when: string}[]}
 */
export const LAZY_SPLITS = [
  {
    package: 'webgl2-compat',
    entry: '.',
    specifier: '@margoengine/webgl2-compat',
    dist: 'packages/webgl2-compat/dist/index.js',
    chunk: /^(runtime|readback)-/,
    lazyLabel: 'compute runtime and read-back',
    source: 'packages/webgl2-compat/src/compute/runtime.ts',
    baseLabel: 'everything the first call of <code>install()</code> loads',
    baseTarget: 73_000,
    when: 'the first compute pipeline or texture read-back on the layer (import() in device/device.ts)',
  },
  {
    package: 'points',
    entry: './las',
    specifier: '@margoengine/points/las',
    dist: 'packages/points/dist/las.js',
    chunk: /^laz-/,
    lazyLabel: 'LAZ decoder',
    source: 'packages/points/src/laz.ts',
    baseLabel: 'everything a plain <code>.las</code> file loads',
    when: 'the first compressed file, unless the caller passes its own decoder (import() in las.ts)',
  },
  {
    package: 'physics',
    entry: '.',
    specifier: '@margoengine/physics',
    dist: 'packages/physics/dist/index.js',
    chunk: /^rapier-solver-/,
    lazyLabel: 'Rapier solver JavaScript',
    source: 'packages/physics/src/rapier-solver.ts',
    baseLabel: 'everything the entry loads before <code>Physics.load()</code>',
    when: '`await Physics.load()`, once per app (import() in physics.ts); its Wasm, rapier3d.wasm, is a file of its own',
  },
];

/** Built files that load on their own at runtime; each must be in LAZY_FILES. Paths relative to the repository root. */
export const isLazyBuildFile = (path) =>
  /^packages\/[^/]+\/dist\/(.*\.wasm|workers\/[^/]+\.js|[^/]*\.worker\.js|(draco|draco-full|draco-encoder|basis|basis-encoder|jxl)\/[^/]+\.js)$/.test(
    path,
  );

// `new URL('./file', import.meta.url)` in built code: how a package reaches a file it loads on its own.
const ASSET_URL = /new URL\(\s*["'`](\.{1,2}\/[^"'`?#$]+)[^"'`]*["'`]\s*,\s*import\.meta\.url\s*\)/g;

/**
 * How the built packages under `root` and `list` disagree: `unlisted` are built files that load on their own (by name,
 * isLazyBuildFile, or because built code reaches them with `new URL(..., import.meta.url)`) but have no row; `unbuilt`
 * are rows of that kind whose file was not built. The margoengine umbrella only re-exports, so it is left out.
 *
 * Bug (2026-11-10): 9de13807a added hdr6.worker.js and hdr6.wasm to @margoengine/decoders without rows, and main's
 * tests/sizes-page.test.js failed for hours because no gate a lane runs before a push looked. `npm run quality` (sizes
 * gate) now fails on any drift, so a new lazy file cannot land unlisted.
 */
export function lazyFileDrift(root, list = LAZY_FILES) {
  const built = [],
    reached = new Set();
  for (const id of readdirSync(join(root, 'packages')).sort()) {
    const dist = `packages/${id}/dist`;
    if (id === 'margoengine' || !existsSync(join(root, dist))) continue;
    for (const name of readdirSync(join(root, dist), { recursive: true })) {
      const file = `${dist}/${String(name).split('\\').join('/')}`;
      built.push(file);
      if (!/\.m?js$/.test(file)) continue;
      for (const [, target] of readFileSync(join(root, file), 'utf8').matchAll(ASSET_URL)) {
        const path = posix.normalize(posix.join(posix.dirname(file), target));
        if (path.startsWith(`${dist}/`) && existsSync(join(root, path))) reached.add(path);
      }
    }
  }
  const listed = new Set(list.map((entry) => entry.file)),
    lazy = new Set([...built.filter(isLazyBuildFile), ...reached]);
  return {
    unlisted: [...lazy].filter((file) => !listed.has(file)).sort(),
    unbuilt: [...listed].filter((file) => isLazyBuildFile(file) && !built.includes(file)).sort(),
  };
}

/** Rows of `list` with no measurement in `root`'s committed entry-sizes.json (the sizes page refuses to build then). */
export function unmeasuredLazyFiles(root, list = LAZY_FILES) {
  const record = join(root, 'examples/package-benchmarks/results/entry-sizes.json');
  const measured = existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')).lazyFiles ?? {}) : {};
  return list.filter((entry) => !measured[entry.file]).map((entry) => entry.file);
}
