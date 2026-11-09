// Supply-chain record for every published package: runtime npm dependencies (direct and
// transitive, from package-lock.json), third-party code shipped inside our tarballs, the licence obligations that
// come with it, and the asset credits of the site and examples. Writes THIRD-PARTY-NOTICES.md; re-run before every
// release (docs/releasing.md):
//   node scripts/supply-chain.mjs          rewrite THIRD-PARTY-NOTICES.md
//   node scripts/supply-chain.mjs --check  exit 1 when the file is stale or a rule below is broken
// Rules: every published manifest has license/files/exports/sideEffects and is not private; every
// external runtime dependency or peer has a reason in WHY, a licence on ALLOWED (or a named exception), no install
// script, no deprecation, a registry.npmjs.org URL with an integrity hash, and is imported by the package's code
// (a build-time tool listed as a runtime dependency fails). npm audit needs the registry, so it is a release step,
// not part of this offline check.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));
export const OUTPUT = 'THIRD-PARTY-NOTICES.md';

/** Licences any runtime dependency may carry without review. */
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Zlib', '0BSD']);
/** Reviewed exceptions: package -> licence it may carry (see the obligations section of the output). */
const EXCEPTIONS = {};

/** Why each external runtime dependency or peer exists. A new one fails --check until it is added here. */
const WHY = {
  '@dimforge/rapier3d-compat': 'Rapier rigid-body solver; optional, the app installs and initializes it',
  '@dimforge/rapier2d-compat': 'Rapier 2D rigid-body solver; optional, the app installs and initializes it',
  react: 'React component bindings for the stage',
  'react-dom': 'React DOM root and portal rendering for scene and HTML components',
  scheduler: 'React DOM scheduling dependency',
};

/**
 * Third-party code inside our own tarballs (not npm dependencies). `notices` are tarball paths that must ship
 * (tests/supply-chain.test.js checks the packed file lists); `source` is where the copy comes from in this repo.
 */
export const BUNDLED = [
  {
    package: '@margoengine/decoders',
    component: 'Draco 3D decoder (Google)',
    licence: 'Apache-2.0',
    files: 'dist/draco/draco_decoder.wasm, dist/draco/draco_wasm_wrapper.js',
    source:
      'packages/decoders/vendor/draco: Draco 1.5.6 official glTF decoder, https://www.gstatic.com/draco/versioned/decoders/1.5.6/ (draco_decoder_gltf.wasm sha256 a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac, draco_wasm_wrapper_gltf.js sha256 8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6), byte-identical',
    modified: 'no',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/decoders',
    component: 'Draco 3D full decoder (Google)',
    licence: 'Apache-2.0',
    files: 'dist/draco-full/draco_decoder.wasm, dist/draco-full/draco_wasm_wrapper.js',
    source:
      'packages/decoders/vendor/draco-full: Draco 1.5.6 official full decoder, https://www.gstatic.com/draco/versioned/decoders/1.5.6/ (draco_decoder.wasm sha256 c55a594e8ffd18426d36b27fea9618af3df5e173640a3e56d46f09d76f0574f2, draco_wasm_wrapper.js sha256 e8049906ef3f8f75d3456c22a3f31bfdfe5b5b5bd09ccdec613b9e9a49d554d8), byte-identical',
    modified: 'no',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/exporters',
    component: 'Draco 3D encoder (Google)',
    licence: 'Apache-2.0',
    files: 'dist/draco-encoder/draco_encoder.wasm, dist/draco-encoder/draco_encoder_wrapper.js',
    source:
      'packages/exporters/vendor/draco-encoder: Draco 1.5.7 official encoder, https://github.com/google/draco/tree/1.5.7/javascript, also in npm draco3d 1.5.7 as draco_encoder_nodejs.js (draco_encoder.wasm sha256 d2a3ac80c91980d5d321c116454834ff36264825c6d1794cc84e42288f158958, draco_encoder_wrapper.js sha256 8434adecd1446459601763e499be3697546056bca90b286a538ae0483a00845a), byte-identical',
    modified: 'no',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/exporters',
    component: 'Basis Universal encoder (Binomial)',
    licence: 'Apache-2.0',
    files: 'dist/basis-encoder/basis_encoder.wasm, dist/basis-encoder/basis_encoder.js',
    source:
      'packages/exporters/vendor/basis-encoder: Basis Universal v1_50_0_2 official encoder, https://github.com/BinomialLLC/basis_universal/tree/v1_50_0_2/webgl/encoder/build',
    modified:
      'the .js glue only: scripts/static-embind.js swaps two `new Function` generators for closures; the file states it in its first line',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/decoders',
    component: 'jxl-oxide JPEG XL decoder (Wonwoo Choi)',
    licence: 'MIT OR Apache-2.0',
    files: 'dist/jxl/jxl_oxide_wasm_bg.wasm, dist/jxl/jxl_oxide_wasm.js',
    source:
      'packages/decoders/vendor/jxl: jxl-oxide-wasm 0.12.6 from npm, https://www.npmjs.com/package/jxl-oxide-wasm/v/0.12.6 (jxl_oxide_wasm_bg.wasm sha256 3336f3abd4a04fccc437e7a84f12d4b63c12f302044110867f99be14c4c75a69, jxl_oxide_wasm.js sha256 d9a314abc55d167e94e2d995ce6ab5276f86ef9de41f06df11fef3acf55ff6b7), byte-identical',
    modified: 'no',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt', 'dist/jxl/LICENSE-MIT'],
  },
  {
    package: '@margoengine/decoders',
    component: 'Basis Universal transcoder (Binomial LLC)',
    licence: 'Apache-2.0',
    files: 'dist/basis/basis_transcoder.wasm, dist/basis/basis_transcoder.js',
    source:
      'packages/decoders/vendor/basis: Basis Universal v1_50_0_2 official WebGL transcoder, https://github.com/BinomialLLC/basis_universal/tree/v1_50_0_2/webgl/transcoder/build (basis_transcoder.wasm sha256 6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a, basis_transcoder.js sha256 8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1), byte-identical before the build step',
    modified:
      'the .js glue only: scripts/static-embind.js swaps two `new Function` generators for closures; the file states it in its first line',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/post, @margoengine/tonemap',
    component:
      'Colour-transform references: AgX (Troy Sobotka, Eary Chow), ACES filmic curve (Krzysztof Narkowicz), Khronos PBR Neutral; the ACES 1.x style fit written for Margo',
    licence:
      'attribution (formulas and constants; agx.test.js re-derives every AgX matrix and constant, aces.test.js measures the own ACES fit against its sample table)',
    files:
      'AgX/ACES shader code: AgX and the Narkowicz curve also compiled into post (ImagePost) and voxel-pathtracer from packages/shared; the own ACES fit only into tonemap',
    source: 'packages/shared/agx.js, packages/shared/aces.js, packages/tonemap/src/shaders.ts',
    modified: 're-derived; ACES fit written for Margo',
    notices: ['NOTICE.md'],
  },
  {
    package: '@margoengine/sciviz',
    component:
      'Standard colour-map tables: viridis, magma, inferno, plasma (Smith and van der Walt); cividis (Nuñez, Anderton and Renslow 2018)',
    licence: 'CC0-1.0 (viridis family); CC-BY-4.0 (cividis)',
    files: 'dist/tables.js (data only, 256 colours per map)',
    source:
      'https://github.com/BIDS/colormap/blob/master/colormaps.py (CC0); PLOS ONE 13(7): e0199239 supporting file S2, https://doi.org/10.1371/journal.pone.0199239.s002 (CC BY 4.0)',
    modified: 'values rounded to 8 bits per channel and written as hex',
    notices: ['NOTICE.md'],
  },
];

/** Credits for the assets the site, demos and examples use. None of these files is in an npm tarball. */
const ASSETS = [
  [
    'scripts/fetch-readme-assets.mjs',
    'README runner external standard samples, downloaded outside the repository with SHA-256 checks: fifteen families reuse the source/author/licence records in packages/loaders/tests/real-files/manifest.json (NASA public domain; dolphin MD2 sample-file grant; AMF MIT; PDB CC0; KMZ CC-BY-4.0; Lottie Apache-2.0; STL BSD-3-Clause; SVG and TMX public domain; 3MF BSD-2-Clause; COLLADA Khronos MIT-style; OBJ/MTL and seven PNG companions Apache-2.0; LAS/WDP BSD-2-Clause; Pillow PCX MIT-CMU). OBJ PNG sources/hashes in scripts/support/readme-companions.json, PyVista vtk-data commit 5a3de12d34c24aa5dd5e5db1cbc2defebc0d4da3. OpenVDB smoke.vdb, OpenVDB website 3d8fd4d3f2d670464f4390e2775cfc87274233dc, CC-BY-4.0, repository LICENSE.txt. Brotli Alice stream from google/brotli d89c4b1c52e25ddafe047bc78bbee5c1e24b1809, MIT test-data grant and public-domain Lewis Carroll text. Optional Windows FFmpeg 8.1.2 GPL-3.0 tool from Gyan; publisher-hash-checked archive stays in the external cache. Innerscene authored room-scan-two-stations.e57, 108,000 points in two scans, CC0-1.0 dedication at https://www.innerscene.com/tools/library/3d-parts/room-scan-two-stations-cfa3398f, SHA-256 5c2d803ad56c83b689d9d9b9801e2f64d5a7ee6c58bad7d5a902337d2d3211fa; this standard E57 sample remains outside Margo. No implementation files or FFmpeg binaries ship in Margo.',
  ],
  [
    'packages/audio/tests/fixtures/NOTICE.md',
    'Ambisonic test audio: first-second, first-four-channel excerpt of RainSceneO7.wav by Stefan Riedel, Ambisonic Stimuli Files and Binaural Renders, Zenodo 10.5281/zenodo.10227483 (CC BY 4.0). Original samples unchanged; WAV header rewritten and higher orders/metadata omitted. rain-foa.json pins source and excerpt hashes. Test-only, never shipped in package tarballs',
  ],
  [
    'packages/text/tests/fixtures/fonts/NOTICE.md',
    'test fonts: Source Sans 3 Regular 3.052R TTF and name-keyed CFF1 OTF, unmodified binary assets from https://github.com/adobe-fonts/source-sans/tree/3.052R (TTF/SourceSans3-Regular.ttf and OTF/SourceSans3-Regular.otf), downloaded 2026-11-08; Copyright 2010-2022 Adobe, Reserved Font Name Source, SIL Open Font License 1.1 (full text in packages/text/tests/fixtures/fonts/OFL.txt, from that release LICENSE.md). The linked notice and outline-reference.json record provenance and SHA-256. Our independent native-outline reference data and its generator are test-only, never shipped',
  ],
  [
    'site/fonts/OFL.txt',
    'site text typeface: Source Sans 3 (Copyright 2010-2024 Adobe, with Reserved Font Name "Source"; SIL Open Font License 1.1, full text in the linked file), self-hosted as site/fonts/SourceSans3-latin.woff2, the Latin subset of the variable font exactly as served by Google Fonts (https://fonts.gstatic.com/s/sourcesans3/v20/nwpStKy2OAdR1K-IwhWudF-R3w8aZQ.woff2, 28,872 bytes, SHA-256 19143dca075972bc84e3fd9eab7416dd40cc565dccb2435a044bdfabe060c7d5, fetched 2026-10-28, not modified); licence text from https://github.com/adobe-fonts/source-sans (LICENSE.md, SHA-256 56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328)',
  ],
  [
    'examples/assets/ATTRIBUTION.md',
    'demo models: RobotExpressive (CC0), FlightHelmet (CC0), Tokyo diorama (Apache-2.0); test mesh: MakeHuman base mesh (CC0)',
  ],
  [
    'examples/assets/vrm/README.md',
    'sample avatars for the VRM tests: Seed-san and VRM1_Constraint_Twist_Sample (VRM Consortium samples, VRM Public License 1.0; Seed-san model by VirtualCast, Inc.; (c) 2022 pixiv Inc.)',
  ],
  [
    'packages/cutscene/tests/fixtures/arctic/NOTICE.md',
    'test speech for @margoengine/cutscene/lipsync: two sentences of the CMU ARCTIC voice cmu_us_slt_arctic with their phoneme labels (Carnegie Mellon University, 2003; free for any purpose under the notice in the fixture COPYING file; never shipped)',
  ],
  [
    'tests/fixtures/cmu-mocap/NOTICE.md',
    'test motion capture for @margoengine/animator: nine takes of subjects 2 and 16 from the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu, funded by NSF EIA-0196217; free for research and commercial use) in the BVH conversion by Bruce Hahne',
  ],
  ['examples/assets/robot-CREDITS.md', 'RobotExpressive upstream credits (Tomás Laulhé, Don McCurdy; CC0)'],
  [
    'packages/sciviz/tests/fixtures/NOTICE.md',
    'test fixtures: pydicom test data CT_small and MR_small in four transfer syntaxes (MIT-licensed project; no restriction on the files stated) and the NIfTI-1 sample zstat1.nii.gz (NIMH, public domain); real Zarr stores: the zarr_implementations v2 astronaut (MIT, Copyright 2021 Zarr Developers; image NASA, public domain), zarrs array_gzip.zarr (MIT OR Apache-2.0) and two GDAL autotest v3 arrays (GDAL MIT-style licence); commits and sha256 there',
  ],
  [
    'packages/physics/tests/fixtures/thingi10k/NOTICE.md',
    'test points for @margoengine/physics convex hulls: the distinct vertices of Thingi10K meshes 40261 and 41940 (Zhou and Jacobson 2016; Public Domain on Thingiverse; never shipped)',
  ],
  [
    'packages/headless/tests/fixtures/pngsuite/NOTICE.md',
    'test fixtures: PngSuite 2017jul19 by Willem van Schaik (free to use, copy, modify and distribute)',
  ],
  [
    'examples/assets/tokyo-diorama-CREDITS.md',
    'Tokyo diorama: Poly Haven textures (CC0), Noto Sans CJK (OFL 1.1); inspiration credit to Glen Fox, Littlest Tokyo (CC BY 4.0, nothing copied)',
  ],
  ['examples/assets/khronos/README.md', '32 Khronos glTF sample models, each CC0 1.0 or CC BY 4.0 with its credit'],
  [
    'examples/assets/khronos-samples/README.md',
    'Collada, KHR_animation_pointer and transparency test models: AnimatedColorsCube, GlassVaseFlowers, TransmissionTest (CC0 1.0, Khronos glTF-Sample-Assets), DiffuseTransmissionPlant (CC BY 4.0 and CC0 1.0, same source), Cesium Man `.dae` and texture (CC BY 4.0, Cesium); URLs, pinned commits and sha256 there',
  ],
  [
    'scripts/support/external-test-assets.json',
    'Required outside verify assets, 348 URL/SHA-256/size records: Khronos interactivity f99d9b6 (CC-BY-4.0), Niantic SPZ 11312e4ad836ed06e3da2f3d5b633688d17ebebb (MIT), Cesium tower (Apache-2.0, digest pinned), and glTF_Physics 9dc61cb3484ff9a51f58d3592f79d5c9e572056a (no stated licence; outside-only existing importer tests). No implementation or asset bytes ship here.',
  ],
  [
    'examples/assets/3d-tiles/NOTICE.md',
    '3D Tiles test tilesets: TilesetWithTreeBillboards (i3dm, CC0 1.0), the city of TilesetWithRequestVolume (b3dm, CC BY 3.0, Cesium) and two EXT_structural_metadata glTF samples (CC0 1.0) from https://github.com/CesiumGS/3d-tiles-samples; commit and sha256 there',
  ],
  [
    'examples/assets/terrain/NOTICE.md',
    'Quantized-mesh terrain tiles and layer manifests (Cesium World Terrain sample tile at Mount Everest, oct normals and water mask samples; Apache-2.0, Cesium GS, Inc.) from CesiumJS test data, https://github.com/CesiumGS/cesium; commit and sha256 there',
  ],
  [
    'examples/assets/3d-tiles/GaussianSplats/NOTICE.md',
    'Gaussian splat 3D Tiles tileset sh_unit_cube (KHR_gaussian_splatting with SPZ, Apache-2.0, Cesium GS, Inc.) from CesiumJS test data, https://github.com/CesiumGS/cesium; commit and sha256 there',
  ],
  [
    'packages/shadows/test/outside/reference.py',
    'Shadow reference pictures in packages/shadows/test/fixtures/outside: rendered by Blender Cycles from the Khronos models above (their licences apply), made by this script',
  ],
  [
    'packages/terrain/test/fixtures/aerial-rocks-02',
    'Terrain material test textures: Aerial Rocks 02 by Rob Tuytel (Poly Haven, CC0 1.0), the 1k JPEG colour, nor_gl, arm and disp maps byte for byte from https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/aerial_rocks_02/ (aerial_rocks_02_diff_1k.jpg 785,923 bytes, SHA-256 708373b2af7fd07ac8de1500556006aaf904c41a99985a849cacc78874f38eac; aerial_rocks_02_nor_gl_1k.jpg 1,177,932 bytes, SHA-256 6df5263ba6c30e9343ee324d87078b926024d710b0b349025083600369df8d25; aerial_rocks_02_arm_1k.jpg 211,113 bytes, SHA-256 de3ffa2b107d3b9144979a1f683028c74ec86823b2b8eefe16bf5bb9a655ad0c; aerial_rocks_02_disp_1k.jpg 111,007 bytes, SHA-256 f8df3ed278b28255935d90ef0927cae075445a3a761890df79d3c70b468210ef; downloaded 2026-11-07)',
  ],
  [
    'packages/terrain/test/fixtures/terrarium-10',
    'Mount Rainier area elevation, the nine Terrarium tiles 10/164..166/359..361 byte for byte from the Terrain Tiles on AWS open data set (Mapzen), https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/{x}/{y}.png, named x-y.png (10/165/360 is the same file as packages/shadows/test/fixtures/rainier-terrarium.png; 625,026 bytes in all; downloaded 2026-11-07); United States 3DEP and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey',
  ],
  [
    'packages/shadows/test/fixtures/rainier-terrarium.png',
    'Mount Rainier elevation, Terrarium tile 10/165/360 from the Terrain Tiles on AWS open data set (Mapzen); United States 3DEP and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey',
  ],
  ['examples/assets/kaykit/LICENSE-adventurers.txt', 'KayKit Adventurers (Kay Lousberg, CC0)'],
  ['examples/assets/kaykit/LICENSE-character-animations.txt', 'KayKit Character Animations (Kay Lousberg, CC0)'],
  ['examples/assets/kaykit/LICENSE-dungeon.txt', 'KayKit Dungeon (Kay Lousberg, CC0)'],
  [
    'examples/assets/quaternius/NOTICE.md',
    'animator warping example: UAL1_Standard_RM.glb of the Quaternius Universal Animation Library Standard 3.0 (CC0 1.0, Quaternius, https://quaternius.itch.io/universal-animation-library); zip and file sha256 there',
  ],
  [
    'packages/creative/examples/earth/assets/ATTRIBUTION.md',
    'Earth demo: NASA Blue Marble, Solar System Scope textures (CC BY 4.0)',
  ],
  [
    'examples/assets/scifi-helmet-CREDITS.md',
    'SciFiHelmet test and benchmark model (Michael Pavlovic, Norbert Nopper, CC0 1.0)',
  ],
  ['examples/assets/boulder-robot-LICENSE.md', 'Boulder demo climber: Margo-made model and rig, no third-party files'],
  [
    'examples/assets/skinning-ik-LICENSE.md',
    'Workshop scene from the retired Light Keeper demo, kept for the benchmark HDR and the orb test model: Margo-made model and rig, Poly Haven surface textures (CC0 1.0)',
  ],
  ['tools/create-margo/templates/game/public/pete-LICENSE.txt', 'game starter character (Kay Lousberg, KayKit, CC0)'],
  [
    'packages/environment/tests/fixtures/NOTICE.md',
    'test fixtures: OpenEXR test images (BSD-3-Clause), pinned at e38ffb0790f62f05a6f083a6fa4cac150b3b7452 with SHA-256 checks in packages/environment/scripts/fetch-fixtures.mjs; no implementation code fetched',
  ],
  [
    'packages/usdz/tests/fixtures/real/NOTICE.md',
    'test fixtures: USD composition scenes, two subdivision meshes and MaterialX documents of https://github.com/usd-wg/assets, commit 091bb5c6 (Apache-2.0, Alliance for OpenUSD working group; Open Chess Set and Standard Shader Ball documents CC BY 4.0), with what OpenUSD 26.08 reads from them; RiggedSimple, RiggedFigure and BoxAnimated of the same commit (CC-BY-4.0, Cesium); AnimatedTriangle and InterpolationTest of the same commit (CC0)',
  ],
  [
    'packages/fsm/test/outside/traces.json',
    'test fixture: what the Sismic 1.6.14 statechart interpreter (LGPL-3.0, https://github.com/AlexandreDecan/sismic) did with charts this repository generates; output of a tool run outside, no Sismic code is in this repository',
  ],
  [
    'packages/blender/tests/fixtures/README.md',
    'test fixtures: an animated .margo and its deformed vertices, exported for this project by Blender 5.2.3 LTS from tools/blender-addon/tests/blender_anim.py (Apache-2.0, as this repository)',
  ],
  [
    'packages/fbx/test/fixtures/README.md',
    'test fixtures: original FBX scenes exported for this project by Blender 5.3 from the scripts beside them (CC0 1.0)',
  ],
  [
    'packages/fbx/test/fixtures/real/NOTICE.md',
    'test fixtures: Maya and 3ds Max FBX files with OBJ frames from the ufbx test data (MIT or Unlicense, Samuli Raivio); commit and sha256 there',
    'packages/decoders/tests/fixtures/webp/NOTICE.md',
    'test fixtures: WebP files from two CC0 images on Wikimedia Commons, made with libwebp 1.4.0 tools, and 50 BC blocks from the DDS test images of Pillow (HPND)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/bump/NOTICE.md',
    'test fixture: BumpMaterial.gltf, the EXT_materials_bump interoperability file from luma.gl (CC0-1.0, vis.gl contributors)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/uv/NOTICE.md',
    'test fixture: FourUV.glb, exported for this project by Blender 5.3 from fixtures/uv/four-uv.blender.py (Apache-2.0, as this repository)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/metadata/NOTICE.md',
    'test fixtures: XmpMetadataRoundedCube.glb of Khronos glTF-Sample-Assets, commit 8f492390 (CC-BY-4.0, Adam Morris); Box.gltf, Box0.bin and the language edge cases of https://github.com/KhronosGroup/glTF-Metadata-CLI, commit e35dbb00 (CC-BY-4.0, The Khronos Group); boom_box.gltf (CC0-1.0, The Khronos Group) and rocket_ship.gltf (CC-BY-3.0, Poly by Google and aaronfranke) of https://github.com/omigroup/gltf-extensions, commit 4f1fe73b, exported by the Godot Engine',
  ],
  [
    'packages/gltf-pro/tests/fixtures/scatter/NOTICE.md',
    'test fixture: ScatteringSkull.gltf, the material of the Khronos glTF-Sample-Assets sample (CC0-1.0, Vladimir Petkovic and Adobe Inc.)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/streaming/NOTICE.md',
    'test fixture: a texture of the Khronos glTF-Sample-Assets FlightHelmet, glTF-KTX-BasisU (CC0-1.0, Gary Hsu and Microsoft)',
  ],
  [
    'packages/clustered/test/fixtures/NOTICE.md',
    'test fixture: TypeB-AsymmetricNarrow.ies, a GE Lighting Solutions Evolve LED Flood report, as Type B - 03.ies of https://github.com/lfaynshteyn/ies_rescale, commit bf2e6a6a (MIT, Lev Faynshteyn)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/interactivity/NOTICE.md',
    'test fixtures: conformance files of https://github.com/KhronosGroup/glTF-Test-Assets-Interactivity, commit f99d9b6 (CC-BY-4.0, The Khronos Group)',
  ],
  [
    'packages/physics2d/tests/fixtures/outline/NOTICE.md',
    'test fixture: one PNG of https://github.com/googlefonts/noto-emoji, commit 99701e0 (Apache-2.0, Google)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/physics/NOTICE.md',
    'test fixtures: the KHR_physics_rigid_bodies sample files of https://github.com/visgl/luma.gl/tree/master/examples/gltf/physics/assets (MIT, vis.gl contributors); seven more samples of https://github.com/eoineoineoin/glTF_Physics state no licence, so they are named there and never stored here',
  ],
  [
    'packages/gltf-pro/tests/fixtures/lights/NOTICE.md',
    'test fixtures: the EXT_lights_ies Example files and LightProfile.ies from https://github.com/BabylonJS/Assets/tree/master/meshes/EXT_lights_ies (CC-BY-4.0, The Babylon.js contributors)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/splats/NOTICE.md',
    'test fixtures: CesiumJS sh_unit_cube.glb (Apache-2.0, Cesium GS, Inc.) and the godot-gsplat minimal_point sample from luma.gl (MIT, KOGA Mitsuhiro)',
  ],
  [
    'packages/loaders/tests/real-files/manifest.json',
    "real-file test: 123 public sample files, downloaded by URL and never in the repository or a tarball; each one's source, author and licence is in this manifest (public domain, CC0, CC BY, BSD, MIT, Apache-2.0, OFL and sample-file notices). Added PDAL PTS (BSD-3-Clause), Open Babel chemistry XYZ (GPL-2.0), Slic3r zipped AMF (AGPL-3.0) and Takeshi Takahashi's LDraw MPD (CCAL/CC-BY-2.0), with four CC-BY-4.0 sticker dependencies and the existing CC-BY-2.0 library archive. Licence-source links and pinned hashes are retained per entry; no parser or implementation code is fetched.",
  ],
  [
    'packages/loaders/tests/fixtures/SOURCES.txt',
    'test fixtures: Point Cloud Library test/bunny.pcd (BSD-3-Clause, github.com/PointCloudLibrary/pcl at 3aac7b68cc8f26428ba9c9192d990c0c21cc5a7d; Stanford bunny scan); PyVista data fran_cut.vtk and polyEx.vtk (Apache-2.0, at 5a3de12d34c24aa5dd5e5db1cbc2defebc0d4da3); fetch-fixtures.js pins source hashes. OFF parser comparisons: John Burkardt Geomview box.off and MC-authored mctri.off, GNU LGPL (off.html explicitly covers data; upstream version unspecified), hashes pinned by fetch-fixtures.js; licence texts in fixtures/OFF-LGPL-3.0.txt and OFF-GPL-3.0.txt. Legacy decimated-knight.off remains only for held physics and the existing workload, libigl/Cosmic Blobs attribution but no verified licence, not re-fetched. OpenVDB website sphere.vdb at 3d8fd4d3f2d670464f4390e2775cfc87274233dc, CC-BY-4.0 (repository LICENSE.txt), source and pinned digest in SOURCES.txt',
  ],
  [
    'packages/points/tests/fixtures/NOTICE.md',
    'test fixtures: parts of Potree sample folders (BSD-2-Clause, github.com/potree/potree); Point Cloud Library test/bunny.pcd (BSD-3-Clause, github.com/PointCloudLibrary/pcl; Stanford bunny scan); USGS 3DEP lidar tile USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz (public domain, rockyweb.usgs.gov, 609,938 bytes, SHA-256 c2804c3827fd6104acf657803f55ed4e5fa9ba83b4ec481888510385a14e31ae, downloaded 2026-10-27); LAS and LAZ samples from laz-rs tests/data (Apache-2.0, Thomas Montaigu) and laspy tests/data (BSD-2-Clause, Grant Brown, Howard Butler, Thomas Montaigu), with points from them compressed by LASzip, in tests/fixtures/laz',
  ],
  [
    'packages/decoders/src/brotli-data.ts',
    'the static dictionary and word transformations of RFC 7932, Appendices A and B (IETF Trust; the data every Brotli decoder carries), generated from the RFC text and checked against its CRC-32 values',
  ],
  [
    'packages/decoders/tests/fixtures/NOTICE.md',
    'test fixtures: Khronos glTF sample models Box (CC BY 4.0, Cesium) and Avocado (CC0 1.0, Microsoft), Draco-compressed; AnisotropyBarnLamp normal texture (CC BY 4.0, Wayfair, Eric Chadwick)',
  ],
  [
    'packages/decoders/tests/fixtures/KTX2-README.md',
    'test fixtures: Khronos CarConcept textures Dot_C.ktx2 and Rib_N.ktx2 (CC BY 4.0, Darmstadt Graphics Group, Eric Chadwick)',
  ],
  [
    'packages/splats/test/fixtures/NOTICE.md',
    'test fixtures: slices of the Niantic Labs racoonfamily.spz and hornedlizard.spz samples (MIT, github.com/nianticlabs/spz), converted with PlayCanvas splat-transform (MIT) to PLY, SPZ and SOG',
  ],
  [
    'packages/exporters/tests/fixtures/NOTICE.md',
    'test fixtures: Khronos glTF sample models Box and BoxTextured (CC BY 4.0, Cesium)',
  ],
  [
    'packages/lightmap/tests/CORNELL-NOTICE.md',
    'test-only numerical Cornell box specification: geometry, reflectance measurements and emission knots from Cornell University, https://bowers.cornell.edu/computer-graphics/data (accessed 2026-11-08). Published specifications and resources for public use; no separate SPDX licence stated. Transcribed measurement facts, not renderer code or copied implementation files; excluded from package tarballs',
  ],
  [
    'packages/sky/test/fixtures/bsc5/NOTICE.md',
    'test fixtures: the Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit D. and Warren Jr W.H., NSSDC/ADC 1991), CDS catalogue V/50 catalog.gz and ReadMe byte for byte from the CDS VizieR mirror https://vizier.cfa.harvard.edu/ftp/cats/V/50/ (catalog.gz 573,921 bytes, SHA-256 3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed; ReadMe 11,571 bytes, SHA-256 44fd9c73e2eecad0beb47bdfa3f01c60fd43f93d6964198e31fcd48732de5b33; downloaded 2026-11-07), cross-checked against NASA HEASARC table bsc5p (heasarc_bsc5p.tdat.gz, SHA-256 122628cde2d8bedf7e16ddf5f888167ac58c04b5592d6155408ce297f3073931, not kept); CDS terms: free to use with acknowledgement of the CDS and of the catalogue authors',
  ],
  [
    'packages/weather/tests/fixtures/metar/NOTICE.md',
    'test fixtures: 798 METAR and SPECI reports of 50 aerodromes, the 12 hours before 2026-11-07 17:15 UTC, byte for byte from the NOAA Aviation Weather Center data service https://aviationweather.gov/api/data/metar (metar.txt 30,720 bytes, SHA-256 2ab25e4c497e3dec530ab26135ca3fe762ce0b0dae7f36f5db0bc69a5a6fdf79; metar2.txt 30,134 bytes, SHA-256 177e105cf7947f97ea84d344700b1956211f5683aee8da5a66c186b99e59c43d; downloaded 2026-11-07); a United States Government work, public domain in the United States; the observations of the issuing national weather services, exchanged under WMO Resolution 40',
  ],
  [
    'scripts/reference-rendering/NOTICE.md',
    'batch 160 outside reference data, never shipped: Khronos MetalRoughSpheresNoTextures (CC0-1.0, Krill Gavrilov, 2019), pinned source/scene/picture hashes and hosted Sample Viewer PNG provenance; original assets, legal notices and pictures stay in engine-bench/batch-160. Also records outside standard assets for the existing gltf-pro GPU checks',
  ],
];

/** Every published package: packages/* with a package.json, plus the two npm tools. */
export function publishedPackages() {
  const dirs = readdirSync(join(root, 'packages'))
    .map((dir) => `packages/${dir}`)
    .concat(['tools/create-margo', 'tools/margo-convert'])
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .sort();
  return dirs.map((dir) => ({ dir, manifest: json(`${dir}/package.json`) }));
}

const internal = (name) => name === 'margoengine' || name.startsWith('@margoengine/');

/** The lock entry key a dependency of `from` resolves to (nested node_modules first, as npm does). */
function lockKey(lock, from, name) {
  for (let base = from; ; ) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!base) return undefined;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut < 0 ? '' : base.slice(0, cut);
  }
}

/** Source files whose imports count as "used at runtime". */
function codeOf(dir, manifest) {
  if (dir.startsWith('tools/')) return manifest.files.filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);
  const walk = (d) =>
    readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|js|mjs)$/.test(e.name) ? [`${d}/${e.name}`] : [],
    );
  return existsSync(join(root, dir, 'src')) ? walk(`${dir}/src`) : [];
}

/** Collect the record and every rule violation. Pure apart from reading the repo. */
export function collect() {
  const lock = json('package-lock.json'),
    problems = [],
    deps = new Map(), // lock key -> {name, version, licence, users:Set, kinds:Set, via:Set}
    rows = [];
  const workspaces = new Set(json('package.json').workspaces);
  for (const { dir, manifest } of publishedPackages()) {
    const name = manifest.name,
      bin = manifest.bin && !manifest.exports;
    const need = ['license', 'files', 'version', ...(bin ? [] : ['exports', 'sideEffects'])];
    for (const field of need) if (manifest[field] === undefined) problems.push(`${name}: no "${field}"`);
    if (manifest.private) problems.push(`${name}: "private": true on a published package`);
    const expectedLicense = 'Apache-2.0';
    if (manifest.license !== expectedLicense)
      problems.push(`${name}: license ${manifest.license}, expected ${expectedLicense}`);
    if (!manifest.files?.includes('NOTICE')) problems.push(`${name}: "files" does not ship NOTICE`);
    if (manifest.publishConfig?.access !== 'public') problems.push(`${name}: publishConfig.access is not "public"`);
    for (const f of manifest.files ?? [])
      if (/^(src|tests?|fixtures|scripts)\b/.test(f)) problems.push(`${name}: "files" ships ${f}`);
    const code = codeOf(dir, manifest)
      .map((f) => read(f))
      .join('\n');
    const from = workspaces.has(dir) ? dir : '';
    const external = [];
    for (const [field, kind] of [
      ['dependencies', 'dependency'],
      ['peerDependencies', 'peer'],
      ['optionalDependencies', 'optional'],
    ])
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (internal(dep)) continue;
        const optional = manifest.peerDependenciesMeta?.[dep]?.optional ? 'optional peer' : kind;
        external.push(`${dep} ${range} (${optional})`);
        if (kind === 'dependency' && !new RegExp(`['"]${dep.replace(/[/@.-]/g, '\\$&')}['"/]`).test(code))
          problems.push(`${name}: runtime dependency ${dep} is never imported (build-time only? move it)`);
        const walk = (key, via) => {
          const entry = lock.packages[key],
            pkg = key.slice(key.lastIndexOf('node_modules/') + 13);
          const record = deps.get(key) ?? {
            name: pkg,
            version: entry.version,
            licence: entry.license ?? '(none)',
            users: new Set(),
            kinds: new Set(),
            via: new Set(),
          };
          const fresh = !deps.has(key);
          deps.set(key, record);
          record.users.add(name);
          record.kinds.add(via ? 'transitive' : optional);
          if (via) record.via.add(via);
          if (!fresh) return;
          if (!WHY[pkg]) problems.push(`${pkg}: no reason in WHY (scripts/supply-chain.mjs)`);
          if (!ALLOWED.has(record.licence) && EXCEPTIONS[pkg] !== record.licence)
            problems.push(`${pkg}@${entry.version}: licence ${record.licence} needs review`);
          if (entry.hasInstallScript) problems.push(`${pkg}@${entry.version}: has an install script`);
          if (entry.deprecated) problems.push(`${pkg}@${entry.version}: deprecated (${entry.deprecated})`);
          if (!entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/'))
            problems.push(`${pkg}@${entry.version}: not a registry.npmjs.org tarball with an integrity hash`);
          for (const child of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
            const childKey = lockKey(lock, key, child);
            if (childKey) walk(childKey, pkg);
            else problems.push(`${pkg}: dependency ${child} missing from package-lock.json`);
          }
        };
        const key = lockKey(lock, from, dep);
        if (key) walk(key, '');
        else problems.push(`${name}: ${dep} is not in package-lock.json (run npm install --package-lock-only)`);
      }
    const bundled = BUNDLED.filter((b) => b.package.split(', ').includes(name));
    for (const b of bundled)
      for (const notice of b.notices)
        if (!notice.startsWith('dist/') && !manifest.files?.includes(notice) && !existsSync(join(root, dir, notice)))
          problems.push(`${name}: notice ${notice} is neither in "files" nor in the package folder`);
    rows.push({
      name,
      external,
      bundled: bundled.map((b) => `${b.component.split(' (')[0]} (${b.licence.split(' ')[0]})`),
      notices: ['LICENSE', 'NOTICE', ...new Set(bundled.flatMap((b) => b.notices))],
    });
  }
  for (const [path] of ASSETS) if (!existsSync(join(root, path))) problems.push(`asset credit file missing: ${path}`);
  // Whole lockfile, dev and workspace tooling included: install scripts, deprecations, licence tally.
  const all = Object.entries(lock.packages).filter(([key, e]) => key.includes('node_modules/') && !e.link);
  const scripts = all.filter(([, e]) => e.hasInstallScript).map(([k, e]) => `${k.slice(13)}@${e.version}`);
  const deprecated = all.filter(([, e]) => e.deprecated).map(([k, e]) => `${k.slice(13)}@${e.version}`);
  const tally = {};
  for (const [, e] of all) tally[e.license ?? '(none)'] = (tally[e.license ?? '(none)'] ?? 0) + 1;
  for (const [key, e] of all)
    if (!e.integrity || !e.resolved?.startsWith('https://registry.npmjs.org/'))
      problems.push(`${key}: lockfile entry without a registry URL and integrity hash`);
  return { rows, deps: [...deps.values()], problems, scripts, deprecated, tally, total: all.length };
}

const cell = (s) => String(s).replaceAll('|', '\\|');

/** THIRD-PARTY-NOTICES.md for a collected record. Deterministic: no dates, sorted lists. */
export function render({ rows, deps, scripts, deprecated, tally, total }) {
  const table = (head, body) =>
    [
      `| ${head.join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
      ...body.map((r) => `| ${r.map(cell).join(' | ')} |`),
    ].join('\n');
  const withDeps = rows.filter((r) => r.external.length || r.bundled.length);
  return `<!-- Generated by scripts/supply-chain.mjs; do not edit. Re-run before every release (docs/releasing.md). -->
# Third-party notices

Margo Engine's own code is licensed under the Apache License 2.0 (\`LICENSE\` and \`NOTICE\`; every tarball ships both). This file lists everything else that
reaches users: npm packages our published packages depend on, third-party code shipped inside our tarballs, and the
assets the site and examples use. It covers all ${rows.length} published packages (${rows.length - 2} in \`packages/\`
plus \`create-margo\` and \`margo-convert\`). \`node scripts/supply-chain.mjs --check\` (in \`npm run verify\`, through
\`tests/supply-chain.test.js\`) fails when this file is stale, a dependency has no stated reason, a licence is outside
the allowed list, or a runtime dependency has an install script, a deprecation or a non-registry source.

## Runtime npm dependencies of published packages (direct and transitive)

${rows.length - withDeps.length} of ${rows.length} packages have no third-party runtime dependency at all (internal \`@margoengine/*\` ranges only).
Versions are the ones in \`package-lock.json\`; users get whatever their own lockfile resolves inside our ranges.

${table(
  ['Package', 'Version (lock)', 'Licence', 'Kind', 'Used by', 'Why'],
  deps
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => [
      `\`${d.name}\``,
      d.version,
      d.licence,
      [...d.kinds].sort().join(', ') + (d.via.size ? ` (via ${[...d.via].sort().join(', ')})` : ''),
      [...d.users].sort().join(', '),
      WHY[d.name] ?? '(missing)',
    ]),
)}

None of them has an install script (\`preinstall\`/\`install\`/\`postinstall\`), a deprecation notice or a source other
than registry.npmjs.org with an integrity hash. Peers are installed by the app, not by us.

## Third-party code inside our tarballs

${table(
  ['Package', 'Component', 'Licence', 'Shipped files', 'Modified', 'Notices in the tarball'],
  BUNDLED.map((b) => [b.package, b.component, b.licence, b.files, b.modified, b.notices.join(', ')]),
)}

### Licence obligations and how they are met

- **Apache-2.0 (Draco, Basis, jxl-oxide under its Apache-2.0 option; Rapier as a peer).** Redistribution must carry the licence text, keep the upstream
  notices and mark modified files. \`@margoengine/decoders\` ships \`dist/LICENSE-Apache-2.0.txt\` and
  \`dist/THIRD-PARTY-NOTICE.md\` (projects, sources, what changed); the modified \`basis_transcoder.js\` states the change
  in its first line. Neither upstream build ships a NOTICE file to carry forward. Rapier is not redistributed by us.
  The vendored files are byte-identical to the official releases (checked 2026-10-24; \`.gitattributes\` keeps them
  binary so checkouts do not change line endings):
  - Draco 1.5.6 glTF decoder from https://www.gstatic.com/draco/versioned/decoders/1.5.6/:
    \`draco_decoder_gltf.wasm\` (sha256 \`a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac\`) as
    \`draco_decoder.wasm\`, \`draco_wasm_wrapper_gltf.js\`
    (\`8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6\`) as \`draco_wasm_wrapper.js\`.
  - Draco 1.5.6 full decoder, for point clouds, from the same folder (checked 2026-11-06): \`draco_decoder.wasm\` (sha256
    \`c55a594e8ffd18426d36b27fea9618af3df5e173640a3e56d46f09d76f0574f2\`) and \`draco_wasm_wrapper.js\`
    (\`e8049906ef3f8f75d3456c22a3f31bfdfe5b5b5bd09ccdec613b9e9a49d554d8\`).
  - Basis Universal v1_50_0_2 WebGL transcoder from
    https://github.com/BinomialLLC/basis_universal/tree/v1_50_0_2/webgl/transcoder/build: \`basis_transcoder.wasm\`
    (\`6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a\`) and \`basis_transcoder.js\`
    (\`8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1\`, before the build's static-embind step).
  - jxl-oxide-wasm 0.12.6 from npm, https://www.npmjs.com/package/jxl-oxide-wasm/v/0.12.6 (checked 2026-11-06):
    \`jxl_oxide_wasm_bg.wasm\` (sha256 \`3336f3abd4a04fccc437e7a84f12d4b63c12f302044110867f99be14c4c75a69\`) and
    \`jxl_oxide_wasm.js\` (\`d9a314abc55d167e94e2d995ce6ab5276f86ef9de41f06df11fef3acf55ff6b7\`). The crates inside it are named in
    \`dist/THIRD-PARTY-NOTICE.md\`.
  - Draco 1.5.7 encoder from https://github.com/google/draco/tree/1.5.7/javascript (checked 2026-11-06):
    \`draco_encoder.wasm\` (sha256 \`d2a3ac80c91980d5d321c116454834ff36264825c6d1794cc84e42288f158958\`) and
    \`draco_encoder_wrapper.js\` (\`8434adecd1446459601763e499be3697546056bca90b286a538ae0483a00845a\`).
  - Basis Universal v1_50_0_2 WebGL encoder from
    https://github.com/BinomialLLC/basis_universal/tree/v1_50_0_2/webgl/encoder/build (checked 2026-11-06):
    \`basis_encoder.wasm\` (\`dea2778b6d1705b4fdf12053e94cda0ac1cc4340a7e06911778a003ba785808a\`) and
    \`basis_encoder.js\` (\`2c0aa2a648b6fc6006e116074a1dd075d6aaf1adb34d4bfd9818acd79e96537e\`, before the build's static-embind step).
- **Optional local tool, never shipped (sharp and libvips).** sharp (Apache-2.0) and its prebuilt libvips binaries
  (LGPL-3.0) are installed as an optional dependency of Next.js for \`examples/next\`, and
  \`scripts/optimize-demo-assets.js\` and \`scripts/build-scifi-helmet.mjs\` use sharp to resize textures. \`margo-convert
  build\` also uses a sharp that is already installed in the project it runs in (WebP, AVIF and JPEG encoding, resizing);
  it is not a dependency or peer of any package, nothing is downloaded, and without it \`margo-convert\` falls back to
  its own PNG writer. Neither sharp nor libvips is in any tarball or served by the site.
- **MIT (React).** Keep the copyright and permission notice: npm dependencies carry their own
  LICENSE files.
- **Site and demos.** The site build copies this file to \`/THIRD-PARTY-NOTICES.md\`, so the demos that bundle Draco,
  Basis or Rapier carry these notices next to the asset credits below.

## Published packages

${table(
  ['Package', 'Third-party runtime dependencies and peers', 'Third-party code inside', 'Licence files in the tarball'],
  rows.map((r) => [
    `\`${r.name}\``,
    r.external.length ? r.external.join('; ') : 'none',
    r.bundled.length ? r.bundled.join('; ') : 'none',
    r.notices.join(', '),
  ]),
)}

## Assets used by the site, demos and examples (not in any npm tarball)

${table(
  ['Credits file', 'Covers'],
  ASSETS.map(([path, what]) => [`[\`${path}\`](${path})`, what]),
)}

## Development and workspace tooling (never shipped)

\`package-lock.json\` holds ${total} third-party entries (build tools, test tools, the examples' and apps' own
dependencies, platform-optional binaries). Licences: ${Object.entries(tally)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, n]) => `${l} ${n}`)
    .join(', ')}.
Install scripts anywhere in the lock: ${scripts.length ? scripts.join(', ') : 'none'}. Deprecated: ${
    deprecated.length ? deprecated.join(', ') : 'none'
  }. \`webgpu\` is a development dependency only, for the Node proof of \`@margoengine/headless\`, and is never shipped; its
install script only clears the macOS quarantine flag on its binary. \`rhino3dm\` and \`laz-perf\` are not in the lock: the opt-in
\`test:real-files:runtimes\` tool of \`@margoengine/loaders\` fetches them at pinned versions into an ignored folder, for real-file tests only. CI and releases install with \`npm ci\`, which refuses a lockfile that does not match \`package.json\` and checks
every tarball against its integrity hash.
\`aioquic\` (BSD-3-Clause) is not in the lock: \`packages/netcode/tests/webtransport-proof/server.py\` uses it through a Python virtual environment of your own, for the by-hand WebTransport proof only. It is never shipped.
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = collect(),
    text = render(record);
  if (process.argv.includes('--check')) {
    const current = existsSync(join(root, OUTPUT)) ? read(OUTPUT).replaceAll('\r\n', '\n') : '';
    if (current !== text) record.problems.push(`${OUTPUT} is stale: run node scripts/supply-chain.mjs`);
    for (const p of record.problems) console.error(`supply-chain: ${p}`);
    process.exit(record.problems.length ? 1 : 0);
  }
  writeFileSync(join(root, OUTPUT), text);
  for (const p of record.problems) console.error(`supply-chain: ${p}`);
  console.log(`${OUTPUT}: ${record.rows.length} packages, ${record.deps.length} runtime npm dependencies`);
  process.exit(record.problems.length ? 1 : 0);
}
