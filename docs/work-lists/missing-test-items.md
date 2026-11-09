# Required test items audit

## README five ownership (2026-11-09)

Lane Q, branch `readme-five`, owns these five executable README exceptions under
the private codex-readme-five brief. Lane C should leave these rows to lane Q:

- `react/readme-first-scene-e7b2ea`: page harness React named exports.
- `react/readme-pointer-events-and-picking-8b5eb7`: browser dependency isolation.
- `stage/readme-feature-entries-a6844a`: static glTF fixture selection.
- `text/readme-prebuilt-atlases-bitmapfont-5ec840`: missing licensed font atlas.
- `worker/readme-margoengine-worker-b56e85`: page/worker companion setup.

Claimed only; runtime fixes and evidence follow in separate pushes.

Started 2026-11-09 from origin/main `c1646e3ec`. This is an active work list, not a completion claim.
The scan covers package tests, root tests and scripts; limits, known bugs, claims, build-record,
work-lists and busy-retests; the main checkout's private report/handoff files and ci-status.json.
The private CI record is CPU-only and passed; it supplies no GPU or missing-file rerun evidence.
Raw searches and command logs stay in this lane's ignored `test-results/missing-items` folder.

Batch 160's 14 items belong to [its audit](batch-160-skips.md): interactivity conformance,
ten gltf-pro physics sample tests, tower.glb and two complete SPZ captures. They are excluded here,
not counted as fresh reruns. Physics and physics2d are on hold. No files in either package change.

## Executable missing-evidence paths

Every row below formerly skipped or returned successfully when its input was absent. Required
fixture reads now name the exact file and recovery command and refuse Git LFS pointers. The
validator is required once in exporters' test helper, so all validator-dependent tests fail when
its installation is absent. The Python setup still attempts its pinned installation; failure now
fails the test/browser command even without an environment flag.

| ID | Location and check | Required item and recovery/source | Licence | Status |
| --- | --- | --- | --- | --- |
| E01 | environment/tests/environment.test.js, half-table paired parse work | BrightRings.exr; `node packages/environment/scripts/fetch-fixtures.mjs` | OpenEXR images BSD-3-Clause | Downloaded; strict CPU rerun passed |
| E02 | same, real ZIP image | BrightRings.exr, same pinned fetch | BSD-3-Clause | Same |
| E03 | same, real PIZ image | AllHalfValues.exr, same pinned fetch | BSD-3-Clause | Same |
| E04 | same, corruption loop's formerly omitted file | AllHalfValues.exr, same pinned fetch | BSD-3-Clause | Same |
| E05 | same, RGBE digest | sun_sky.hdr; `node packages/environment/scripts/make-hdr-fixture.js` | Margo-authored | Present; strict CPU rerun passed |
| E06 | loaders/tests/loaders.test.js, PLY fixture comparison | torus.ply, torus_be.ply, torus_le.ply, torus_colored.ply; `node packages/loaders/scripts/make-fixtures.js` | Margo-authored | Present; strict CPU rerun passed |
| E07 | loaders/tests/loaders.test.js, OFF files | box.off and mctri.off; `npm run fixtures --workspace @margoengine/loaders`; John Burkardt Geomview standard collection | GNU LGPL, explicitly granted to data by off.html; full licence texts supplied | Downloaded; full vertex/triangle comparisons pass. Legacy knight retained for held physics and existing workloads only |
| E08 | same, XYZ file | helix.xyz; make-fixtures.js | Margo-authored | Present; strict CPU rerun passed |
| E09 | same, PCD files | rose.pcd, spiral.pcd (make-fixtures.js), bunny.pcd (`npm run fixtures --workspace @margoengine/loaders`) | Margo-authored; PCL BSD-3-Clause | PCL file downloaded; strict CPU rerun passed |
| E10 | same, VTK files | fran_cut.vtk, polyEx.vtk; loaders fixture fetch | PyVista data Apache-2.0 | Downloaded; strict CPU rerun passed |
| E11 | same, 3MF files | gears.3mf, face_colors.3mf, corner_colors.3mf; make-fixtures.js | Margo-authored | Present; strict CPU rerun passed |
| E12 | loaders/tests/dae-animation.test.js, COLLADA feeds Skeleton/Skin | packages/animation/dist/index.js; `npm run build:packages` | Margo-authored | Built; strict CPU rerun passed |
| E13 | decoders/tests/meshopt.test.js, 62 compressed bufferViews | MeshoptCubeTest and Triangle.meshopt buffers named by tests/fixtures/meshopt-views.json; `git lfs pull` | Existing Khronos notices through supply-chain.mjs | Checked out; strict CPU rerun passed |
| E14 | exporters/tests/data-scene-extensions.test.js | node_modules/gltf-validator; `npm ci` in checkout or MARGOENGINE_EXPORTERS_TOOLS | Apache-2.0 | Installed; strict CPU rerun passed |
| E15 | exporters/tests/exporters.test.js | same validator | Apache-2.0 | Same |
| E16 | exporters/tests/extra-sets.test.js | same validator | Apache-2.0 | Same |
| E17 | exporters/tests/glb-append.test.js | same validator | Apache-2.0 | Same |
| E18 | exporters/tests/keyframes.test.js | same validator | Apache-2.0 | Same |
| E19 | exporters/tests/model.test.js | same validator | Apache-2.0 | Same |
| E20 | exporters/tests/rich-scene.test.js | same validator | Apache-2.0 | Same |
| E21 | exporters/tests/roblox.test.js | same validator | Apache-2.0 | Same |
| E22 | exporters/tests/skin.test.js | same validator | Apache-2.0 | Same |
| E23 | exporters/tests/transform-precision.test.js | same validator | Apache-2.0 | Same |
| E24 | exporters/tests/material-groups.test.js, validation early return | same validator | Apache-2.0 | Same |
| E25 | exporters/tests/physical-maps.test.js, validation early return | same validator | Apache-2.0 | Same |
| E26 | tests/margo-convert-textures.test.js, sharp tests | sharp encoder installation; `npm ci` in tools/margo-convert | Apache-2.0; native library notices in installed package | Installed; strict CPU rerun passed |
| E27 | tests/python-package.test.js | pinned notebook Python venv; `npm run setup:python-test` | Per python/requirements-notebook.txt package notices | Strict CPU rerun passed |
| E28 | python/tests/jupyter-browser.mjs | same venv, JupyterLab and Notebook | Same | Passed: JupyterLab/Notebook figures, camera/picking, late connection and fig.to_png |

The original combined E01-E25 rerun passed 561 tests, zero failures/skips. This is evidence
that the existing fixtures work, not evidence that the missing-input behaviour was correct.
The strict combined package/support run passed 1,471 tests with zero failures/skips. The final
fixture-gate regression run passed 15 tests, including missing-validator and failed-download cases. No parser or renderer result/tolerance changed.

## Download provenance

Only standard test assets were fetched; no renderer implementation was read or copied.
All fresh downloads below are SHA-256 checked by the fetch helper. Sources are routed through
`scripts/supply-chain.mjs` and the existing fixture notices. Text fixtures may have CRLF in a
Windows checkout; download hashes refer to source bytes, before Git line-ending conversion.

| Files | Pinned source | Licence/source qualification |
| --- | --- | --- |
| BrightRings.exr, AllHalfValues.exr | [OpenEXR images e38ffb0790f62f05a6f083a6fa4cac150b3b7452](https://github.com/AcademySoftwareFoundation/openexr-images/tree/e38ffb0790f62f05a6f083a6fa4cac150b3b7452/TestImages) | BSD-3-Clause; existing environment fixture NOTICE |
| bunny.pcd | [PCL 3aac7b68cc8f26428ba9c9192d990c0c21cc5a7d](https://github.com/PointCloudLibrary/pcl/blob/3aac7b68cc8f26428ba9c9192d990c0c21cc5a7d/test/bunny.pcd) | BSD-3-Clause; Stanford scan attribution in SOURCES.txt |
| fran_cut.vtk, polyEx.vtk | [PyVista data 5a3de12d34c24aa5dd5e5db1cbc2defebc0d4da3](https://github.com/pyvista/data/tree/5a3de12d34c24aa5dd5e5db1cbc2defebc0d4da3/Data) | Apache-2.0, repository LICENSE |
| box.off, mctri.off | [John Burkardt Geomview standard data](https://people.sc.fsu.edu/~jburkardt/data/off/off.html) | Explicit GNU LGPL data grant, version unspecified; unchanged source bytes with hashes in fetch-fixtures.js and full licence texts. Old cube removed; old knight preserved solely for held physics/workloads |

## Remaining missing-file proof work

These are discovery items, not successful reruns. A candidate source is a place to search,
not a verified download or licence grant. Do not replace any of these with generated proof.

| ID | Location / existing claim | Missing item | Candidate source and licence to verify | Status |
| P01 | limits, Goxel/VoxEdit formats | VXM 3, 5-11, 13 samples, especially old compressed textures and pivots | VoxEdit public sample packs; per-file licence not yet found | Pending source search and real-file rerun |
| P02 | limits FBX layers, LIM-280 | real partial Override weight and TCB curve files | Autodesk sample-file licence or openly licensed author export | Pending |
| P03 | LIM-281, FBX inherit | type 0 rig below a sheared parent | Same, independently authored FBX | Pending |
| P04 | limits FBX deformers, LIM-296 | additive-cluster FBX | Same | Pending |
| P05 | build-record batch 43 | 31 files' absent/PSD textures, real layer-compositing reference | Original model publishers; individual image licences | Pending; identify files from original corpus manifest |
| P06 | build-record material features job 5 | mip chain from a real tool | Khronos KTX-Software standard texture test data, Apache-2.0 to verify | Pending |
| P07 | build-record eyes job 6 | actual eyeball mesh/reference, not Seed-san iris plate | Openly licensed anatomy model and measurement/reference | Pending |
| P08 | build-record glTF extensions job 1 | published mixed mesh/splat depth sample | Khronos/Cesium sample data; per-model licence | Pending; tower alone belongs to batch 160 |
| P09 | build-record glTF extensions job 8 | published click-driven material behaviour | Khronos interactivity example corpus, CC-BY-4.0 to verify | Pending; conformance download belongs to batch 160 |
| P10 | build-record metadata job | real cc:license, xmpRights:UsageTerms/WebStatement and non-mesh 3MF objects | Public 3MF Consortium sample data; per-file licence | Pending |
| P11 | build-record VFX jobs | external reference render for real scene effects | Public renderer output only, with matching authored scene and open asset licences | Pending |
| P12 | limits splats/animate, LIM-490 | real 4D/rigged splat capture | Public dynamic capture datasets, per-dataset licence | Pending |
| P13 | limits tiles/s2, LIM-362 | real S2 tileset | Cesium 3D Tiles standard sample data, Apache-2.0 to verify | Pending |
| P14 | limits correctives, LIM-232 | authored corrective morph model | Openly licensed Blender/Maya rig; per-model licence | Pending |
| P15 | limits face, LIM-237 | real ARKit-named face model and tracker frames | Public face capture sample, explicit model/data licence | Pending; live tracker separately needs hardware |
| P16 | limits PVR, decoder batch job 7 | real PVRTC cube and array texture | Imagination public texture samples/tools; licence not yet verified | Pending |
| P17 | limits images, LIM-285 | public glTF with MSFT_texture_dds | Microsoft glTF sample assets, per-model licence | Pending |
| P18 | limits Draco points | public point cloud with generic attributes | Google Draco standard test data, Apache-2.0 to verify | Pending; encoder-created proof remains labelled |
| P19 | limits long-tail loaders, LIM-195 | rigged LWO with bones and weight maps | Freely licensed LightWave model corpus | Pending source/licence |
| P20 | limits real files | valid real big-endian PLY | John Burkardt cow.binary.ply has an LGPL grant, but is malformed: 75,670 bytes instead of its declared 75,673; face 5,008 contains out-of-range index 3,587 | Downloaded and correctly refused. Valid-file proof remains pending; no parser tolerance or refusal changed |
| P21 | same | LDraw MPD | LDraw models; verify model-specific CC licence | Passed: 13 embedded submodels, 526,895 triangles, zero missing parts/warnings with the pinned library and four licensed sticker dependencies |
| P22 | same | zipped AMF | Public 3MF/AMF consortium or slicer sample data; per-file licence | Passed: real Slic3r ZIP, 8 vertices/12 triangles; every placed coordinate/triangle matches the independent XML oracle. Fixed the proof harness to include constellation placement, with a regression |
| P23 | same | PTS with intensity and colour | Public survey dataset, CC0/CC-BY/public domain | Passed: PDAL autzen.pts, all 10 coordinates, signed intensities and RGB values compared with source text |
| P24 | same | chemistry XYZ with clear licence | Public molecular dataset, CC0/public domain | Passed: Open Babel test3d.xyz, all 25 labelled atom coordinates compared with source text; pinned GPL-2.0 data-only download |
| P25 | limits USD reset stacks, LIM-324 | independently authored resetting USD stage | OpenUSD standard test data, Apache-2.0 to verify | Pending |
| P26 | limits MaterialX, LIM-331/205 | RealityKit material file and MaterialX rendered reference | Apple public sample-file grant; MaterialX standard examples Apache-2.0 to verify | Pending |
| P27 | limits LAS/LAZ | compressor 0/1 v2 items, chunk size 0 from an outside writer | LASzip/laz-rs standard data, Apache-2.0 to verify | Pending; unsupported item-v1 is not a missing proof |
| P28 | limits video/material and /360 | real movie and stereo panorama | Blender Foundation movies CC-BY; panorama-specific licence | Pending; headset proof needs device |
| P29 | limits video/codecs, LIM-575 | real AVC movie with B-frames | Same, retain source codec metadata and licence | Pending |
| P30 | private batch-110 report and known-bugs README 404 history | pointer-show.glb and the other missing example asset | Margo-authored pointer-show now exists; current README runner selects both examples | Scoped README command rerun: 62/94 ran, 32 allowed failures; further sample work remains; do not duplicate batch 160 fix |
| P31 | loaders README VDB example | smoke.vdb with a density grid | OpenVDB website repository 3d8fd4d3f2d670464f4390e2775cfc87274233dc, explicit CC-BY-4.0 LICENSE.txt | Sphere and smoke downloaded; real files exposed empty-half-value-block alignment bug, fixed with sphere and synthetic regressions. README density example passed with the explicit smoke mapping; exception removed |
| P32 | headless README image-sequences-and-video-37bcc7 | discoverable ffmpeg binary | FFmpeg official download links, LGPL/GPL build configuration to record | Passed: original headless FFmpeg example using publisher-hash-checked FFmpeg 8.1.2 GPL-3.0; optional fetch/install flag and child-only PATH wiring |
| H01 | physics/scripts/test-browser.js | outside Rapier runtime named by MARGOENGINE_RAPIER | npm @dimforge/rapier3d-compat, Apache-2.0 | Physics on hold; list only, no change/rerun |
| H02 | limits ragdoll/getup | authored get-up clips, not reversed Death_A/B | Public motion-capture dataset, verify data licence | Physics on hold; list only |
| H03 | limits ragdoll/profile | real Mixamo-named rig, not renamed Knight | Public rig with explicit licence | Physics on hold; list only |

Standalone hardware gaps (headsets, real AR phone, gamepad/pen/gyro devices, OpenGL ES/D3D11
class adapter, other GPUs and Safari/macOS) are not missing downloadable fixtures. None is
claimed resolved here. No new hardware blocker was observed in the initial 561-test rerun.
Missing features, intentional unsupported formats, prior failures already fixed, licence-only
metadata, timing-only busy-retests and ordinary generated numerical oracles are not silently
promoted to missing-file skips.

## Gate and regression evidence

`scripts/check-fixture-skips.mjs` parses executable syntax, catches missing-fixture skip calls,
skip options (including aliases), successful early returns/continues and nullable fixture reads.
`tests/fixture-skips.test.js` runs that audit in every verify, so it also runs in check:merge.
It tests the old missing-input patterns as negative cases, ignores comments and descriptive
strings, and verifies that absent data, LFS pointers, failed downloads and digest changes fail.
The four batch-160 files and held physics packages are explicit ownership exclusions. This
gate is a guard against the audited patterns; it is not a proof of arbitrary program control flow.

## README exceptions caused by missing or misserved files

The previous scoped command ran 62/94 examples, with 32 accepted failures. The baseline known list had
102 exceptions. Upstream `418849c4a` subsequently closed the voxel-pathtracer introduction (101 left at first landing). These 57 entries name missing files/tools or received incompatible fallback bytes
(including Vite HTML). Each needs a format-correct, licensed input and a real rerun. Existing package
fixture notices are the first source; no arbitrary tiny fixture or renamed rig proves a README example.

| Stable example ID | Requested files | Original failure | Status |
| --- | --- | --- | --- |
| animation/readme-geometry-caches-margoengine-anim-dcf6c5 | /flag.mgc | sample: MargoError: Geometry cache request failed with status 404; check the URL | Pending file selection, provenance and rerun |
| decoders/readme-any-image-to-pixels-margoengine-86f34e | See named example | sample: TypeError: Failed to fetch | Pending file selection, provenance and rerun |
| decoders/readme-basis-on-the-gpu-margoengine-dec-8314b0 | /texture.ktx2 | sample: TypeError: KTX2: invalid file (not KTX 2.0); pass an unmodified .ktx2 file | Passed with explicit licensed sample; exception removed |
| decoders/readme-brotli-margoengine-decoders-brot-f9820a | /node.br | sample: MargoError: Brotli stream is corrupt: a reserved bit is set | Passed with explicit licensed file/tool; exception removed |
| decoders/readme-draco-point-clouds-margoengine-d-5f1327 | /points.drc | sample: Error: Draco: invalid header; pass an unmodified .drc buffer | Passed with explicit licensed sample; exception removed |
| decoders/readme-hdr-ktx2-margoengine-decoders-kt-cbfebd | /environment.ktx2 | sample: Error: KTX2: invalid file (not KTX 2.0); pass an unmodified .ktx2 file | Passed with explicit licensed sample; exception removed |
| decoders/readme-jpeg-xl-margoengine-decoders-jxl-2c0973 | /texture.jxl | sample: MargoError: JPEG XL: neither a codestream nor a container signature is there; pass the complete bytes of a .jxl file | Passed with explicit licensed sample; exception removed |
| decoders/readme-ktx2-cube-maps-and-arrays-margoe-d255e4 | /sky.ktx2, /terrain.ktx2 | sample: TypeError: KTX2: invalid file (not KTX 2.0); pass an unmodified .ktx2 file | Passed with explicit licensed sample; exception removed |
| decoders/readme-margoengine-decoders-b7ae99 | /mesh.drc, /albedo.ktx2 | sample: Error: Draco: invalid header; pass an unmodified .drc buffer | Pending file selection, provenance and rerun |
| decoders/readme-meshopt-on-wasm-simd-margoengine-2685e0 | /meshopt.bin | sample: MargoError: EXT_meshopt_compression: bad vertex stream header | Pending file selection, provenance and rerun |
| decoders/readme-pcx-margoengine-decoders-pcx-150025 | /skin.pcx | sample: MargoError: PCX does not start with the manufacturer byte 10; pass the complete bytes of a valid PCX file | Passed with explicit licensed file/tool; exception removed |
| decoders/readme-pvr-margoengine-decoders-pvr-44fd95 | /texture.pvr | sample: MargoError: PVR: this is not a PVR file; check the path | Passed with explicit licensed sample; exception removed |
| decoders/readme-streaming-ktx2-mips-margoengine-d0b4d7 | /rock.ktx2 | sample: MargoError: KTX2: could not load /rock.ktx2 (404) | Passed with explicit licensed sample; exception removed |
| decoders/readme-tga-tiff-dds-and-ktx-1-margoengi-d480af | /image.tga, /image.tiff, /texture.dds | sample: MargoError: TIFF header is missing; pass the complete bytes of a valid TIFF file | Passed with explicit licensed sample; exception removed |
| environment/readme-ultrahdr-9c0c80 | /studio.exr | sample: MargoError: Invalid EXR: bad magic number; the file is damaged or not OpenEXR, export it again | Passed with explicit licensed sample; exception removed |
| fbx/readme-animation-layers-and-cubic-curve-656b9b | /assets/take.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Passed with explicit licensed sample; exception removed |
| fbx/readme-cameras-and-lights-d4d4b9 | /assets/shot.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Passed with explicit licensed sample; exception removed |
| fbx/readme-margoengine-fbx-4c9214 | /assets/character.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-nurbs-curves-and-lines-4d004a | /assets/route.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-pbr-materials-and-layered-textur-fbbc99 | /assets/crate.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Passed with explicit licensed sample; exception removed |
| fbx/readme-scale-inheritance-b099af | /assets/maya-rig.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-skinning-modes-and-in-between-sh-84ddc1 | /assets/hero.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-uv-sets-and-colour-layers-c13313 | /assets/room.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Passed with explicit licensed sample; exception removed |
| headless/readme-image-sequences-and-video-37bcc7 | See named example | example: Error [MargoError]: ffmpeg was not found; see https://margoengine.com/errors#headless | Passed with explicit licensed file/tool; exception removed |
| loaders/readme-3ds-lwo-amf-md2-pdb-and-kmz-389243 | /models/tank.md2 | sample: LoaderError: MD2: missing the IDP2 magic | Passed with explicit licensed sample; exception removed |
| loaders/readme-3mf-textures-and-colour-groups-3b539a | /prints/lithophane.3mf | sample: LoaderError: 3MF: not a ZIP package (missing PK signature) | Passed with explicit licensed sample; exception removed |
| loaders/readme-collada-cameras-lights-lookat-an-174ec9 | /text.txt | sample: LoaderError: DAE: closing tag </head> does not match <meta> | Passed with explicit licensed sample; exception removed |
| loaders/readme-collada-skins-morphs-and-animati-62e902 | /text.txt | sample: LoaderError: DAE: closing tag </head> does not match <meta> | Passed with explicit licensed sample; exception removed |
| loaders/readme-fonts-and-3d-text-0a2991 | /fonts/Inter.ttf | sample: LoaderError: TTF: not a TrueType font (signature '<!DO'); pass the bytes of a .ttf file | Passed with explicit licensed sample; exception removed |
| loaders/readme-las-and-laz-280f6c | /surveys/quarry.laz | sample: LoaderError: LAS: LAS file shorter than its 227-byte header; the file is truncated | Passed with explicit licensed sample; exception removed |
| loaders/readme-lottie-55f6d2 | /motion/logo.json | sample: LoaderError: Lottie: bad JSON (Unexpected token '<', "<!DOCTYPE "... is not valid JSON) | Passed with explicit licensed sample; exception removed |
| loaders/readme-margoengine-loaders-6065f6 | /parts/bracket.3mf, /scans/part.ply | sample: LoaderError: load: request for /parts/bracket.3mf returned HTTP 404 | Passed with explicit licensed sample; exception removed |
| loaders/readme-stl-c220c0 | /parts/bracket.stl | sample: LoaderError: STL: the header declares 171861356 triangles (8593067884 bytes) but the data has 156; pass the whole file | Passed with explicit licensed sample; exception removed |
| loaders/readme-svg-6d7995 | /logo.svg | sample: LoaderError: SVG: closing tag </head> does not match <meta> | Passed with explicit licensed sample; exception removed |
| loaders/readme-textured-obj-meshes-b6f1ea | /crate.mtl, /models/crate.obj | sample: LoaderError: OBJ: the OBJ has no faces to draw as a mesh; draw its points with pointsToGeometry instead | Pending file selection, provenance and rerun |
| loaders/readme-textured-obj-meshes-c37231 | See named example | sample: LoaderError: load: request for https://example.com/models/chair.obj failed (Failed to fetch) | Pending file selection, provenance and rerun |
| loaders/readme-xml-128d10 | /map.tmx | sample: LoaderError: TMX: closing tag </head> does not match <meta> | Passed with explicit licensed sample; exception removed |
| materials/readme-ktx2-textures-11832d | /textures/albedo.ktx2 | sample: MargoError: Texture download request failed: HTTP 404; check the URL and that the server serves it | Passed with explicit licensed full sample; exception removed |
| materials/readme-ktx2-textures-8d6d24 | /textures/sky-cube.ktx2 | sample: MargoError: Texture download request failed: HTTP 404; check the URL and that the server serves it | Passed with explicit licensed full sample; exception removed |
| points/readme-copc-files-margoengine-points-co-e8bfa1 | /scan.copc.laz | sample: MargoError: GET /scan.copc.laz answered 404; check the URL and that the server allows it | Passed with explicit licensed sample; exception removed |
| points/readme-e57-scans-margoengine-points-e57-27ad6c | /scans/plant-room.e57 | sample: MargoError: GET /scans/plant-room.e57 answered 404; check the URL and the server | Passed with explicit licensed full sample; exception removed |
| points/readme-las-and-laz-scans-margoengine-po-2d683c | /scans/site.las | sample: MargoError: GET /scans/site.las answered 404; check the URL and the server | Passed with explicit licensed sample; exception removed |
| points/readme-las-and-laz-scans-margoengine-po-6ccdb7 | /scans/fullwave.laz, /scans/fullwave.wdp | sample: MargoError: GET /scans/fullwave.laz answered 404; check the URL and the server | Passed with explicit licensed sample; exception removed |
| points/readme-laz-decoder-margoengine-points-l-7c341a | /scans/site.laz | sample: MargoError: GET /scans/site.laz answered 404; check the URL and the server | Passed with explicit licensed sample; exception removed |
| points/readme-potree-folders-margoengine-point-41f702 | See named example | sample: MargoError: GET /scans/site/cloud.js answered 404; check the URL and that the server allows it | Pending file selection, provenance and rerun |
| points/readme-potree-folders-margoengine-point-5be661 | See named example | sample: MargoError: GET /scans/site/cloud.js answered 404; check the URL and that the server allows it | Pending file selection, provenance and rerun |
| splats/readme-margoengine-splats-f08e38 | /capture.splat | sample: Error: Failed to load splats: 404 | Pending file selection, provenance and rerun |
| splats/readme-ply-captures-editing-and-level-o-0d1416 | /capture.ply | sample: Error: Failed to load splats: 404 | Pending file selection, provenance and rerun |
| text/readme-prebuilt-atlases-bitmapfont-5ec840 | /fonts/inter.json | sample: TypeError: BitmapFont could not fetch http://127.0.0.1:50822/fonts/inter.json: 404; check the URL | Pending file selection, provenance and rerun |
| tonemap/readme-margoengine-tonemap-5802b3 | /grade.cube | sample: TypeError: .cube sample row is invalid; supply exactly size³ RGB rows after the size header | Pending file selection, provenance and rerun |
| usdz/readme-composition-fbebfe | /toy_car.usdz, /Kitchen_set/Kitchen_set.usd, /model.usd | sample: LoaderError: load: request for /toy_car.usdz returned HTTP 404 | Pending file selection, provenance and rerun |
| usdz/readme-margoengine-usdz-087124 | /model.usdz | sample: LoaderError: load: request for /model.usdz returned HTTP 404 | Pending file selection, provenance and rerun |
| voxel-edit/readme-voxel-files-657e4f | /models/robot.qb | sample: RangeError: QB file holds 1634476140 matrices, over 4096; split the file | Pending file selection, provenance and rerun |
| voxel/readme-bevels-and-baked-light-render-e03f31 | stone.png | sample: RangeError: BlockTextures size 195 is not a power of two from 1 to 4,096; pass 16, 32 or 64 | Pending file selection, provenance and rerun |
| voxel/readme-lighting-effects-day-and-night-w-9389c7 | stone.png, /studio.hdr | sample: RangeError: BlockTextures size 195 is not a power of two from 1 to 4,096; pass 16, 32 or 64 | Pending file selection, provenance and rerun |
| voxel/readme-magicavoxel-vox-files-margoengin-91a7da | castle.vox | sample: TypeError: Bytes are not a .vox file (no "VOX " header and MAIN chunk); pass a MagicaVoxel .vox file | Pending file selection, provenance and rerun |
| voxel/readme-rendering-margoengine-voxel-rend-1a55a2 | stone.png, dirt.png, grass-top.png, grass-side.png | sample: RangeError: BlockTextures size 195 is not a power of two from 1 to 4,096; pass 16, 32 or 64 | Pending file selection, provenance and rerun |

## README exceptions, other causes

Scott deferred these 45 exceptions to a later job (2026-11-09). They include API/example, rig,
clip, configuration and runtime failures; the old sample label alone does not prove missing bytes.
Their original reasons are preserved. No known-list entry was added, removed or relaxed in this group.

| Stable example ID | Requested files | Original failure | Status |
| --- | --- | --- | --- |
| animation/readme-cloning-and-retargeting-margoeng-88181c | /RobotExpressive.glb, /mixamo-walk.glb, /hero.glb | sample: RangeError: Retarget maps Hips to mixamorig:Hips, which the source does not have; fix the names map | Deferred to later README job |
| animation/readme-gpu-morph-weights-margoengine-an-43200e | /face.glb | sample: RangeError: Unknown animation clip; pass a clip name or an index from animation.clips | Deferred to later README job |
| animator/readme-foot-placement-feet-on-uneven-gr-4d8939 | /hero.glb | sample: RangeError: Foot placement pelvis -1 is not one of the model's 26 glTF nodes | Deferred to later README job |
| animator/readme-full-body-ik-margoengine-animato-81e42f | /hero.glb | sample: RangeError: Full-body IK pelvis -1 is not one of the model's 26 glTF nodes | Deferred to later README job |
| animator/readme-inertialization-margoengine-anim-e5c7d9 | /hero.glb | sample: RangeError: Unknown animator clip "Stop"; use a clip name from animation.clips | Deferred to later README job |
| animator/readme-look-at-and-aim-constraints-6c3118 | /hero.glb | sample: RangeError: Look-at joint -1 is not one of the model's 26 glTF nodes | Deferred to later README job |
| animator/readme-margoengine-animator-e4207e | /hero.glb | sample: TypeError: CCD chain joints must be 1-256 of this model's glTF node indices | Deferred to later README job |
| animator/readme-motion-matching-margoengine-anim-f6a58c | /hero.glb | sample: RangeError: Motion database root -1 is not one of the model's 26 glTF nodes | Deferred to later README job |
| animator/readme-spline-ik-margoengine-animator-s-0733b6 | /hero.glb | sample: RangeError: Spline IK joints must be 2-256 of this model's glTF node indices | Deferred to later README job |
| animator/readme-state-graph-as-data-margoengine-f00e50 | /hero.glb | sample: RangeError: Unknown animator clip "Land"; use a clip name from animation.clips | Deferred to later README job |
| animator/readme-sync-groups-margoengine-animator-ced03a | /hero.glb | sample: RangeError: Unknown animator clip "Sprint"; use a clip name from animation.clips | Deferred to later README job |
| animator/readme-triggers-exit-times-any-state-tr-2794f3 | /hero.glb | sample: RangeError: Unknown animator clip "Land"; use a clip name from animation.clips | Deferred to later README job |
| cameras/readme-physical-exposure-margoengine-ca-6d1c49 | See named example | example: MargoError: Tonemap needs an explicit HDR source when another effect owns scene capture; pass options.source | Deferred to later README job |
| clustered/readme-ies-profiles-9e957a | /downlight.ies | sample: RangeError: Invalid IES file: no TILT= line; pass the text of a valid IES LM-63 photometric file | Deferred to later README job |
| cutscene/readme-render-to-video-4f9104 | theme.ogg | sample: EncodingError: Unable to decode audio data | Deferred to later README job |
| exporters/readme-render-to-file-80cd28 | See named example | example: TypeError: Cannot read properties of undefined (reading '1') | Deferred to later README job |
| exporters/readme-unity-asset-and-support-bundles-a4fd05 | See named example | example: MargoError: Unity import profile requires the explicit Margo Mesh Studio source profile; use general GLB for other generators; change the scene or choose anothe | Deferred to later README job |
| headless/readme-comparing-images-db338c | reference.png, difference.png | sample: RangeError: Images must be one size to compare; see https://margoengine.com/errors#headless | Deferred to later README job |
| headless/readme-image-sequences-and-video-9967ce | See named example | example: MargoError: readPixels needs an engine on createHeadlessCanvas; see https://margoengine.com/errors#headless | Deferred to later README job |
| input/readme-chords-contexts-rebinding-and-pr-5e2c1c | See named example | example: TimeoutError: signal timed out | Deferred to later README job |
| loaders/readme-3ds-lwo-amf-md2-pdb-and-kmz-406f48 | /models/teapot.3ds, /models/ship.lwo, /prints/bracket.amf, /models/knight.md2, /molecules/1crn.pdb, /maps/tower.kmz | sample: LoaderError: 3DS: missing the 0x4D4D main chunk | Passed with explicit licensed sample; exception removed |
| loaders/readme-optional-vertex-color-and-opacit-5d5952 | See named example | example: ReferenceError: document is not defined | Deferred to later README job |
| loaders/readme-vdb-volumes-573d3c | See named example | example: LoaderError: VDB: not an OpenVDB file | Passed with explicit licensed sample; exception removed |
| mesh-edit/readme-import-to-editable-meshes-and-fl-03d481 | /models/crate.glb | sample: TypeError: glTF accessor undefined does not exist; pass an index into accessors | Deferred to later README job |
| post/readme-smaa-10a00a | See named example | example: TypeError: Invalid plugin; see https://margoengine.com/errors#arguments | Deferred to later README job |
| quality/readme-tier-presets-0abcba | See named example | example: TypeError: Invalid plugin; see https://margoengine.com/errors#arguments | Deferred to later README job |
| ragdoll/readme-getting-up-margoengine-ragdoll-g-f43e55 | /hero.glb | sample: RangeError: Unknown animator clip "GetUpFromBack"; use a clip name from animation.clips | Physics on hold |
| react/readme-first-scene-e7b2ea | See named example | example: SyntaxError: The requested module ' does not provide an export named 'createContext' | Deferred to later README job |
| react/readme-pointer-events-and-picking-8b5eb7 | See named example | example: SyntaxError: The requested module ' does not provide an export named 'default' | Deferred to later README job |
| rigging/readme-corrective-shapes-margoengine-ri-ff3e5c | /hero.glb | sample: RangeError: Invalid morph target/weight; pass a morph target index the node has and a finite weight, on a live Animation | Deferred to later README job |
| rigging/readme-face-tracking-margoengine-riggin-8fff06 | character.glb | sample: MargoError: This model has no morph target named like a face shape; pass map, or vrm for an avatar | Deferred to later README job |
| rigging/readme-face-tracking-margoengine-riggin-f62f83 | /avatar.vrm | sample: MargoError: This model has no morph target named like a face shape; pass map, or vrm for an avatar | Deferred to later README job |
| rigging/readme-ik-chains-with-pole-targets-marg-138226 | /hero.glb | sample: RangeError: IK chain joint -1 is not one of the 26 bones; pass a valid index | Deferred to later README job |
| rigging/readme-retarget-presets-margoengine-rig-9101f3 | /mixamo-walk.glb, /godot-hero.glb | sample: RangeError: Retarget source naming is not recognised; pass from (mixamo, godot, roblox, margo or humanoid) | Deferred to later README job |
| rigging/readme-spring-bones-and-jiggle-margoeng-a41e82 | /hero.glb | sample: RangeError: Spring center must be the chain's first joint or an ancestor of it | Deferred to later README job |
| rigging/readme-vrm-avatars-margoengine-rigging-009c8e | /rigged.glb | sample: RangeError: This VRM is invalid; fix it: humanoid bone leftUpperLeg is required; humanoid bone leftLowerLeg is required; humanoid bone leftFoot is required; hum | Deferred to later README job |
| shadows/readme-margoengine-shadows-7183ea | See named example | example: TypeError: Invalid plugin; see https://margoengine.com/errors#arguments | Deferred to later README job |
| splats/readme-margoengine-splats-03fb4a | /capture.splat | sample: RangeError: A .splat file must hold 1 to 3,000,000 splats of 32 bytes each; check that the file is complete. | Deferred to later README job |
| splats/readme-ply-captures-editing-and-level-o-73481e | /capture.spz, /capture.sog | sample: RangeError: Not an SPZ file: it starts with neither gzip (versions 2-3) nor NGSP (version 4); check that the file is a complete .spz. | Deferred to later README job |
| stage/readme-feature-entries-a6844a | See named example | example: MargoError: Minimal glTF supports static uncompressed models; required extensions, skins and animations are unsupported; load it with @margoengine/gltf-pro | Deferred to later README job |
| voxel-net/readme-margoengine-voxel-net-b6eba6 | See named example | example: Error: Module "node:http" has been externalized for browser compatibility: a server and a page in one example | Deferred to later README job |
| voxel-pathtracer/readme-margoengine-voxel-pathtracer-af6ce0 | See named example | sample: TypeError: VoxelPathTracer scene.models[0].voxels has 151 entries; a 32x24x32 model needs 24576 (index = x + sx * (z + sz * y)) | Closed upstream by 418849c4a |
| voxel/readme-codecs-and-chunk-stores-codec-st-7e6699 | See named example | sample: InvalidStateError: Failed to execute 'send' on 'WebSocket': Still in CONNECTING state. | Deferred to later README job |
| worker/readme-margoengine-worker-b56e85 | See named example | example: MargoError: Worker failed before it took the canvas: bad message; see https://margoengine.com/errors#worker | Deferred to later README job |
| xr/readme-ar-hit-testing-f7eedf | See named example | example: MargoError: Native WebGPU XR bindings are unavailable; desktop rendering remains active. Use a browser with XRGPUBinding or request an inline session. | Deferred to later README job |

## Check results

First landing evidence: full verify on `cff40d127` plus the required-input and SQL-cleanup commits passed
13,214 tests, zero failures/skips (444.2 s). Lint and hygiene passed; the earlier standalone hygiene invocation
overlapped verify clearing `dist`, so its absent biomes declaration was repaired by that build before the passing
standalone run. The scoped voxel-net README check ran 11/12 examples, with its one pre-existing other-cause exception;
the earlier four-package README run remains 62/94 with its existing exceptions explicitly inventoried above.
After lane-M's GPU teardown fix landed, a capture-only validation request waited for all three GPU slots until its
480-second acquisition/process-tree deadline; no capture test started. It is not a test pass or a new renderer failure.
The earlier 18 passing GPU suites and the original capture rendering assertions remain the available GPU evidence.
The branch was rebased onto current main `14af78269` before this landing; no core, stage or physics source was changed.

The rebased full verify uncovered a separate SQL-store test lifecycle defect from current main. Windows
returned `EBUSY` when the first after-hook removed its open database; the failed hook prevented the later server
and generator-worker cleanup, and the watchdog ended that process after 360 silent seconds. The owning test now
uses test-body async disposal, with a real failed-setup regression. Its seven focused tests pass with zero skips.
The GPU teardown fix remains owned by lane-M and has since landed as `cff40d127`; this lane makes no GPU cleanup change.

Lint and hygiene passed; the strict package/support run passed 1,471 tests and the fixture gate 15,
zero failures/skips. Selected GPU suites: 18 pass, one teardown failure after all capture assertions
passed. Scott assigned the GPU teardown root cause to batch 160 in lane-M; this lane records it
and makes no shutdown change. The old full verify had no result file and its supervisor/process
were gone at continuation, so it is not counted as passing. A fresh verify has a 40-minute tree limit
and uses batch 160's downloaded sample directory. The initial scoped README command accepted
32 existing failures; its zero exit code is not evidence those examples passed.

## Licensed OFF and real VDB follow-up

The OFF comparison now uses the LGPL box and MC-letter samples. Every vertex and triangle is compared;
MC's trailing per-face RGBA is outside this reader's vertex-colour support. The old cube is removed.
The legacy knight is still read by held physics tests and the unchanged benchmark workload, so replacing or
removing that shared file would alter work Scott put on hold. It is not fetched or used by the loader comparison.

P31 uncovered a real VDB reader defect: a zero-length half-precision value array has no eight-byte size field.
Reading one stole the next node's bytes, producing unknown value kind -1 on the outside sphere and smoke files.
The owning reader now returns an empty view without consuming input. The test writer had mirrored the same
incorrect prefix and is corrected too. Both ZIP and Blosc empty-node regressions and the independently authored
sphere pass; the sphere has 1,451 leaves, 270,638 active voxels and bounds matching its embedded metadata.
This proves that file, not every OpenVDB version or codec. A malformed PLY probe did not close P20.

Additional downloaded README inputs remain in engine-bench/readme-samples: ten previously recorded standard
assets (3DS, LWO, MD2, AMF, PDB, KMZ, OBJ, TMX, Lottie and PTS), OBJ/MTL companions and seven textures,
the CC-BY-4.0 OpenVDB density smoke, and the GPLv3 FFmpeg 8.1.2 binary/archive with the publisher's SHA-256.
Their original manifest licences and SHA-256 records are retained in this lane's ignored logs. Download alone is
not a README pass. Wiring the exact files into the README runner and rerunning them remains outstanding.


The first full verify of this follow-up caught an overbroad empty-block change in the existing Blender
volume regression. Native OpenVDB 13 then wrote/read the same grid twice, once at each precision: full
storage retains its empty compressed block; half storage omits it. The final fix follows that distinction,
without a version/input special case. Paired native version-225 fixtures/oracles and the existing Blender
volume test preserve the full-precision path; ZIP/Blosc synthetic cases cover empty internal and leaf nodes
at both precisions. No assertion or numeric tolerance changed. The outside half sphere remains the independent
real-file regression, rather than being replaced by the generated control grids.


Final follow-up validation: lint and hygiene passed; full verify passed 13,233 tests with zero failures/skips
(294.4 s). The focused loader/VDB/Blender run passed 70 tests. Both loader browser suites passed (6.3/20.5 s),
and the required loader README command ran 11/27 examples with 16 pre-existing known exceptions, zero fresh
failures. Those missing inputs/other causes remain outstanding, not all-examples-passed proof. Pinned fixture
fetch succeeded. Public exports and size numbers did not change. The raw upstream MC-letter OFF ends in an
extra blank line; it is preserved with the verified source bytes rather than silently rewriting the standard asset.

Once a GPU slot became available, the exporter capture rerun passed all checks in 4 seconds, including teardown,
on lane-M's root fix cff40d127. This lane made no browser shutdown change. The earlier acquisition timeout ran no test.

## README asset wiring follow-up (2026-11-09)

The scoped loader, decoder, FBX, environment and point-cloud run executed 73/88 examples successfully, with 15 existing failures and zero fresh failures. Thirty entries proved passing were removed from the known list (70 remain repository-wide). Every scoped result is written to its run folder report.json. This is not an all-examples pass.

Run node scripts/fetch-readme-assets.mjs before npm run check:readme-run. The external cache defaults to engine-bench/readme-samples beside the worktrees, or MARGO_README_SAMPLES. SHA-256-checked public assets and companions come from the existing real-file corpus plus CC-BY-4.0 OpenVDB smoke. Tracked explicit aliases require actual bytes, never LFS pointers. Cube, array, HDR, streaming, LAZ and waveform inputs are selected for their documented shape. Alias names illustrate APIs; the NASA carrier is not a teapot, Source Sans is not Inter, and the mechanical fan is not a walking character. No rig or clip was renamed.

The runner serves real byte ranges (206/416, suffix/open ranges and HEAD), preserving the existing multi-file asset paths plus explicitly mapped OBJ/MTL/PNG, TMX/TSX and LAZ/WDP companions. Required inputs fail with recovery commands before execution; no missing alias falls through to unrelated bytes. Regression evidence: tests/readme-assets.test.js and tests/run-readme-examples.test.js.

The real inputs exposed remaining nonmissing causes: FBX introduction requests Walking on the mechanical fan; inherit/deformer examples select unsupported cubic curves without the layer extension; the outside NURBS file has no renderable mesh; the second OBJ example passes MTL bytes to parseOBJ. These remain deferred to the later README job, with their failures preserved. Two examples still request example.com, and E57/Potree/Draco/meshopt/Brotli/PCX inputs remain outstanding. Physics was not run or changed.

## Further licensed format proofs (2026-11-09)

P21-P24 passed through the real-file runner, with source/licence/hash and all MPD dependencies in its manifest. The control AMF rook also passes. The zipped AMF exposed a proof bug, not a reader bug: the old bound oracle ignored constellation placement. The independent oracle now rotates/translates source points, follows nested/root constellations and compares all vertices and indices with the same 1e-6 coordinate bar. The owning test covers the Slic3r translation and nested rotation.

The six-package README command ran 80/95 examples, 15 retained failures, zero fresh failures. Brotli, PCX and the FFmpeg video example were removed from the known list only after passing; 67 entries remain. Use node scripts/fetch-readme-assets.mjs --ffmpeg after a build, then set MARGO_README_FFMPEG to the emitted ffmpeg/bin/ffmpeg.exe when running the examples. The binary directory enters only the relevant Node child PATH, never the runner environment. The GPL archive remains outside Margo.

Continued source investigations are not passes: P13 has a pinned Apache-2.0 Cesium implicit S2 tileset candidate (its subtrees remain to fetch/prove); P25 has a published OpenUSD reset stage containing only Cone/Sphere, correctly refused because it has no renderable meshes, so it does not close the mesh-bearing proof. P20 additional assimp and PDAL candidates were little-endian. P29 Blender's movie endpoint returned HTTP 403; no movie proof was run. The Draco introduction needs attribute IDs matching its explicit POSITION=0/NORMAL=1/TEXCOORD_0=2 request; Box, Avocado and the Google cube do not have that map, so no incompatible alias is claimed passing. Remaining investigations stay open.

Follow-up landing checks: lint and hygiene passed; full verify passed 13,276 tests with zero failures/skips
(329.2 s). Loader tests passed 516/516, both loader GPU suites passed, and the final six-package README rerun
executed 80/95 with 15 retained failures, zero fresh. The 34 focused regressions and all three real AMF rows
also passed. No public exports changed. The first group's duplicate queued GPU request was deliberately
cancelled before it started tests; its earlier identical-code scoped run remains the recorded evidence.

## Cross-worktree skip investigation (2026-11-09)

The reviewers' 14 skips are the batch-160 rows, not additional missing-file cases. The
previous zero-skip verify explicitly exported MARGO_SPLAT_SAMPLES; other shells did not.
Their tests still used optional environment-only selection and were excluded from the AST
gate for ownership. Shared downloaded files alone could not prevent skips. The cache was
shadow-only, with no serving. On Scott's follow-up instruction, those four test files now
use the shared default cache and required digest-checked families, and their gate exclusions
are removed. Verify preflights all 348 pinned outside inputs before build; direct package
tests require their own families. No physics or physics2d implementation or test changed.
See batch-160-skips.md for sources/licences and the exact failure/recovery contract.

The original four files at 110b47288 were reproduced without the environment variable: 49 pass,
14 skip, zero failures. New direct package suites pass 201 animation, 394 gltf-pro and 73 splats
tests without the export. All nine package GPU suites pass. Their README run executes 45/52
examples, seven existing exceptions, zero fresh failures. A genuinely empty cache downloaded
and digest-checked all 348 files successfully in 16.1 s. The initial full verify ran 13,285 tests
with zero skips and one stale generated THIRD-PARTY-NOTICES.md failure; the source registry
change required regeneration, now performed. Final post-rebase checks are recorded below.

Final skip-enforcement checks on 2ef2fc7c0: lint and standalone hygiene pass. Full verify passes
13,282 tests, zero failures/skips, in 307.6 s with MARGO_RESULT_CACHE=off and no sample export.
All nine affected package GPU suites pass after the WebGL workspace removal rebase, and the
README run remains 45/52 with seven existing exceptions and zero fresh failures. The three
package-specific test suites passed all 668 tests. No core/stage/physics package changed.

## Further README inputs and source investigations (2026-11-09)

The original material KTX2 examples now select separate existing KTX-Software-authored 2D
and cube files; no dimensionality fallback is involved. The E57 example reads Innerscene's
complete CC0 authored two-station room sample: 2,069,504 bytes, two scans of 54,000 points.
Its publisher page, immutable storage URL, SHA-256 and size are recorded in the fetch registry
and THIRD-PARTY-NOTICES.md; a fresh pinned download and complete parse both passed. This
is an outside authored format sample, not surveyed-ground-truth or sensor-calibration proof.
The scoped materials/points run passes 45/47 original examples, with two retained existing
failures and zero fresh. Only those three passing exceptions were removed; 64 remain overall.
Durable evidence: docs/whitepaper/results/readme-missing-inputs-20261109.json.

P25 remains open: 97 small public transform/instancing USDA scenes from OpenUSD commit
2d39590aac6dde875507d2a334ff6e5b9dc05fe1 were downloaded and inspected as standard data
only. The only reset-stack scene found is the already identified Cone/Sphere scene, without
a Mesh; it cannot prove the mesh reader's reset behaviour. No implementation source was read.
P29 remains open: the official Sintel trailer and the retired GTV Big Buck Bunny endpoint
both answer HTTP 403. No movie was saved, no B-frame decoder pass is claimed. The CC0
Cloud Forest Zenodo download also returned 403; it was not substituted for the authored room.

The first README-group full verify ran 13,299 tests with zero skips; its only failure was
the generated site/llms-full.txt after the limits/claims evidence edit. Regenerating it with
node scripts/build-llms.mjs repairs the documented generated-file contract. Lint, standalone
hygiene, 45 focused regressions and the pinned E57 fetch passed; final verify follows rebase.

Final README-group verification after the mask-wipe rebase passes 13,304 tests with zero
failures/skips in 335.7 s. The 45 focused regressions, lint, hygiene and pinned full E57
fetch pass. Original scoped README result remains 45/47, two retained other-cause failures.
