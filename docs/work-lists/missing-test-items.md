# Required test items audit

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
| E07 | same, OFF files | cube.off, decimated-knight.off; restore exact tracked files with `git restore -- packages/loaders/tests/fixtures/cube.off packages/loaders/tests/fixtures/decimated-knight.off` | libigl data README attributes cube to libigl, knight to Cosmic Blobs; no explicit licence located | Existing files tested; outside downloads retained only in ignored logs; licensing remains unresolved |
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
| cube.off, decimated-knight.off | [libigl tutorial data 644dd4104843b6d736745d9dafbd70bf8d175648](https://github.com/libigl/libigl-tutorial-data/tree/644dd4104843b6d736745d9dafbd70bf8d175648) | Attribution only found; no new copy is added to the repository; do not label these freely licensed |

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
| P20 | limits real files | real big-endian PLY | Public point cloud corpus with explicit licence | Pending |
| P21 | same | LDraw MPD | LDraw models; verify model-specific CC licence | Pending |
| P22 | same | zipped AMF | Public 3MF/AMF consortium or slicer sample data; per-file licence | Pending |
| P23 | same | PTS with intensity and colour | Public survey dataset, CC0/CC-BY/public domain | Pending |
| P24 | same | chemistry XYZ with clear licence | Public molecular dataset, CC0/public domain | Pending |
| P25 | limits USD reset stacks, LIM-324 | independently authored resetting USD stage | OpenUSD standard test data, Apache-2.0 to verify | Pending |
| P26 | limits MaterialX, LIM-331/205 | RealityKit material file and MaterialX rendered reference | Apple public sample-file grant; MaterialX standard examples Apache-2.0 to verify | Pending |
| P27 | limits LAS/LAZ | compressor 0/1 v2 items, chunk size 0 from an outside writer | LASzip/laz-rs standard data, Apache-2.0 to verify | Pending; unsupported item-v1 is not a missing proof |
| P28 | limits video/material and /360 | real movie and stereo panorama | Blender Foundation movies CC-BY; panorama-specific licence | Pending; headset proof needs device |
| P29 | limits video/codecs, LIM-575 | real AVC movie with B-frames | Same, retain source codec metadata and licence | Pending |
| P30 | private batch-110 report and known-bugs README 404 history | pointer-show.glb and the other missing example asset | Margo-authored pointer-show now exists; current README runner selects both examples | Scoped README command rerun: 62/94 ran, 32 allowed failures; further sample work remains; do not duplicate batch 160 fix |
| P31 | loaders README VDB entry labelled example: in known list | real OpenVDB volume accepted by the example | OpenVDB public volume data, per-file licence to verify | Pending; not included in the 85 sample-labelled rows below |
| P32 | headless README image-sequences-and-video-37bcc7 | discoverable ffmpeg binary | FFmpeg official download links, LGPL/GPL build configuration to record | Pending tool/path audit; not a hardware gap |
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

The previous scoped command ran 62/94 examples, with 32 accepted failures. The known list has
102 exceptions. These 57 entries name missing files/tools or received incompatible fallback bytes
(including Vite HTML). Each needs a format-correct, licensed input and a real rerun. Existing package
fixture notices are the first source; no arbitrary tiny fixture or renamed rig proves a README example.

| Stable example ID | Requested files | Original failure | Status |
| --- | --- | --- | --- |
| animation/readme-geometry-caches-margoengine-anim-dcf6c5 | /flag.mgc | sample: MargoError: Geometry cache request failed with status 404; check the URL | Pending file selection, provenance and rerun |
| decoders/readme-any-image-to-pixels-margoengine-86f34e | See named example | sample: TypeError: Failed to fetch | Pending file selection, provenance and rerun |
| decoders/readme-basis-on-the-gpu-margoengine-dec-8314b0 | /texture.ktx2 | sample: TypeError: KTX2: invalid file (not KTX 2.0); pass an unmodified .ktx2 file | Pending file selection, provenance and rerun |
| decoders/readme-brotli-margoengine-decoders-brot-f9820a | /node.br | sample: MargoError: Brotli stream is corrupt: a reserved bit is set | Pending file selection, provenance and rerun |
| decoders/readme-draco-point-clouds-margoengine-d-5f1327 | /points.drc | sample: Error: Draco: invalid header; pass an unmodified .drc buffer | Pending file selection, provenance and rerun |
| decoders/readme-hdr-ktx2-margoengine-decoders-kt-cbfebd | /environment.ktx2 | sample: Error: KTX2: invalid file (not KTX 2.0); pass an unmodified .ktx2 file | Pending file selection, provenance and rerun |
| decoders/readme-jpeg-xl-margoengine-decoders-jxl-2c0973 | /texture.jxl | sample: MargoError: JPEG XL: neither a codestream nor a container signature is there; pass the complete bytes of a .jxl file | Pending file selection, provenance and rerun |
| decoders/readme-ktx2-cube-maps-and-arrays-margoe-d255e4 | /sky.ktx2, /terrain.ktx2 | sample: TypeError: KTX2: invalid file (not KTX 2.0); pass an unmodified .ktx2 file | Pending file selection, provenance and rerun |
| decoders/readme-margoengine-decoders-b7ae99 | /mesh.drc, /albedo.ktx2 | sample: Error: Draco: invalid header; pass an unmodified .drc buffer | Pending file selection, provenance and rerun |
| decoders/readme-meshopt-on-wasm-simd-margoengine-2685e0 | /meshopt.bin | sample: MargoError: EXT_meshopt_compression: bad vertex stream header | Pending file selection, provenance and rerun |
| decoders/readme-pcx-margoengine-decoders-pcx-150025 | /skin.pcx | sample: MargoError: PCX does not start with the manufacturer byte 10; pass the complete bytes of a valid PCX file | Pending file selection, provenance and rerun |
| decoders/readme-pvr-margoengine-decoders-pvr-44fd95 | /texture.pvr | sample: MargoError: PVR: this is not a PVR file; check the path | Pending file selection, provenance and rerun |
| decoders/readme-streaming-ktx2-mips-margoengine-d0b4d7 | /rock.ktx2 | sample: MargoError: KTX2: could not load /rock.ktx2 (404) | Pending file selection, provenance and rerun |
| decoders/readme-tga-tiff-dds-and-ktx-1-margoengi-d480af | /image.tga, /image.tiff, /texture.dds | sample: MargoError: TIFF header is missing; pass the complete bytes of a valid TIFF file | Pending file selection, provenance and rerun |
| environment/readme-ultrahdr-9c0c80 | /studio.exr | sample: MargoError: Invalid EXR: bad magic number; the file is damaged or not OpenEXR, export it again | Pending file selection, provenance and rerun |
| fbx/readme-animation-layers-and-cubic-curve-656b9b | /assets/take.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-cameras-and-lights-d4d4b9 | /assets/shot.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-margoengine-fbx-4c9214 | /assets/character.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-nurbs-curves-and-lines-4d004a | /assets/route.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-pbr-materials-and-layered-textur-fbbc99 | /assets/crate.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-scale-inheritance-b099af | /assets/maya-rig.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-skinning-modes-and-in-between-sh-84ddc1 | /assets/hero.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| fbx/readme-uv-sets-and-colour-layers-c13313 | /assets/room.fbx | sample: MargoError: FBX request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| headless/readme-image-sequences-and-video-37bcc7 | See named example | example: Error [MargoError]: ffmpeg was not found; see https://margoengine.com/errors#headless | Pending file selection, provenance and rerun |
| loaders/readme-3ds-lwo-amf-md2-pdb-and-kmz-389243 | /models/tank.md2 | sample: LoaderError: MD2: missing the IDP2 magic | Pending file selection, provenance and rerun |
| loaders/readme-3mf-textures-and-colour-groups-3b539a | /prints/lithophane.3mf | sample: LoaderError: 3MF: not a ZIP package (missing PK signature) | Pending file selection, provenance and rerun |
| loaders/readme-collada-cameras-lights-lookat-an-174ec9 | /text.txt | sample: LoaderError: DAE: closing tag </head> does not match <meta> | Pending file selection, provenance and rerun |
| loaders/readme-collada-skins-morphs-and-animati-62e902 | /text.txt | sample: LoaderError: DAE: closing tag </head> does not match <meta> | Pending file selection, provenance and rerun |
| loaders/readme-fonts-and-3d-text-0a2991 | /fonts/Inter.ttf | sample: LoaderError: TTF: not a TrueType font (signature '<!DO'); pass the bytes of a .ttf file | Pending file selection, provenance and rerun |
| loaders/readme-las-and-laz-280f6c | /surveys/quarry.laz | sample: LoaderError: LAS: LAS file shorter than its 227-byte header; the file is truncated | Pending file selection, provenance and rerun |
| loaders/readme-lottie-55f6d2 | /motion/logo.json | sample: LoaderError: Lottie: bad JSON (Unexpected token '<', "<!DOCTYPE "... is not valid JSON) | Pending file selection, provenance and rerun |
| loaders/readme-margoengine-loaders-6065f6 | /parts/bracket.3mf, /scans/part.ply | sample: LoaderError: load: request for /parts/bracket.3mf returned HTTP 404 | Pending file selection, provenance and rerun |
| loaders/readme-stl-c220c0 | /parts/bracket.stl | sample: LoaderError: STL: the header declares 171861356 triangles (8593067884 bytes) but the data has 156; pass the whole file | Pending file selection, provenance and rerun |
| loaders/readme-svg-6d7995 | /logo.svg | sample: LoaderError: SVG: closing tag </head> does not match <meta> | Pending file selection, provenance and rerun |
| loaders/readme-textured-obj-meshes-b6f1ea | /crate.mtl, /models/crate.obj | sample: LoaderError: OBJ: the OBJ has no faces to draw as a mesh; draw its points with pointsToGeometry instead | Pending file selection, provenance and rerun |
| loaders/readme-textured-obj-meshes-c37231 | See named example | sample: LoaderError: load: request for https://example.com/models/chair.obj failed (Failed to fetch) | Pending file selection, provenance and rerun |
| loaders/readme-xml-128d10 | /map.tmx | sample: LoaderError: TMX: closing tag </head> does not match <meta> | Pending file selection, provenance and rerun |
| materials/readme-ktx2-textures-11832d | /textures/albedo.ktx2 | sample: MargoError: Texture download request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| materials/readme-ktx2-textures-8d6d24 | /textures/sky-cube.ktx2 | sample: MargoError: Texture download request failed: HTTP 404; check the URL and that the server serves it | Pending file selection, provenance and rerun |
| points/readme-copc-files-margoengine-points-co-e8bfa1 | /scan.copc.laz | sample: MargoError: GET /scan.copc.laz answered 404; check the URL and that the server allows it | Pending file selection, provenance and rerun |
| points/readme-e57-scans-margoengine-points-e57-27ad6c | /scans/plant-room.e57 | sample: MargoError: GET /scans/plant-room.e57 answered 404; check the URL and the server | Pending file selection, provenance and rerun |
| points/readme-las-and-laz-scans-margoengine-po-2d683c | /scans/site.las | sample: MargoError: GET /scans/site.las answered 404; check the URL and the server | Pending file selection, provenance and rerun |
| points/readme-las-and-laz-scans-margoengine-po-6ccdb7 | /scans/fullwave.laz, /scans/fullwave.wdp | sample: MargoError: GET /scans/fullwave.laz answered 404; check the URL and the server | Pending file selection, provenance and rerun |
| points/readme-laz-decoder-margoengine-points-l-7c341a | /scans/site.laz | sample: MargoError: GET /scans/site.laz answered 404; check the URL and the server | Pending file selection, provenance and rerun |
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
| loaders/readme-3ds-lwo-amf-md2-pdb-and-kmz-406f48 | /models/teapot.3ds, /models/ship.lwo, /prints/bracket.amf, /models/knight.md2, /molecules/1crn.pdb, /maps/tower.kmz | sample: LoaderError: 3DS: missing the 0x4D4D main chunk | Deferred to later README job |
| loaders/readme-optional-vertex-color-and-opacit-5d5952 | See named example | example: ReferenceError: document is not defined | Deferred to later README job |
| loaders/readme-vdb-volumes-573d3c | See named example | example: LoaderError: VDB: not an OpenVDB file | Deferred to later README job |
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
| voxel-pathtracer/readme-margoengine-voxel-pathtracer-af6ce0 | See named example | sample: TypeError: VoxelPathTracer scene.models[0].voxels has 151 entries; a 32x24x32 model needs 24576 (index = x + sx * (z + sz * y)) | Deferred to later README job |
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
