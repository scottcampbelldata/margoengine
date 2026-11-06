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
    'site/fonts/OFL.txt',
    'site text typeface: Source Sans 3 (Copyright 2010-2024 Adobe, with Reserved Font Name "Source"; SIL Open Font License 1.1, full text in the linked file), self-hosted as site/fonts/SourceSans3-latin.woff2, the Latin subset of the variable font exactly as served by Google Fonts (https://fonts.gstatic.com/s/sourcesans3/v20/nwpStKy2OAdR1K-IwhWudF-R3w8aZQ.woff2, 28,872 bytes, SHA-256 19143dca075972bc84e3fd9eab7416dd40cc565dccb2435a044bdfabe060c7d5, fetched 2026-10-28, not modified); licence text from https://github.com/adobe-fonts/source-sans (LICENSE.md, SHA-256 56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328)',
  ],
  [
    'examples/assets/ATTRIBUTION.md',
    'demo models: RobotExpressive (CC0), FlightHelmet (CC0), Tokyo diorama (Apache-2.0)',
  ],
  [
    'examples/assets/vrm/README.md',
    'sample avatars for the VRM tests: Seed-san and VRM1_Constraint_Twist_Sample (VRM Consortium samples, VRM Public License 1.0; Seed-san model by VirtualCast, Inc.; (c) 2022 pixiv Inc.)',
  ],
  ['examples/assets/robot-CREDITS.md', 'RobotExpressive upstream credits (Tomás Laulhé, Don McCurdy; CC0)'],
  [
    'examples/assets/tokyo-diorama-CREDITS.md',
    'Tokyo diorama: Poly Haven textures (CC0), Noto Sans CJK (OFL 1.1); inspiration credit to Glen Fox, Littlest Tokyo (CC BY 4.0, nothing copied)',
  ],
  ['examples/assets/khronos/README.md', '32 Khronos glTF sample models, each CC0 1.0 or CC BY 4.0 with its credit'],
  [
    'examples/assets/khronos-samples/README.md',
    'Collada and KHR_animation_pointer test models: AnimatedColorsCube (CC0 1.0, Khronos glTF-Sample-Assets), Cesium Man `.dae` and texture (CC BY 4.0, Cesium); URLs, pinned commits and sha256 there',
  ],
  ['examples/assets/kaykit/LICENSE-adventurers.txt', 'KayKit Adventurers (Kay Lousberg, CC0)'],
  ['examples/assets/kaykit/LICENSE-character-animations.txt', 'KayKit Character Animations (Kay Lousberg, CC0)'],
  ['examples/assets/kaykit/LICENSE-dungeon.txt', 'KayKit Dungeon (Kay Lousberg, CC0)'],
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
  ['packages/environment/tests/fixtures/NOTICE.md', 'test fixtures: OpenEXR test images (BSD-3-Clause)'],
  [
    'packages/gltf-pro/tests/fixtures/bump/NOTICE.md',
    'test fixture: BumpMaterial.gltf, the EXT_materials_bump interoperability file from luma.gl (CC0-1.0, vis.gl contributors)',
  ],
  [
    'packages/gltf-pro/tests/fixtures/uv/NOTICE.md',
    'test fixture: FourUV.glb, exported for this project by Blender 5.3 from fixtures/uv/four-uv.blender.py (Apache-2.0, as this repository)',
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
    'packages/gltf-pro/tests/fixtures/physics/NOTICE.md',
    'test fixtures: the KHR_physics_rigid_bodies sample files of https://github.com/visgl/luma.gl/tree/master/examples/gltf/physics/assets (MIT, vis.gl contributors)',
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
    'real-file test: 104 public sample files, downloaded by URL and never in the repository or a tarball; each one\'s source, author and licence is in this manifest (public domain, CC0, CC BY, BSD, MIT, Apache-2.0, OFL and sample-file notices)',
  ],
  [
    'packages/loaders/tests/fixtures/SOURCES.txt',
    'test fixtures: Point Cloud Library test/bunny.pcd (BSD-3-Clause, github.com/PointCloudLibrary/pcl; Stanford bunny scan), libigl tutorial data cube.off and decimated-knight.off, PyVista vtk-data fran_cut.vtk and polyEx.vtk',
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
