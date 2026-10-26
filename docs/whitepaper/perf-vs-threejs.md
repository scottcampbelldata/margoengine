# Margo against three.js, row by row

**Diagnostic, busy machine, not for publication.** These numbers come from a shared PC that also runs builds and
other agents. Public claims wait for the quiet-machine run (HANDOFF item 36).

This page keeps every first-run result, losses included, and never overwrites one (Scott, 2026-10-25). When a row
is fixed later, its after numbers appear next to the before, with the cause, the trade-off, the fix commit and the
rerun command. Rows still slower stay listed and link to their known-bugs entry. `bench/parity-report.mjs` renders
this page from the ledger `perf-vs-threejs.json` next to it, which every run adds to.

First run: `20261025-132015-d3fec42e-dev`. Latest run added: `20261026-203857-67216c40-dev` (valid). Engines: `margo` 1.0.0, `three-webgpu-parity` 0.186.1, `three-webgl-parity` 0.186.1. Machine: , ; browser 156.0.4314.42. 5 runs per case (1 warm-up), 300 frames, interleaved per scene. This run's matrix took 0.3 min.

Rerun:

```sh
npm run build:packages
npm run bench:parity
```

How a row is judged: each scene runs the same job in Margo and in both three.js backends in `engine-bench`
(`three-webgpu-parity`, `three-webgl-parity`), and Margo is compared with the faster one. Frame scenes compare CPU and
GPU ms per frame, task scenes the ms per call. A metric is better or worse when it differs by more than 5% and more than
the spread of either engine. A scene is slower if any metric is worse, faster if one is better and none is worse, and
equal otherwise. A row is slower if any of its scenes is. Image match: SSIM of the luminance >= 0.9 and mean delta E
<= 6 between the Margo and three.js screenshots. Feature JS is the gzip bytes of the scripts that only that engine
fetched for the scene.

## Counts

| Verdict | First run | Now |
| --- | --- | --- |
| faster | 61 | 80 |
| no workload | 9 | 9 |
| slower | 73 | 51 |
| Margo missing | 8 | 8 |
| no three.js equivalent | 3 | 3 |
| equal | 3 | 6 |
| error | 1 | 1 |
| not run | 1 | 1 |
| three missing | 2 | 2 |
| total | 161 | 161 |

## Worst gaps now

| Scene | Rows | Margo / three (worst primary metric) | Cause |
| --- | --- | --- | --- |
| `helmet` | 9.3 | 9.22x | p-pmrem: not diagnosed yet. helmet, measured (timestamps per pass with each feature switched off): IBL costs nothing measurable; Margo's default shadow filter, PCSS ('soft': 16 blocker reads and 32 comparison taps per lit pixel, spread over a penumbra up to a tenth of the map), is 0.68 of helmet's 0.78 ms GPU, where three's side draws one PCFSoftShadowMap. With the closest setup (helmet-filterpcf-cascades1: filter 'pcf', 1 cascade) Margo draws in 0.08 ms GPU against three's WebGL 0.09 and WebGPU 0.07, the same image (SSIM 0.984); still slower on CPU, 0.11 against 0.07 ms (CPU profile: spread over the frame's four passes, shadow map, core meshes, the model and the MSAA resolve, with core's render the largest share). [known bug](../known-bugs.md#scifihelmet-default-soft-shadows-cost-the-gpu-time) |
| `p-morph` | 12.5 | 8.71x | 100 morphed copies each began a render pass and a compute pass, and every draw rebuilt its shader text each frame; models now draw as one run, Animations deform in one compute pass and the shader text steps are memoised. Still slower: that pass holds 200 dispatches (2 primitives x 100 copies, 150,000 vertices in all), each writing its own output buffer, and they run one after another (1.18 ms GPU); three morphs in each draw's vertex shader. [known bug](../known-bugs.md#morph-targets-one-compute-dispatch-per-primitive). fixed in 63a7edec (trade-off: models share a run only when their passes were added back to back; others draw alone as before), rerun `npm run bench -- parity --cases=p-morph --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| `p-export-usdz` | 11.3 | 6.42x | Before: num() tried toPrecision(1..9) for every number (75% of the time) and CRC-32 ran a byte at a time. Now a binary search with a value cache and slicing-by-8: 52.8 -> 16.0 ms, byte-identical archive. The rest is different output: Margo writes every mesh in world space (2.46 MB for 1,000 boxes), three's archive is 444 KB, so it writes far fewer numbers. Closing it means writing a shared mesh once with per-node transforms, an exporter format change left for a decision. [known bug](../known-bugs.md#usdz-export-writes-every-mesh-in-world-space). fixed in b30af0b8 (trade-off: +500 B gzip on exporters/usdz), rerun `node bench/cli.mjs parity --cases=p-export-usdz --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| `p-motion-blur` | 13.17 | 5.55x | not diagnosed yet |
| `p-gpu-pick` | 16.2 | 5.37x | core GPURenderer.pick compiled a shader module and pipeline on every call and rewrote every instance (960 KB for 10,000 boxes); both fixed. Still slower, measured (CPU profile: 0.15 ms of JS a pick, the main thread idle the rest): each pick waits for its own GPU pass and mapAsync readback, about 3.1 ms here, and engine.pick answers overlapping calls one at a time by contract (each reads the scene when its turn comes). three's WebGL readRenderTargetPixels is a synchronous readPixels; three's WebGPU readback is slower than Margo's (423 ms). [known bug](../known-bugs.md#gpu-picking-waits-for-one-readback-per-pick). fixed in 2d541368 (trade-off: pick pipelines count toward the 64 cached shader variants), rerun `npm run bench -- parity --cases=p-gpu-pick --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| `p-node-material` | 2.6 | 5.26x | not diagnosed yet |
| `p-export-exr` | 11.4 | 4.32x | not diagnosed yet |
| `p-custom-shader` | 2.5 | 3.32x | not diagnosed yet |
| `p-pmrem` | 9.3 | 3.19x | p-pmrem: not diagnosed yet. helmet, measured (timestamps per pass with each feature switched off): IBL costs nothing measurable; Margo's default shadow filter, PCSS ('soft': 16 blocker reads and 32 comparison taps per lit pixel, spread over a penumbra up to a tenth of the map), is 0.68 of helmet's 0.78 ms GPU, where three's side draws one PCFSoftShadowMap. With the closest setup (helmet-filterpcf-cascades1: filter 'pcf', 1 cascade) Margo draws in 0.08 ms GPU against three's WebGL 0.09 and WebGPU 0.07, the same image (SSIM 0.984); still slower on CPU, 0.11 against 0.07 ms (CPU profile: spread over the frame's four passes, shadow map, core meshes, the model and the MSAA resolve, with core's render the largest share). [known bug](../known-bugs.md#scifihelmet-default-soft-shadows-cost-the-gpu-time) |
| `p-gltf-parse` | 10.1 | 3.18x | not diagnosed yet |
| `p-gltf-animated` | 10.2 | 3.17x | not diagnosed yet |
| `p-rect-area` | 7.6 | 3.16x | not diagnosed yet |
| `p-fbx` | 10.8 | 3.08x | not diagnosed yet |
| `p-text` | 4.6 | 2.97x | not diagnosed yet |
| `p-crossfade-100` | 12.2 | 2.66x | not diagnosed yet |

## Every row

| Row | Feature | First run | Now | Scenes | Cause, fix or note |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Object3D transforms and hierarchy (position, rotation, quaternion, scale, parent | faster | faster | `p-hierarchy` |  |
| 1.2 | Group (transform-only node) | faster | faster | `p-hierarchy` |  |
| 1.3 | Scene object, multiple scenes | faster | faster | `p-scenes` |  |
| 1.4 | `scene.background` (color, texture, cubemap) | faster | faster | `p-background` |  |
| 1.5 | Transparent canvas (`alpha: true`) | faster | faster | `p-alpha` |  |
| 1.6 | Frustum culling | faster | faster | `p-culling` |  |
| 1.7 | Render loop, Clock/Timer | no workload | no workload |  | covered: the render loop is every frame scene (rAF-driven, harness.js); Clock/Timer has no workload |
| 1.8 | Layers | faster | faster | `p-layers` |  |
| 1.9 | Math library (Vector3, Matrix4, Quaternion, Euler, Box3, Sphere, Ray, Plane, Fru | slower | slower | `p-math` |  |
| 2.1 | WebGPU renderer | faster | faster | `boxes-10000` |  |
| 2.2 | WebGL2 fallback (WebGLRenderer, WebGPURenderer's WebGL2 backend) | faster | faster | `p-webgl2` |  |
| 2.3 | MSAA | faster | faster | `p-msaa-samples1` `p-msaa` |  |
| 2.4 | Reversed-Z / logarithmic depth | faster | faster | `p-depth-range` |  |
| 2.5 | ShaderMaterial, RawShaderMaterial, onBeforeCompile | slower | slower | `p-custom-shader` |  |
| 2.6 | Node materials / TSL | slower | slower | `p-node-material` |  |
| 2.7 | Compute (TSL compute, GPUComputationRenderer) | Margo missing | Margo missing | `p-compute-262144` |  |
| 2.8 | Render targets / render-to-texture | faster | faster | `p-render-target` |  |
| 2.9 | Multiple render targets (MRT) | slower | slower | `p-mrt` |  |
| 2.10 | Clipping planes | slower | equal | `p-clipping` |  |
| 2.11 | Stats, GPU timing | no workload | no workload |  | no workload: stats and GPU timing report on other work (the harness times every pass itself) |
| 2.12 | Multiple viewports / scissor | faster | faster | `boxes-10000-views4` |  |
| 3.1 | PerspectiveCamera | faster | faster | `boxes-10000` |  |
| 3.2 | OrthographicCamera | faster | faster | `p-ortho` |  |
| 3.3 | ArrayCamera | faster | faster | `boxes-10000-views4` |  |
| 3.4 | CubeCamera (dynamic environment maps) | faster | faster | `p-cube-camera` |  |
| 3.5 | StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | Margo missing | Margo missing |  | Margo missing (stereo and anaglyph cameras are a documented limit) |
| 4.1 | Built-in primitives (Box, Capsule, Circle, Cone, Cylinder, polyhedra, Plane, Rin | slower | slower | `p-primitives` |  |
| 4.2 | Shape, Path, curves, Extrude, Lathe, Tube | slower | slower | `p-extrude` |  |
| 4.3 | EdgesGeometry, WireframeGeometry | faster | faster | `p-edges` |  |
| 4.4 | BufferGeometry custom attributes (uv, uv1, color, tangent) on drawable meshes | slower | faster | `p-attributes` |  |
| 4.5 | BufferGeometryUtils (merge, mergeVertices, toNonIndexed, computeTangents, comput | slower | slower | `p-geometry-utils` |  |
| 4.6 | TextGeometry, FontLoader, TTFLoader | slower | slower | `p-text` |  |
| 4.7 | ConvexGeometry, DecalGeometry, RoundedBoxGeometry, ParametricGeometry | slower | slower | `p-geometry-misc` |  |
| 5.1 | MeshStandardMaterial, constant factors | faster | faster | `materials-4096` |  |
| 5.2 | MeshStandardMaterial with maps (map, normalMap, roughness/metalness map, aoMap,  | slower | faster | `p-maps` |  |
| 5.3 | MeshPhysicalMaterial (clearcoat, sheen, transmission, iridescence, anisotropy, I | slower | slower | `p-physical` `p-transmission` |  |
| 5.4 | MeshBasicMaterial (unlit) | slower | faster | `p-unlit` |  |
| 5.5 | MeshLambertMaterial, MeshPhongMaterial | slower | faster | `p-lambert` `p-phong` |  |
| 5.6 | MeshToonMaterial | slower | faster | `p-toon` |  |
| 5.7 | MeshMatcapMaterial | slower | faster | `p-matcap` |  |
| 5.8 | MeshNormalMaterial, MeshDepthMaterial, MeshDistanceMaterial | slower | faster | `p-normal-material` `p-depth-material` |  |
| 5.9 | ShadowMaterial (shadow catcher) | faster | faster | `p-shadow-catcher` |  |
| 5.10 | PointsMaterial, SpriteMaterial | slower | slower | `p-points-1000000` `p-sprites` |  |
| 5.11 | LineBasicMaterial, LineDashedMaterial, Line2's LineMaterial | slower | slower | `p-lines` |  |
| 5.12 | Transparency, alpha blending, alphaTest | slower | faster | `p-transparency` `p-alpha-test` |  |
| 5.13 | Order-independent transparency (three.js has none built in; its examples sort pe | no three.js equivalent | no three.js equivalent |  | no three.js equivalent (three.js has no built-in order-independent transparency) |
| 5.14 | Vertex colors | slower | faster | `p-attributes` |  |
| 5.15 | `side` (Front, Back, Double) | slower | faster | `p-double-sided` |  |
| 5.16 | Wireframe | slower | faster | `p-wireframe` |  |
| 5.17 | Per-material blending modes, depthTest, depthWrite, polygonOffset, renderOrder,  | slower | faster | `p-blending` |  |
| 6.1 | Texture, TextureLoader on arbitrary meshes | slower | slower | `p-texture-decode` `p-maps` |  |
| 6.2 | CubeTexture, CubeTextureLoader | faster | faster | `p-background` |  |
| 6.3 | DataTexture, Data3DTexture, DataArrayTexture | slower | slower | `p-data-texture` |  |
| 6.4 | CompressedTexture (KTX2/Basis) | equal | equal | `p-ktx2` |  |
| 6.5 | VideoTexture, VideoFrameTexture | slower | faster | `p-video` | Before: about 10 us of CPU per materials mesh per frame (1,000 boxes), not the video upload. Fixed by the materials draw-path work (runs, instancing, reused steady materials) through b89ac9c1, with no change of its own; rerun 20261026-165034 shows 0.46 ms CPU against three-webgl 0.75. The image differs only because the video plays in real time (SSIM 0.93). fixed in b89ac9c1, rerun `node bench/cli.mjs parity --cases=p-video --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| 6.6 | CanvasTexture | slower | faster | `p-canvas-texture` | Before: about 15 us of CPU per materials mesh per frame (1,000 boxes), not the canvas upload. Fixed by the materials draw-path work through b89ac9c1, with no change of its own; rerun 20261026-165034 shows 0.34 ms CPU against three-webgpu 1.98. fixed in b89ac9c1, rerun `node bench/cli.mjs parity --cases=p-canvas-texture --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| 6.7 | Texture `offset` / `repeat` / `rotation` / `center`, texture atlases | slower | faster | `p-uv-transform` |  |
| 6.8 | DepthTexture | faster | faster | `p-depth-texture` |  |
| 6.9 | Mipmaps, wrapping, filtering | equal | equal | `p-mipmaps` |  |
| 7.1 | AmbientLight | faster | faster | `p-ambient` |  |
| 7.2 | HemisphereLight | faster | faster | `p-hemisphere` |  |
| 7.3 | DirectionalLight | faster | faster | `boxes-10000` |  |
| 7.4 | PointLight | faster | faster | `lights-1000` |  |
| 7.5 | SpotLight | faster | faster | `p-spot` |  |
| 7.6 | RectAreaLight | slower | slower | `p-rect-area` |  |
| 7.7 | LightProbe | Margo missing | Margo missing | `p-light-probe` |  |
| 7.8 | IESSpotLight, ProjectorLight | slower | slower | `p-ies` |  |
| 7.9 | Physical light units (candela, lux) | no workload | no workload |  | no workload: light units are a scale on intensity |
| 8.1 | Directional light shadows (incl. CSM add-on, PCF/PCFSoft) | faster | faster | `p-csm` `shadows-1000` |  |
| 8.2 | PointLight shadows | slower | faster | `p-point-shadows` | LocalShadows drew all 1,001 casters into each of the 24 cube faces (24,000 draws a frame) and wrote every caster block each frame; casters now draw only into maps whose frustum their bounding sphere reaches and write their block only when moved. fixed in 8149bf4e (trade-off: a sphere test per caster per map; casters without bounds (instanced, displaced, or external primitives that give none) still draw into every map), rerun `npm run bench -- parity --cases=p-point-shadows --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 8.3 | SpotLight shadows | faster | faster | `p-spot-shadows` |  |
| 9.1 | HDRLoader / RGBELoader | slower | faster | `p-hdr-load` | Uploading a Float32Array as rgba16float converted it with Uint16Array.from(data, toHalf), a callback per value (160 ms for this image in Node). Now the built-in Float16Array bulk conversion (same bits), else a plain loop: 150 -> 16.95 ms against three-webgpu 20.3. fixed in 1be3aca1 (trade-off: none; bit-identical texels), rerun `node bench/cli.mjs parity --cases=p-hdr-load,p-exr-load --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| 9.2 | EXRLoader | slower | faster | `p-exr-load` | The same half-float upload as 9.1, plus parseEXR computing halfToFloat (a 2 ** n) per texel and unpredicting ZIP chunks in three passes. Now a 65,536-entry half table and a one-pass unpredict: 221 -> 19.6 ms against three-webgpu 25.9. fixed in 1be3aca1 (trade-off: a 256 KiB table, built on the first HALF decode; bit-identical floats), rerun `node bench/cli.mjs parity --cases=p-hdr-load,p-exr-load --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| 9.3 | PMREMGenerator, `scene.environment` (IBL) | slower | slower | `p-pmrem` `helmet` `helmet-filterpcf-cascades1` | p-pmrem: not diagnosed yet. helmet, measured (timestamps per pass with each feature switched off): IBL costs nothing measurable; Margo's default shadow filter, PCSS ('soft': 16 blocker reads and 32 comparison taps per lit pixel, spread over a penumbra up to a tenth of the map), is 0.68 of helmet's 0.78 ms GPU, where three's side draws one PCFSoftShadowMap. With the closest setup (helmet-filterpcf-cascades1: filter 'pcf', 1 cascade) Margo draws in 0.08 ms GPU against three's WebGL 0.09 and WebGPU 0.07, the same image (SSIM 0.984); still slower on CPU, 0.11 against 0.07 ms (CPU profile: spread over the frame's four passes, shadow map, core meshes, the model and the MSAA resolve, with core's render the largest share). [known bug](../known-bugs.md#scifihelmet-default-soft-shadows-cost-the-gpu-time) |
| 9.4 | Fog, FogExp2 | faster | faster | `p-fog` |  |
| 9.5 | Volumetric fog and light shafts (`VolumeNodeMaterial`, `webgpu_volume_lighting`) | slower | slower | `p-volumetric` |  |
| 9.6 | Sky add-on | faster | faster | `p-sky` |  |
| 9.7 | Tone mapping (`renderer.toneMapping`) | slower | slower | `p-tonemap` |  |
| 9.8 | Color management (sRGB input, linear workflow, `outputColorSpace`) | no workload | no workload |  | no workload of its own: colour conversion is part of every frame scene |
| 9.9 | Exposure, physical camera parameters | no workload | no workload |  | no workload: exposure is one uniform |
| 10.1 | GLTFLoader: static textured PBR | slower | slower | `p-gltf-parse` `gltf-flight-helmet` |  |
| 10.2 | GLTFLoader: animations, skins, morph targets | slower | slower | `p-gltf-animated` |  |
| 10.3 | Progressive / streamed glTF loading (no three.js counterpart: `GLTFLoader` resol | no three.js equivalent | no three.js equivalent |  | no three.js equivalent (GLTFLoader resolves once the whole file is parsed) |
| 10.4 | glTF extensions (KHR_materials_*, KHR_texture_transform, KHR_lights_punctual, KH | slower | slower | `p-gltf-extensions` |  |
| 10.5 | DRACOLoader, glTF Draco | slower | slower | `p-draco` |  |
| 10.6 | Meshopt (`EXT_meshopt_compression`) | error | error | `p-meshopt` |  |
| 10.7 | KTX2Loader | equal | equal | `p-ktx2` |  |
| 10.8 | FBXLoader | slower | slower | `p-fbx` |  |
| 10.9 | OBJLoader | faster | faster | `p-obj` |  |
| 10.10 | MTLLoader | slower | slower | `p-mtl` |  |
| 10.11 | STLLoader | slower | slower | `p-stl` `p-stl-normals` `p-stl-cad` | Before: JS arrays grown by push in the STL read and weld (63 ms in Node) and a fingerprint of the lone part with nothing to match (40 ms): 111 -> 28.7 ms. Then a like-for-like reader: p-stl now times the plain parseSTL (typed arrays, no weld, flat normals computed where the file stores zero): 4.9 ms against three's 2.8, the rest being those computed normals. ACCEPTED difference in work (Scott, 2026-10-26): parseSTL returns a render-ready mesh, while three's STLLoader copies the file's zero normals, which light wrongly until computeVertexNormals() runs; p-stl-normals times that full job (three 8.7 ms, parseSTL 4.7 ms, faster). The old path stays measured as p-stl-cad (parseCAD welds corners, builds parts and creates GPU meshes: 29.4 ms, no three.js equivalent). [known bug](../known-bugs.md#stl-import-still-computes-normals-threes-stlloader-leaves-zero). fixed in b30af0b8 (trade-off: worst-case typed arrays, about 260 bytes per triangle while parsing, freed after), rerun `node bench/cli.mjs parity --cases=p-stl --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail`; fixed in d8cefa7b (trade-off: +1.9 KB gzip on the loaders root entry (separate module); computes flat normals where the file stores zero), rerun `node bench/cli.mjs parity --cases=p-stl,p-stl-cad --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| 10.12 | PLYLoader | faster | faster | `p-ply` |  |
| 10.13 | 3MFLoader | faster | faster | `p-3mf` |  |
| 10.14 | USDZLoader, USDLoader | not run | not run | `p-usdz` |  |
| 10.15 | PCDLoader, XYZLoader, VTKLoader | faster | faster | `p-pcd` |  |
| 10.16 | ColladaLoader | faster | faster | `p-collada` |  |
| 10.17 | SVGLoader | slower | slower | `p-svg` |  |
| 10.18 | Long-tail model loaders (LDraw, VRML, 3DS, LWO, AMF, MD2, PDB, GCode, BVH motion | Margo missing | Margo missing |  | Margo missing (long-tail loaders are a documented limit) |
| 10.19 | VOXLoader (MagicaVoxel `.vox`) | faster | faster | `p-vox` |  |
| 10.20 | Texture loaders (UltraHDR, TGA, DDS, KTX v1, TIFF, IES, LUT3dl, LUTImage) | slower | slower | `p-texture-formats` `p-ies` |  |
| 10.21 | LUTCubeLoader | slower | slower | `p-cube-lut` |  |
| 10.22 | LoadingManager, Cache, progress events | no workload | no workload |  | no workload: loading manager and cache bookkeeping |
| 11.1 | GLTFExporter | faster | faster | `p-export-gltf` |  |
| 11.2 | OBJExporter, STLExporter, PLYExporter | slower | slower | `p-export-mesh` |  |
| 11.3 | USDZExporter | slower | slower | `p-export-usdz` | Before: num() tried toPrecision(1..9) for every number (75% of the time) and CRC-32 ran a byte at a time. Now a binary search with a value cache and slicing-by-8: 52.8 -> 16.0 ms, byte-identical archive. The rest is different output: Margo writes every mesh in world space (2.46 MB for 1,000 boxes), three's archive is 444 KB, so it writes far fewer numbers. Closing it means writing a shared mesh once with per-node transforms, an exporter format change left for a decision. [known bug](../known-bugs.md#usdz-export-writes-every-mesh-in-world-space). fixed in b30af0b8 (trade-off: +500 B gzip on exporters/usdz), rerun `node bench/cli.mjs parity --cases=p-export-usdz --engines=margo,three-webgpu-parity,three-webgl-parity --runs=3 --warmup=1 --no-compare --no-fail` |
| 11.4 | EXRExporter | slower | slower | `p-export-exr` |  |
| 11.5 | DRACOExporter, KTX2Exporter | Margo missing | Margo missing |  | Margo missing (Draco and KTX2 encoders are a documented limit) |
| 12.1 | AnimationMixer, clip playback | slower | slower | `p-mixer-100` |  |
| 12.2 | Cross-fade, blending, additive layers | slower | slower | `p-crossfade-100` |  |
| 12.3 | SkinnedMesh, Skeleton, Bone | slower | slower | `p-mixer-100` |  |
| 12.4 | Animated crowds (vertex animation textures; three.js has no built-in) | no three.js equivalent | no three.js equivalent |  | no three.js equivalent (three.js has no built-in vertex animation textures) |
| 12.5 | Morph targets | slower | slower | `p-morph` | 100 morphed copies each began a render pass and a compute pass, and every draw rebuilt its shader text each frame; models now draw as one run, Animations deform in one compute pass and the shader text steps are memoised. Still slower: that pass holds 200 dispatches (2 primitives x 100 copies, 150,000 vertices in all), each writing its own output buffer, and they run one after another (1.18 ms GPU); three morphs in each draw's vertex shader. [known bug](../known-bugs.md#morph-targets-one-compute-dispatch-per-primitive). fixed in 63a7edec (trade-off: models share a run only when their passes were added back to back; others draw alone as before), rerun `npm run bench -- parity --cases=p-morph --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 12.6 | KeyframeTrack, AnimationClip authored in code, PropertyBinding | slower | equal | `p-keyframes` | Skeleton.index was a linear name search run per track per call (quadratic in bones); every setPose built its error labels and every track a pose object and a sample array. fixed in 4be0e7d2 (trade-off: none; a clip keeps one bone binding per skeleton it has posed (weakly held)), rerun `npm run bench -- parity --cases=p-keyframes --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 12.7 | SkeletonUtils (clone, retarget), AnimationObjectGroup | slower | slower | `p-skeleton-clone` | every cloneModel copy repacked its vertices (now shared per asset), core Engine.remove scanned every slot of the parent column for each removed mesh (now each mesh keeps its children), and every copy uploaded its own vertex and index buffers, re-baked its static parts and made a view and sampler per map slot (now counted per asset, reused and cached). Still slower (CPU profile): installBatches runs two engine-wide kernel ticks per model, quadratic in the copies (about 6.5 of 17.6 ms), then per-copy uniforms and bind groups and core node creation; three clones on the CPU only. [known bug](../known-bugs.md#clonemodel-two-engine-wide-ticks-per-copy). fixed in 63a7edec (trade-off: packed arrays live as long as the asset), rerun `npm run bench -- parity --cases=p-skeleton-clone --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5`; fixed in 2d541368 (trade-off: a Set of child ids per mesh with children), rerun `npm run bench -- parity --cases=p-skeleton-clone --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5`; fixed in 641246d3 (trade-off: a model rewrites a geometry buffer in place only while no other copy holds it; the first edit of a shared one uploads a new buffer), rerun `npm run bench -- parity --cases=p-skeleton-clone --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 12.8 | IK (CCDIKSolver) | faster | faster | `p-ik` |  |
| 13.1 | EffectComposer, or the WebGPU PostProcessing node chain | faster | faster | `p-composer` |  |
| 13.2 | UnrealBloomPass | faster | faster | `p-bloom` |  |
| 13.3 | SSAOPass, SAOPass | slower | slower | `p-ssao` |  |
| 13.4 | GTAOPass | faster | faster | `p-gtao` |  |
| 13.5 | SSRPass | faster | faster | `p-ssr` |  |
| 13.6 | SSGI, denoise | faster | faster | `p-ssgi` |  |
| 13.7 | TAA (TAARenderPass, TRAA node) | slower | faster | `p-taa` | the velocity pass began a render pass per mesh (and a compute pass per PBR snapshot) and rewrote every mesh block each frame because the camera rows were in it; now one render pass, one snapshot pass and one camera block a frame. The image differs from three.js as before (different TAA algorithms; three-webgl has no moving-camera TAA). fixed in 8149bf4e (trade-off: none), rerun `npm run bench -- parity --cases=p-taa --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 13.8 | FXAA, SMAA | faster | faster | `p-fxaa` `p-smaa` |  |
| 13.9 | BokehPass, DOF | faster | faster | `p-dof` |  |
| 13.10 | OutlinePass | faster | faster | `p-outline` |  |
| 13.11 | FilmPass (grain) | faster | faster | `p-film` |  |
| 13.12 | GlitchPass | faster | faster | `p-glitch` |  |
| 13.13 | AfterimagePass | faster | faster | `p-afterimage` |  |
| 13.14 | LUTPass | faster | faster | `p-lut` |  |
| 13.15 | OutputPass, tone mapping | slower | slower | `p-tonemap` |  |
| 13.16 | God rays | three missing | three missing | `p-god-rays` |  |
| 13.17 | Motion blur | slower | slower | `p-motion-blur` |  |
| 13.18 | Color correction, grading | Margo missing | Margo missing | `p-color-grading` |  |
| 13.19 | Simple screen effects (vignette, RGB shift or chromatic aberration, pixelation,  | slower | slower | `p-screen-effects` |  |
| 13.20 | Lensflare | Margo missing | Margo missing | `p-lensflare` |  |
| 14.1 | OrbitControls, MapControls, TrackballControls, FlyControls, FirstPersonControls, | faster | faster | `p-orbit-controls` |  |
| 14.2 | TransformControls | faster | faster | `p-transform-controls` |  |
| 14.3 | DragControls | slower | slower | `p-drag-controls` |  |
| 14.4 | ArcballControls | slower | slower | `p-arcball` |  |
| 15.1 | GridHelper, PolarGridHelper, AxesHelper, BoxHelper, Box3Helper, ArrowHelper, Cam | faster | faster | `p-helpers` |  |
| 15.2 | PointLightHelper, SpotLightHelper, DirectionalLightHelper, HemisphereLightHelper | slower | slower | `p-light-helpers` |  |
| 15.3 | SkeletonHelper | slower | slower | `p-skeleton-helper` |  |
| 15.4 | ViewHelper (examples) | faster | faster | `p-view-helper` |  |
| 16.1 | Raycaster | slower | slower | `p-raycast` `p-raycast-mesh` |  |
| 16.2 | GPU picking | slower | slower | `p-gpu-pick` | core GPURenderer.pick compiled a shader module and pipeline on every call and rewrote every instance (960 KB for 10,000 boxes); both fixed. Still slower, measured (CPU profile: 0.15 ms of JS a pick, the main thread idle the rest): each pick waits for its own GPU pass and mapAsync readback, about 3.1 ms here, and engine.pick answers overlapping calls one at a time by contract (each reads the scene when its turn comes). three's WebGL readRenderTargetPixels is a synchronous readPixels; three's WebGPU readback is slower than Margo's (423 ms). [known bug](../known-bugs.md#gpu-picking-waits-for-one-readback-per-pick). fixed in 2d541368 (trade-off: pick pipelines count toward the 64 cached shader variants), rerun `npm run bench -- parity --cases=p-gpu-pick --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 17.1 | InstancedMesh | three missing | three missing | `boxes-10000-instanced` | measured by margo-bench (docs/whitepaper/boxes-vs-threejs.md) |
| 17.2 | BatchedMesh | faster | faster | `shapes-10000-batched` |  |
| 17.3 | LOD | faster | faster | `p-lod` |  |
| 17.4 | Points | slower | slower | `p-points-1000000` |  |
| 17.5 | Sprite | faster | faster | `p-sprites` |  |
| 17.6 | Line, LineSegments, LineLoop, Line2 | slower | slower | `p-lines` |  |
| 17.7 | CSS2DRenderer, CSS3DRenderer | faster | faster | `p-css-labels` |  |
| 17.8 | Reflector, Refractor (planar mirror and glass) | faster | faster | `p-reflector` |  |
| 17.9 | Water, Water2 add-ons | slower | slower | `p-water` |  |
| 17.10 | Decals | faster | faster | `p-decals` |  |
| 17.11 | MarchingCubes add-on | slower | equal | `p-marching-cubes` | the scene's density function summed every ball at every grid point (4.2 M terms a frame; three writes each ball only near it), and marchingCubes allocated its grids and a 1.8 M-slot vertex table every call. fixed in 4be0e7d2 (trade-off: marchingCubes takes a sampled grid (normals from the grid gradient instead of the function's); 816 more gzip bytes in procedural), rerun `npm run bench -- parity --cases=p-marching-cubes --engines=margo,three-webgpu-parity,three-webgl-parity --runs=5` |
| 18.1 | AudioListener, Audio, PositionalAudio, AudioAnalyser, AudioLoader | slower | slower | `p-audio` |  |
| 19.1 | WebXR VR (`renderer.xr`) | no workload | no workload |  | not measurable headless: WebXR sessions need an XR device |
| 19.2 | WebXR AR (hit test, anchors, plane detection, depth sensing, light estimation) | no workload | no workload |  | not measurable headless: WebXR sessions need an XR device |
| 19.3 | Controller and hand input poses | no workload | no workload |  | not measurable headless: WebXR sessions need an XR device |
| 19.4 | XRControllerModelFactory, XRHandModelFactory | Margo missing | Margo missing |  | Margo missing (controller and hand models) |

## Raw results

Medians over runs. Frame scenes: CPU ms / GPU ms / FPS / first frame ms; task scenes: ms per call / cold ms. "Later"
is the newest run after the first, when there is one.

| Scene | First run (run id) | Verdict | Later run | Verdict | Image (SSIM, mean dE) | Feature JS gzip (Margo / three) |
| --- | --- | --- | --- | --- | --- | --- |
| `boxes-10000` | margo 0.15 / 0.10 / 2551 / 16; three-webgl-parity 7.41 / 4.63 / 125 / 33 (`20261025-170145-d3fec42e-dev`) | faster |  |  | 0.996, 0.65 | 26,009 / 1,607 |
| `boxes-10000-instanced` | margo 0.08 / 0.17 / 3155 / 60; three n/a (`20261025-170145-d3fec42e-dev`) | three missing |  |  |  |  |
| `boxes-10000-views4` | margo 0.48 / 0.24 / 1360 / 25; three-webgl-parity 28.09 / 25.52 / 35 / 58 (`20261025-170145-d3fec42e-dev`) | faster |  |  | 0.598, 2.16 (differs) | 26,009 / 1,607 |
| `gltf-flight-helmet` | margo 0.10 / 0.03 / 2896 / 150; three-webgl-parity 0.14 / 0.11 / 2728 / 84 (`20261025-170145-d3fec42e-dev`) | faster | margo 0.10 / 0.03 / 3393 / 154; three-webgl-parity 0.13 / 0.12 / 2960 / 85 (`20261026-194330-907e13a5-dev`) | faster | 0.997, 0.15 | 86,444 / 1,607 |
| `helmet` | margo 0.11 / 0.77 / 877 / 127; three-webgl-parity 0.07 / 0.08 / 3121 / 51 (`20261025-170145-d3fec42e-dev`) | slower | margo 0.11 / 0.78 / 852 / 134; three-webgl-parity 0.07 / 0.09 / 3644 / 53 (`20261026-194330-907e13a5-dev`) | slower | 0.981, 0.58 | 128,283 / 1,607 |
| `helmet-filterpcf-cascades1` | margo 0.11 / 0.08 / 3074 / 112; three-webgl-parity 0.07 / 0.09 / 3602 / 53 (`20261026-194330-907e13a5-dev`) | slower |  |  | 0.984, 0.54 | 128,283 / 1,607 |
| `lights-1000` | margo 0.10 / 0.39 / 1956 / 59; three-webgl-parity 0.62 / 0.63 / 1112 / 22 (`20261025-170145-d3fec42e-dev`) | faster |  |  | 0.993, 0.62 | 39,837 / 1,607 |
| `materials-4096` | margo 0.10 / 0.06 / 3002 / 15; three-webgl-parity 2.48 / 1.49 / 340 / 29 (`20261025-170145-d3fec42e-dev`) | faster |  |  | 0.984, 1.81 | 26,009 / 1,607 |
| `p-3mf` | margo 18.68 / 31.08; three-webgpu-parity 60.09 / 73.43 (`20261025-161120-d3fec42e-dev`) | faster |  |  |  | 86,410 / 1,607 |
| `p-afterimage` | margo 0.10 / 0.12 / 3018 / 76; three-webgl-parity 0.82 / 0.30 / 895 / 24 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.99, 1.12 | 45,903 / 1,607 |
| `p-alpha` | margo 0.09 / 0.05 / 2785 / 25; three-webgl-parity 0.65 / 0.05 / 1019 / 20 (`20261025-132015-d3fec42e-dev`) | faster |  |  | 0.993, 0.65 | 57,211 / 1,607 |
| `p-alpha-test` | margo 72.92 / 4.72 / 14 / 1823; three-webgl-parity 2.57 / 1.44 / 333 / 24 (`20261025-132015-d3fec42e-dev`) | slower | margo 1.17 / 0.08 / 706 / 134; three-webgl-parity 2.58 / 1.43 / 346 / 25 (`20261026-071108-14354737-dev`) | faster | 0.995, 1.02 | 73,557 / 1,607 |
| `p-ambient` | margo 0.17 / 0.10 / 2296 / 39; three-webgl-parity 10.96 / 7.32 / 86 / 36 (`20261025-152656-d3fec42e-dev`) | faster |  |  | 0.994, 0.78 | 56,532 / 1,607 |
| `p-arcball` | margo 34.48 / 42.87; three-webgpu-parity 29.97 / 37.87 (`20261025-163700-d3fec42e-dev`) | slower |  |  |  | 33,822 / 1,607 |
| `p-attributes` | margo 167 / 3.97 / 6 / 4120; three-webgl-parity 7.56 / 4.96 / 124 / 34 (`20261025-134730-d3fec42e-dev`) | slower | margo 4.70 / 1.09 / 195 / 78; three-webgl-parity 8.20 / 8.70 / 111 / 32 (`20261026-073905-14354737-dev`) | faster | 0.994, 1.03 | 73,489 / 1,607 |
| `p-audio` | margo 246 / 261; three-webgl-parity 107 / 125 (`20261025-170007-d3fec42e-dev`) | slower |  |  |  | 32,995 / 1,607 |
| `p-background` | margo 0.09 / 0.05 / 2875 / 32; three-webgl-parity 0.66 / 0.05 / 1069 / 50 (`20261025-132015-d3fec42e-dev`) | faster |  |  | 0.993, 0.65 | 57,211 / 1,607 |
| `p-blending` | margo 24.61 / 5.68 / 35 / 1024; three-webgl-parity 1.33 / 0.52 / 615 / 18 (`20261025-135606-d3fec42e-dev`) | slower | margo 1.30 / 0.07 / 637 / 184; three-webgl-parity 1.38 / 0.57 / 600 / 18 (`20261026-105135-fbc01bdc-dev`) | faster | 1, 0 | 74,255 / 1,607 |
| `p-bloom` | margo 0.10 / 0.21 / 2703 / 124; three-webgl-parity 0.85 / 0.39 / 892 / 31 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.993, 0.64 | 48,599 / 1,607 |
| `p-canvas-texture` | margo 15.19 / 2.24 / 58 / 643; three-webgpu-parity 3.25 / 0.14 / 261 / 217 (`20261025-144617-d3fec42e-dev`) | slower | margo 0.34 / 0.08 / 1243 / 176; three-webgpu-parity 1.98 / 0.14 / 436 / 171 (`20261026-165034-594c45af-dev`) | faster | 0.996, 0.61 | 178,971 / 1,607 |
| `p-clipping` | margo 180 / 4.71 / 6 / 4419; three-webgl-parity 7.76 / 5.12 / 121 / 35 (`20261025-133001-d3fec42e-dev`) | slower | margo 6.60 / 1.14 / 137 / 90; three-webgl-parity 8.99 / 9.42 / 101 / 36 (`20261026-073905-14354737-dev`) | equal | 0.998, 0.29 | 73,489 / 1,607 |
| `p-collada` | margo 12.86 / 27.21; three-webgl-parity 17.04 / 27.79 (`20261025-161120-d3fec42e-dev`) | faster |  |  |  | 153,368 / 1,607 |
| `p-color-grading` | margo Error: unsupported: hue rotation (creative PostProcessing has contrast; three-webgl-parity 0.81 / 0.37 / 914 / 24 (`20261025-162530-d3fec42e-dev`) | Margo missing |  |  |  | 0 / 24,137 |
| `p-composer` | margo 0.09 / 0.11 / 3106 / 68; three-webgl-parity 0.78 / 0.18 / 943 / 22 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.993, 0.64 | 43,545 / 1,607 |
| `p-compute-262144` | margo Error: unsupported: drawing a ComputePass storage buffer as points (po; three-webgl-parity 0.04 / 0.18 / 2849 / 16 (`20261025-133001-d3fec42e-dev`) | Margo missing |  |  |  | 0 / 24,137 |
| `p-crossfade-100` | margo 18.43 / 3.53 / 53 / 131; three-webgl-parity 6.92 / 5.27 / 137 / 76 (`20261025-162001-d3fec42e-dev`) | slower |  |  | 0.804, 5.89 (differs) | 111,910 / 1,607 |
| `p-csm` | margo 0.88 / 0.17 / 835 / 67; three-webgl-parity 2.42 / 1.74 / 361 / 28 (`20261025-154709-d3fec42e-dev`) | faster |  |  | 0.969, 1.57 | 40,073 / 1,607 |
| `p-css-labels` | margo 0.61 / 0.04 / 356 / 16; three-webgl-parity 1.25 / 0.32 / 275 / 26 (`20261025-165203-d3fec42e-dev`) | faster |  |  | 0.995, 0.45 | 34,352 / 1,607 |
| `p-cube-camera` | margo 0.49 / 0.18 / 1091 / 107; three-webgl-parity 1.42 / 1.57 / 561 / 37 (`20261025-134528-d3fec42e-dev`) | faster |  |  | 0.993, 0.59 | 165,154 / 1,607 |
| `p-cube-lut` | margo 8.54 / 12.16; three-webgpu-parity 3.27 / 4.05 (`20261025-161120-d3fec42e-dev`) | slower |  |  |  | 38,848 / 1,607 |
| `p-culling` | margo 0.58 / 0.12 / 878 / 18; three-webgl-parity 25.18 / 15.85 / 39 / 57 (`20261025-132015-d3fec42e-dev`) | faster |  |  | 0.99, 0.55 | 28,146 / 1,607 |
| `p-custom-shader` | margo 20.98 / 2.11 / 47 / 337; three-webgl-parity 6.31 / 3.71 / 149 / 21 (`20261025-133001-d3fec42e-dev`) | slower |  |  | 0.997, 0.42 | 75,639 / 1,607 |
| `p-data-texture` | margo 1.16 / 0.03 / 680 / 61; three-webgl-parity 0.96 / 0.07 / 806 / 12 (`20261025-144617-d3fec42e-dev`) | slower |  |  | 1, 0 | 162,939 / 1,607 |
| `p-decals` | margo 0.10 / 0.12 / 3021 / 98; three-webgl-parity 0.91 / 0.23 / 831 / 31 (`20261025-165203-d3fec42e-dev`) | faster |  |  | 0.793, 6.04 (differs) | 45,465 / 1,607 |
| `p-depth-material` | margo 179 / 3.83 / 6 / 4366; three-webgl-parity 6.02 / 3.50 / 153 / 22 (`20261025-135606-d3fec42e-dev`) | slower | margo 3.37 / 0.25 / 258 / 114; three-webgl-parity 5.74 / 3.11 / 165 / 20 (`20261026-071108-14354737-dev`) | faster | 1, 0 | 73,489 / 1,607 |
| `p-depth-range` | margo 0.07 / 0.02 / 3204 / 14; three-webgl-parity 0.89 / 0.11 / 862 / 21 (`20261025-133001-d3fec42e-dev`) | faster |  |  | 0.998, 0.48 | 34,195 / 1,607 |
| `p-depth-texture` | margo 0.13 / 0.10 / 2620 / 75; three-webgl-parity 0.74 / 0.08 / 974 / 22 (`20261025-144617-d3fec42e-dev`) | faster |  |  | 1, 0 | 167,541 / 1,607 |
| `p-dof` | margo 0.10 / 0.22 / 2672 / 117; three-webgpu-parity 0.92 / 0.31 / 803 / 211 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.618, 7.51 (differs) | 50,460 / 1,607 |
| `p-double-sided` | margo 170 / 5.29 / 6 / 4113; three-webgl-parity 7.64 / 4.88 / 123 / 34 (`20261025-135606-d3fec42e-dev`) | slower | margo 4.37 / 0.22 / 204 / 61; three-webgl-parity 7.20 / 6.18 / 131 / 32 (`20261026-071108-14354737-dev`) | faster | 0.994, 1.15 | 73,557 / 1,607 |
| `p-draco` | margo 0.72 / 19.86; three-webgl-parity 0.45 / 15.93 (`20261025-161120-d3fec42e-dev`) | slower |  |  |  | 84,835 / 1,607 |
| `p-drag-controls` | margo 0.91 / 4.64; three-webgpu-parity 0.56 / 2.88 (`20261025-163700-d3fec42e-dev`) | slower |  |  |  | 59,377 / 1,607 |
| `p-edges` | margo 16.59 / 27.80; three-webgl-parity 141 / 150 (`20261025-134730-d3fec42e-dev`) | faster |  |  |  | 50,325 / 1,607 |
| `p-export-exr` | margo 648 / 620; three-webgl-parity 150 / 162 (`20261025-161539-d3fec42e-dev`) | slower |  |  |  | 29,410 / 1,607 |
| `p-export-gltf` | margo 1.33 / 6.35; three-webgpu-parity 1.85 / 6.14 (`20261025-161539-d3fec42e-dev`) | faster | margo 1.31 / 5.91; three-webgpu-parity 1.76 / 5.02 (`20261025-170145-d3fec42e-dev`) | faster |  | 89,583 / 1,607 |
| `p-export-mesh` | margo 253 / 305; three-webgpu-parity 101 / 129 (`20261025-161539-d3fec42e-dev`) | slower |  |  |  | 89,583 / 1,607 |
| `p-export-usdz` | margo 52.79 / 64.22; three-webgpu-parity 2.77 / 6.83 (`20261025-161539-d3fec42e-dev`) | slower | margo 15.96 / 26.27; three-webgl-parity 2.48 / 5.19 (`20261026-165034-594c45af-dev`) | slower |  | 64,495 / 1,607 |
| `p-exr-load` | margo 221 / 240; three-webgpu-parity 27.12 / 33.85 (`20261025-155040-d3fec42e-dev`) | slower | margo 19.55 / 31.31; three-webgpu-parity 25.93 / 32.04 (`20261026-165034-594c45af-dev`) | faster |  | 206,417 / 1,607 |
| `p-extrude` | margo 2.54 / 9.18; three-webgl-parity 1.95 / 8.04 (`20261025-134730-d3fec42e-dev`) | slower |  |  |  | 50,325 / 1,607 |
| `p-fbx` | margo 12.81 / 26.61; three-webgl-parity 4.16 / 11.61 (`20261025-161120-d3fec42e-dev`) | slower |  |  |  | 154,131 / 1,607 |
| `p-film` | margo 0.10 / 0.14 / 3064 / 77; three-webgl-parity 0.81 / 0.27 / 918 / 24 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.226, 12.91 (differs) | 42,090 / 1,607 |
| `p-fog` | margo 0.16 / 0.10 / 2477 / 35; three-webgl-parity 8.41 / 5.46 / 111 / 36 (`20261025-155040-d3fec42e-dev`) | faster |  |  | 0.99, 0.94 | 57,637 / 1,607 |
| `p-fxaa` | margo 0.08 / 0.05 / 3039 / 70; three-webgl-parity 0.81 / 0.18 / 908 / 24 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.998, 0.53 | 46,551 / 1,607 |
| `p-geometry-misc` | margo 32.81 / 57.20; three-webgpu-parity 20.34 / 39.28 (`20261025-134730-d3fec42e-dev`) | slower |  |  |  | 34,072 / 1,607 |
| `p-geometry-utils` | margo 232 / 257; three-webgl-parity 172 / 194 (`20261025-134730-d3fec42e-dev`) | slower |  |  |  | 50,325 / 1,607 |
| `p-glitch` | margo 0.10 / 0.13 / 2965 / 90; three-webgl-parity 0.82 / 0.28 / 903 / 24 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.026, 44.21 (differs) | 46,630 / 1,607 |
| `p-gltf-animated` | margo 3.92 / 15.88; three-webgl-parity 1.14 / 7.01 (`20261025-161120-d3fec42e-dev`) | slower | margo 3.63 / 14.48; three-webgpu-parity 1.15 / 6.08 (`20261025-170145-d3fec42e-dev`) | slower |  | 97,854 / 1,607 |
| `p-gltf-extensions` | margo 51.29 / 72.58; three-webgpu-parity 28.55 / 32.52 (`20261025-161120-d3fec42e-dev`) | slower | margo 50.32 / 66.31; three-webgpu-parity 27.15 / 30.89 (`20261025-170145-d3fec42e-dev`) | slower |  | 79,138 / 1,607 |
| `p-gltf-parse` | margo 90.20 / 119; three-webgpu-parity 29.83 / 37.36 (`20261025-161120-d3fec42e-dev`) | slower | margo 87.38 / 109; three-webgpu-parity 27.48 / 35.46 (`20261025-170145-d3fec42e-dev`) | slower |  | 79,138 / 1,607 |
| `p-god-rays` | margo 0.10 / 0.14 / 2940 / 76; three n/a (`20261025-162530-d3fec42e-dev`) | three missing |  |  |  |  |
| `p-gpu-pick` | margo 407 / 422; three-webgl-parity 65.13 / 82.11 (`20261025-164210-d3fec42e-dev`) | slower | margo 325 / 345; three-webgl-parity 60.52 / 79.02 (`20261026-190630-9da08cb5-dev`) | slower |  | 27,972 / 1,607 |
| `p-gtao` | margo 0.12 / 0.38 / 1645 / 150; three-webgl-parity 1.63 / 1.42 / 505 / 37 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.972, 0.9 | 53,296 / 1,607 |
| `p-hdr-load` | margo 150 / 164; three-webgpu-parity 20.98 / 31.23 (`20261025-155040-d3fec42e-dev`) | slower | margo 16.95 / 20.15; three-webgpu-parity 20.29 / 28.55 (`20261026-165034-594c45af-dev`) | faster |  | 206,417 / 1,607 |
| `p-helpers` | margo 0.35 / 0.20 / 959 / 117; three-webgl-parity 2.02 / 1.24 / 410 / 48 (`20261025-163815-d3fec42e-dev`) | faster |  |  | 0.955, 3.5 | 48,480 / 1,607 |
| `p-hemisphere` | margo 0.17 / 0.10 / 2254 / 36; three-webgl-parity 9.71 / 7.19 / 97 / 35 (`20261025-152656-d3fec42e-dev`) | faster |  |  | 0.995, 0.67 | 56,532 / 1,607 |
| `p-hierarchy` | margo 0.65 / 0.10 / 1029 / 17; three-webgl-parity 4.59 / 2.61 / 197 / 30 (`20261025-132015-d3fec42e-dev`) | faster |  |  | 0.988, 1.01 | 28,146 / 1,607 |
| `p-ies` | margo 0.09 / 0.20 / 2937 / 61; three-webgpu-parity 0.92 / 0.19 / 817 / 169 (`20261025-152656-d3fec42e-dev`) | slower |  |  | 0.993, 1.33 | 44,935 / 1,607 |
| `p-ik` | margo 5.82 / 11.35; three-webgl-parity 26.55 / 31.73 (`20261025-162001-d3fec42e-dev`) | faster |  |  |  | 41,661 / 1,607 |
| `p-keyframes` | margo 420 / 428; three-webgl-parity 32.77 / 36.16 (`20261025-162001-d3fec42e-dev`) | slower | margo 30.32 / 34.39; three-webgl-parity 32.37 / 36.08 (`20261026-165655-594c45af-dev`) | equal |  | 110,593 / 1,607 |
| `p-ktx2` | margo 0.40 / 0.78; three-webgpu-parity 0.38 / 0.82 (`20261025-144617-d3fec42e-dev`) | equal |  |  |  | 40,477 / 1,607 |
| `p-lambert` | margo 167 / 3.87 / 6 / 3760; three-webgl-parity 7.86 / 5.05 / 120 / 26 (`20261025-135606-d3fec42e-dev`) | slower | margo 7.37 / 1.32 / 127 / 128; three-webgl-parity 7.56 / 8.66 / 123 / 30 (`20261026-071108-14354737-dev`) | faster | 0.993, 1.07 | 73,557 / 1,607 |
| `p-layers` | margo 0.15 / 0.05 / 2511 / 16; three-webgl-parity 3.81 / 1.99 / 234 / 27 (`20261025-132015-d3fec42e-dev`) | faster |  |  | 0.996, 0.67 | 29,012 / 1,607 |
| `p-lensflare` | margo Error: unsupported: lens flare from a point light (post LensFlare foll; three-webgl-parity 0.80 / 0.18 / 937 / 29 (`20261025-162530-d3fec42e-dev`) | Margo missing |  |  |  | 0 / 24,137 |
| `p-light-helpers` | margo 1.50 / 0.41 / 535 / 125; three-webgl-parity 0.94 / 0.64 / 805 / 28 (`20261025-163815-d3fec42e-dev`) | slower |  |  | 0.985, 0.76 | 62,308 / 1,607 |
| `p-light-probe` | margo Error: unsupported: a light probe from given SH coefficients (environm; three-webgl-parity 8.94 / 6.34 / 107 / 33 (`20261025-152656-d3fec42e-dev`) | Margo missing |  |  |  | 0 / 24,137 |
| `p-lines` | margo 0.07 / 0.15 / 3340 / 77; three-webgl-parity 0.14 / 0.06 / 2544 / 21 (`20261025-165203-d3fec42e-dev`) | slower |  |  | 0.955, 4.06 | 47,716 / 1,607 |
| `p-lod` | margo 0.20 / 0.05 / 2407 / 16; three-webgl-parity 1.83 / 0.50 / 447 / 24 (`20261025-165203-d3fec42e-dev`) | faster |  |  | 0.994, 0.61 | 109,747 / 1,607 |
| `p-lut` | margo 0.09 / 0.13 / 3049 / 67; three-webgpu-parity 0.81 / 0.16 / 906 / 133 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.807, 6.01 (differs) | 43,545 / 1,607 |
| `p-maps` | margo 8.15 / 1.92 / 93 / 557; three-webgl-parity 0.70 / 0.07 / 1017 / 41 (`20261025-135606-d3fec42e-dev`) | slower | margo 0.27 / 0.06 / 2025 / 143; three-webgl-parity 0.77 / 0.09 / 973 / 42 (`20261026-073905-14354737-dev`) | faster | 0.994, 0.52 | 73,489 / 1,607 |
| `p-marching-cubes` | margo 15.96 / 1.48 / 61 / 34; three-webgl-parity 3.33 / 0.01 / 266 / 29 (`20261025-165203-d3fec42e-dev`) | slower | margo 2.87 / 0.01 / 309 / 15; three-webgl-parity 3.08 / 0.01 / 285 / 29 (`20261026-165655-594c45af-dev`) | equal | 0.996, 0.15 | 32,835 / 1,607 |
| `p-matcap` | margo 170 / 4.03 / 6 / 4416; three-webgl-parity 7.50 / 4.79 / 125 / 30 (`20261025-135606-d3fec42e-dev`) | slower | margo 4.83 / 1.12 / 180 / 126; three-webgl-parity 7.29 / 6.07 / 131 / 27 (`20261026-071108-14354737-dev`) | faster | 0.996, 0.48 | 73,557 / 1,607 |
| `p-math` | margo 29.05 / 36.21; three-webgl-parity 13.65 / 18.21 (`20261025-132015-d3fec42e-dev`) | slower |  |  |  | 42,455 / 1,607 |
| `p-meshopt` | margo RangeError: Truncated glTF buffer /     at http://127.0.0.1:61163/benc; three-webgl-parity 4.81 / 11.44 (`20261025-161120-d3fec42e-dev`) | error |  |  |  | 0 / 24,137 |
| `p-mipmaps` | margo 15.28 / 47.19; three-webgpu-parity 14.95 / 57.10 (`20261025-144617-d3fec42e-dev`) | equal |  |  |  | 162,939 / 1,607 |
| `p-mixer-100` | margo 15.13 / 5.33 / 64 / 126; three-webgl-parity 7.42 / 5.49 / 126 / 71 (`20261025-162001-d3fec42e-dev`) | slower |  |  | 0.993, 0.84 | 100,535 / 1,607 |
| `p-morph` | margo 1.06 / 1.57 / 507 / 86; three-webgl-parity 0.27 / 0.14 / 1913 / 26 (`20261025-162001-d3fec42e-dev`) | slower | margo 0.51 / 1.31 / 616 / 47; three-webgl-parity 0.27 / 0.15 / 2011 / 26 (`20261026-202801-67216c40-dev`) | slower | 0.99, 1.67 | 52,432 / 1,613 |
| `p-motion-blur` | margo 5.64 / 1.39 / 150 / 205; three-webgpu-parity 2.38 / 0.25 / 355 / 152 (`20261025-162530-d3fec42e-dev`) | slower |  |  | 0.656, 13.19 (differs) | 59,208 / 1,607 |
| `p-mrt` | margo 0.10 / 0.09 / 2878 / 5; three-webgl-parity 0.69 / 0.08 / 1031 / 18 (`20261025-133001-d3fec42e-dev`) | slower |  |  | 1, 0 | 46,816 / 1,607 |
| `p-msaa` | margo 0.15 / 0.10 / 2501 / 16; three-webgl-parity 7.49 / 4.81 / 125 / 33 (`20261025-133001-d3fec42e-dev`) | faster |  |  | 0.996, 0.65 | 29,677 / 1,607 |
| `p-msaa-samples1` | margo 0.15 / 0.07 / 2503 / 14; three-webgl-parity 7.54 / 4.90 / 124 / 33 (`20261025-133001-d3fec42e-dev`) | faster |  |  | 1, 0.31 | 29,677 / 1,607 |
| `p-mtl` | margo 0.69 / 2.73; three-webgl-parity 0.35 / 2.11 (`20261025-161120-d3fec42e-dev`) | slower |  |  |  | 86,410 / 1,607 |
| `p-node-material` | margo 71.40 / 4.34 / 14 / 1819; three-webgpu-parity 13.57 / 2.13 / 71 / 258 (`20261025-133001-d3fec42e-dev`) | slower |  |  | 0.995, 1.03 | 176,163 / 1,607 |
| `p-normal-material` | margo 170 / 3.91 / 6 / 4214; three-webgl-parity 7.13 / 4.62 / 132 / 22 (`20261025-135606-d3fec42e-dev`) | slower | margo 3.31 / 0.20 / 262 / 112; three-webgl-parity 7.01 / 4.97 / 135 / 25 (`20261026-071108-14354737-dev`) | faster | 0.994, 0.76 | 73,489 / 1,607 |
| `p-obj` | margo 74.98 / 82.05; three-webgpu-parity 97.54 / 98.37 (`20261025-161120-d3fec42e-dev`) | faster |  |  |  | 86,410 / 1,607 |
| `p-orbit-controls` | margo 1.50 / 6.21; three-webgl-parity 2.77 / 8.27 (`20261025-163700-d3fec42e-dev`) | faster |  |  |  | 35,007 / 1,607 |
| `p-ortho` | margo 0.15 / 0.14 / 2233 / 17; three-webgl-parity 7.88 / 4.92 / 119 / 32 (`20261025-134528-d3fec42e-dev`) | faster |  |  | 0.996, 0.64 | 29,050 / 1,607 |
| `p-outline` | margo 0.12 / 0.52 / 1486 / 56; three-webgl-parity 1.83 / 1.30 / 461 / 33 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.803, 6.71 (differs) | 43,488 / 1,607 |
| `p-pcd` | margo 1.59 / 5.75; three-webgpu-parity 1.79 / 4.63 (`20261025-161120-d3fec42e-dev`) | faster |  |  |  | 86,410 / 1,607 |
| `p-phong` | margo 177 / 4.00 / 6 / 3944; three-webgl-parity 7.74 / 4.81 / 121 / 26 (`20261025-135606-d3fec42e-dev`) | slower | margo 5.21 / 1.21 / 172 / 114; three-webgl-parity 7.64 / 7.88 / 124 / 30 (`20261026-071108-14354737-dev`) | faster | 0.993, 1.07 | 73,557 / 1,607 |
| `p-physical` | margo 21.34 / 5.40 / 46 / 268; three-webgl-parity 0.38 / 0.20 / 1479 / 24 (`20261025-135606-d3fec42e-dev`) | slower | margo 0.28 / 0.33 / 1901 / 73; three-webgl-parity 0.39 / 0.20 / 1558 / 28 (`20261026-071108-14354737-dev`) | slower | 0.967, 1.43 | 73,557 / 1,607 |
| `p-ply` | margo 9.97 / 15.12; three-webgpu-parity 12.13 / 18.09 (`20261025-161120-d3fec42e-dev`) | faster |  |  |  | 86,410 / 1,607 |
| `p-pmrem` | margo 16.32 / 21.39; three-webgl-parity 5.12 / 5.30 (`20261025-155040-d3fec42e-dev`) | slower |  |  |  | 57,637 / 1,607 |
| `p-point-shadows` | margo 15.40 / 1.63 / 63 / 102; three-webgl-parity 2.56 / 1.95 / 340 / 31 (`20261025-154709-d3fec42e-dev`) | slower | margo 1.19 / 0.17 / 413 / 85; three-webgl-parity 2.65 / 2.00 / 340 / 28 (`20261026-180213-3a2c2412-dev`) | faster | 0.993, 0.62 | 52,418 / 1,607 |
| `p-points-1000000` | margo 0.07 / 0.73 / 1206 / 56; three-webgl-parity 0.04 / 1.25 / 777 / 31 (`20261025-165203-d3fec42e-dev`) | slower |  |  | 0.901, 2.73 | 48,685 / 1,607 |
| `p-primitives` | margo 16.41 / 22.41; three-webgl-parity 13.67 / 26.61 (`20261025-134730-d3fec42e-dev`) | slower |  |  |  | 50,325 / 1,607 |
| `p-raycast` | margo 366 / 386; three-webgpu-parity 221 / 263 (`20261025-164210-d3fec42e-dev`) | slower |  |  |  | 54,953 / 1,607 |
| `p-raycast-mesh` | margo 2.08 / 131; three-webgl-parity 4281 / 4356 (`20261025-164210-d3fec42e-dev`) | faster |  |  |  | 76,770 / 1,607 |
| `p-rect-area` | margo 0.09 / 0.47 / 1596 / 96; three-webgl-parity 0.60 / 0.15 / 1160 / 16 (`20261025-152656-d3fec42e-dev`) | slower |  |  | 0.993, 0.6 | 52,864 / 1,607 |
| `p-reflector` | margo 0.23 / 0.04 / 2089 / 53; three-webgpu-parity 1.66 / 0.21 / 495 / 176 (`20261025-165203-d3fec42e-dev`) | faster |  |  | 0.889, 5.39 (differs) | 40,427 / 1,607 |
| `p-render-target` | margo 0.15 / 0.04 / 2553 / 5; three-webgl-parity 0.59 / 0.05 / 1168 / 22 (`20261025-133001-d3fec42e-dev`) | faster |  |  | 0.866, 1.11 (differs) | 42,456 / 1,607 |
| `p-scenes` | margo 0.37 / 0.08 / 1556 / 24; three-webgl-parity 3.16 / 2.34 / 278 / 28 (`20261025-132015-d3fec42e-dev`) | faster |  |  | 0.994, 0.81 | 28,146 / 1,607 |
| `p-screen-effects` | margo 0.10 / 0.13 / 2983 / 98; three-webgpu-parity 0.83 / 0.06 / 870 / 149 (`20261025-162530-d3fec42e-dev`) | slower |  |  | 0.528, 15.89 (differs) | 55,897 / 1,607 |
| `p-shadow-catcher` | margo 0.90 / 0.22 / 827 / 134; three-webgl-parity 1.53 / 0.92 / 543 / 29 (`20261025-135606-d3fec42e-dev`) | faster | margo 0.93 / 0.23 / 814 / 192; three-webgl-parity 1.67 / 1.05 / 517 / 30 (`20261026-073905-14354737-dev`) | faster | 0.993, 0.58 | 86,339 / 1,607 |
| `p-skeleton-clone` | margo 84.50 / 87.24; three-webgl-parity 8.12 / 11.80 (`20261025-162001-d3fec42e-dev`) | slower | margo 17.62 / 23.23; three-webgl-parity 7.76 / 11.63 (`20261026-203857-67216c40-dev`) | slower |  | 102,830 / 1,613 |
| `p-skeleton-helper` | margo 2.79 / 1.13 / 313 / 130; three-webgl-parity 1.50 / 1.51 / 533 / 43 (`20261025-163815-d3fec42e-dev`) | slower |  |  | 0.948, 4.39 | 119,853 / 1,607 |
| `p-sky` | margo 0.09 / 0.06 / 2973 / 156; three-webgl-parity 0.75 / 0.08 / 990 / 21 (`20261025-155040-d3fec42e-dev`) | faster |  |  | 0.992, 5.75 | 46,969 / 1,607 |
| `p-smaa` | margo 0.09 / 0.08 / 3006 / 118; three-webgl-parity 0.82 / 0.21 / 911 / 26 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.989, 0.91 | 48,182 / 1,607 |
| `p-spot` | margo 0.10 / 0.16 / 2928 / 58; three-webgl-parity 0.61 / 0.15 / 1136 / 22 (`20261025-152656-d3fec42e-dev`) | faster |  |  | 0.993, 0.63 | 41,295 / 1,607 |
| `p-spot-shadows` | margo 0.18 / 0.13 / 2331 / 85; three-webgl-parity 1.60 / 1.04 / 513 / 28 (`20261025-152656-d3fec42e-dev`) | faster | margo 0.18 / 0.12 / 2366 / 87; three-webgl-parity 1.54 / 0.99 / 542 / 27 (`20261025-170145-d3fec42e-dev`) | faster | 0.993, 0.62 | 51,103 / 1,607 |
| `p-sprites` | margo 0.07 / 0.03 / 3369 / 61; three-webgl-parity 6.91 / 4.63 / 135 / 27 (`20261025-165203-d3fec42e-dev`) | faster |  |  | 0.915, 5.02 | 48,685 / 1,607 |
| `p-ssao` | margo 0.12 / 0.36 / 1662 / 137; three-webgpu-parity 0.86 / 0.27 / 846 / 172 (`20261025-162530-d3fec42e-dev`) | slower |  |  | 0.809, 5.83 (differs) | 51,482 / 1,607 |
| `p-ssgi` | margo 0.12 / 0.67 / 1227 / 163; three-webgpu-parity 0.84 / 1.05 / 778 / 218 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.644, 13.47 (differs) | 53,271 / 1,607 |
| `p-ssr` | margo 0.12 / 0.42 / 1826 / 139; three-webgpu-parity 0.86 / 0.91 / 837 / 191 (`20261025-162530-d3fec42e-dev`) | faster |  |  | 0.567, 16.2 (differs) | 52,532 / 1,607 |
| `p-stl` | margo 111 / 120; three-webgpu-parity 2.69 / 3.65 (`20261025-161120-d3fec42e-dev`) | slower | margo 4.71 / 8.85; three-webgpu-parity 2.70 / 3.75 (`20261026-211213-83c79d15-dev`) | slower |  | 87,678 / 1,613 |
| `p-stl-cad` | margo 29.43 / 42.44; three n/a (`20261026-201722-907e13a5-dev`) | three missing | margo 32.18 / 44.49; three n/a (`20261026-211213-83c79d15-dev`) | three missing |  |  |
| `p-stl-normals` | margo 4.71 / 8.78; three-webgpu-parity 8.70 / 15.42 (`20261026-211213-83c79d15-dev`) | faster |  |  |  | 87,678 / 1,613 |
| `p-svg` | margo 74.78 / 105; three-webgpu-parity 36.90 / 52.12 (`20261025-161120-d3fec42e-dev`) | slower |  |  |  | 65,814 / 1,607 |
| `p-taa` | margo 5.41 / 1.41 / 156 / 107; three-webgpu-parity 1.80 / 0.24 / 466 / 175 (`20261025-162530-d3fec42e-dev`) | slower | margo 0.56 / 0.12 / 731 / 101; three-webgpu-parity 1.73 / 0.24 / 491 / 174 (`20261026-180213-3a2c2412-dev`) | faster | 0.641, 2.86 (differs) | 40,394 / 1,607 |
| `p-text` | margo 22.56 / 45.49; three-webgl-parity 7.60 / 19.89 (`20261025-134730-d3fec42e-dev`) | slower |  |  |  | 48,439 / 1,607 |
| `p-texture-decode` | margo 8.86 / 34.17; three-webgpu-parity 5.54 / 49.59 (`20261025-134730-d3fec42e-dev`) | slower | margo 9.33 / 35.38; three-webgpu-parity 5.92 / 52.87 (`20261025-144617-d3fec42e-dev`) | slower |  | 162,939 / 1,607 |
| `p-texture-formats` | margo 0.34 / 3.59; three-webgpu-parity 0.14 / 2.02 (`20261025-134730-d3fec42e-dev`) | slower | margo 0.34 / 3.88; three-webgpu-parity 0.14 / 2.23 (`20261025-161120-d3fec42e-dev`) | slower |  | 40,781 / 1,607 |
| `p-tonemap` | margo 0.09 / 0.11 / 3086 / 71; three-webgl-parity 0.59 / 0.05 / 1171 / 20 (`20261025-155040-d3fec42e-dev`) | slower |  |  | 0.909, 8.18 (differs) | 36,880 / 1,607 |
| `p-toon` | margo 180 / 4.09 / 6 / 3921; three-webgl-parity 7.78 / 5.26 / 121 / 30 (`20261025-135606-d3fec42e-dev`) | slower | margo 4.59 / 1.09 / 187 / 113; three-webgl-parity 7.53 / 6.25 / 125 / 30 (`20261026-071108-14354737-dev`) | faster | 0.995, 0.74 | 73,557 / 1,607 |
| `p-transform-controls` | margo 0.14 / 0.05 / 2342 / 24; three-webgl-parity 0.88 / 0.18 / 823 / 24 (`20261025-163700-d3fec42e-dev`) | faster |  |  | 0.985, 1.11 | 38,601 / 1,607 |
| `p-transmission` | margo 0.50 / 0.21 / 1254 / 194; three-webgpu-parity 1.02 / 0.27 / 753 / 222 (`20261025-135606-d3fec42e-dev`) | faster | margo 0.46 / 0.21 / 1394 / 216; three-webgpu-parity 0.98 / 0.28 / 759 / 275 (`20261026-073905-14354737-dev`) | faster | 0.819, 5.38 (differs) | 87,173 / 1,607 |
| `p-transparency` | margo 24.08 / 4.74 / 36 / 935; three-webgpu-parity 1.78 / 0.81 / 452 / 173 (`20261025-135606-d3fec42e-dev`) | slower | margo 0.90 / 0.05 / 843 / 61; three-webgpu-parity 1.65 / 0.62 / 484 / 172 (`20261026-105135-fbc01bdc-dev`) | faster | 0.983, 2.44 | 74,255 / 1,607 |
| `p-unlit` | margo 168 / 3.85 / 6 / 4234; three-webgl-parity 6.46 / 3.87 / 144 / 24 (`20261025-135606-d3fec42e-dev`) | slower | margo 4.94 / 1.16 / 183 / 111; three-webgl-parity 6.52 / 3.81 / 146 / 21 (`20261026-080031-fd52ab3b-dev`) | faster | 0.997, 0.34 | 169,017 / 1,607 |
| `p-usdz` | margo 0.09 / 1.69; three n/a (`20261025-161120-d3fec42e-dev`) | not run |  |  |  |  |
| `p-uv-transform` | margo 64.55 / 4.25 / 15 / 1757; three-webgl-parity 6.71 / 5.13 / 140 / 99 (`20261025-144617-d3fec42e-dev`) | slower | margo 2.87 / 0.15 / 307 / 214; three-webgl-parity 6.53 / 5.46 / 141 / 98 (`20261026-143425-9bce9eb3-dev`) | faster | 0.994, 1.09 | 176,154 / 1,607 |
| `p-video` | margo 10.70 / 1.82 / 68 / 626; three-webgl-parity 0.83 / 0.11 / 900 / 26 (`20261025-144617-d3fec42e-dev`) | slower | margo 0.46 / 0.06 / 1038 / 181; three-webgl-parity 0.75 / 0.08 / 994 / 27 (`20261026-165034-594c45af-dev`) | faster | 0.929, 3.22 | 178,971 / 1,607 |
| `p-view-helper` | margo 0.17 / 0.10 / 1794 / 17; three-webgl-parity 9.49 / 6.68 / 99 / 38 (`20261025-163815-d3fec42e-dev`) | faster |  |  | 0.973, 2.51 | 33,942 / 1,607 |
| `p-volumetric` | margo 0.23 / 0.22 / 1879 / 177; three-webgpu-parity 2.23 / 0.18 / 375 / 217 (`20261025-155040-d3fec42e-dev`) | slower |  |  | 0.441, 31.88 (differs) | 57,881 / 1,607 |
| `p-vox` | margo 0.42 / 7.06; three-webgl-parity 0.49 / 4.33 (`20261025-161120-d3fec42e-dev`) | faster |  |  |  | 56,608 / 1,607 |
| `p-water` | margo 0.10 / 0.26 / 2391 / 141; three-webgpu-parity 1.68 / 0.18 / 492 / 192 (`20261025-165203-d3fec42e-dev`) | slower |  |  | 0.956, 3.89 | 51,082 / 1,607 |
| `p-webgl2` | margo 0.15 / 0.10 / 2503 / 8; three-webgl-parity 7.56 / 4.92 / 124 / 28 (`20261025-133001-d3fec42e-dev`) | faster |  |  | 1, 0.3 | 32,886 / 1,607 |
| `p-wireframe` | margo 8.30 / 3.18 / 93 / 512; three-webgl-parity 0.64 / 0.70 / 1125 / 21 (`20261025-135606-d3fec42e-dev`) | slower | margo 0.33 / 0.51 / 1584 / 92; three-webgl-parity 0.66 / 0.71 / 1147 / 21 (`20261026-110621-fbc01bdc-dev`) | faster | 0.988, 0.9 | 172,084 / 1,607 |
| `shadows-1000` | margo 0.86 / 0.69 / 872 / 76; three-webgl-parity 2.35 / 1.69 / 375 / 28 (`20261025-170145-d3fec42e-dev`) | faster |  |  | 0.97, 1.46 | 38,833 / 1,607 |
| `shapes-10000-batched` | margo 0.12 / 0.08 / 2775 / 81; three-webgl-parity 1.16 / 0.46 / 681 / 40 (`20261025-170145-d3fec42e-dev`) | faster |  |  | 0.977, 1.34 | 173,652 / 1,607 |
