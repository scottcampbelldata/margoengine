// Supply-chain record for every published package (HANDOFF launch gate 11c): runtime npm dependencies (direct and
// transitive, from package-lock.json), third-party code shipped inside our tarballs, the licence obligations that
// come with it, and the asset credits of the site and examples. Writes THIRD-PARTY-NOTICES.md; re-run before every
// release (docs/releasing.md):
//   node scripts/supply-chain.mjs          rewrite THIRD-PARTY-NOTICES.md
//   node scripts/supply-chain.mjs --check  exit 1 when the file is stale or a rule below is broken
// Rules: every published manifest has license/repository/files/exports/sideEffects and is not private; every
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
const REPOSITORY = 'git+https://github.com/scottcampbelldata/margoengine.git';
export const OUTPUT = 'THIRD-PARTY-NOTICES.md';

/** Licences any runtime dependency may carry without review. */
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Zlib', '0BSD']);
/** Reviewed exceptions: package -> licence it may carry (see the obligations section of the output). */
const EXCEPTIONS = { 'occt-import-js': 'LGPL-2.1', 'web-ifc': 'MPL-2.0' };

/** Why each external runtime dependency or peer exists. A new one fails --check until it is added here. */
const WHY = {
  'recast-navigation': 'Recast/Detour navmesh generation, path and crowd queries (compiled to Wasm by the package)',
  '@recast-navigation/core': 'runtime half of recast-navigation (loads the Wasm build)',
  '@recast-navigation/generators': 'navmesh generator helpers of recast-navigation',
  '@recast-navigation/wasm': 'Recast/Detour compiled to WebAssembly (inlined as base64 in the compat build)',
  '@dimforge/rapier3d-compat': 'Rapier rigid-body solver; optional, the app installs and initializes it',
  'web-ifc': 'IFC (BIM) parser; the app installs and initializes it, the package only reads its output',
  react: 'React component bindings for the stage',
  'react-dom': 'React DOM root and portal rendering for scene and HTML components',
  scheduler: 'React DOM scheduling dependency',
  'occt-import-js': 'OpenCascade STEP/IGES/BREP tessellation in Node (offline converter)',
};

/**
 * Third-party code inside our own tarballs (not npm dependencies). `notices` are tarball paths that must ship
 * (tests/supply-chain.test.js checks the packed file lists); `source` is where the copy comes from in this repo.
 */
export const BUNDLED = [
  {
    package: '@margoengine/materials',
    component: 'Khronos thin-film Fresnel and three.js Charlie sheen directional-albedo fit',
    licence: 'Apache-2.0 AND MIT',
    files: 'dist material-lobe shaders',
    source: 'packages/materials/src/lobe-shader.ts; upstream references in THIRD_PARTY_NOTICES.md',
    modified: 'translated to WGSL and adapted to the isolated material extension slot',
    notices: ['THIRD_PARTY_NOTICES.md'],
  },
  {
    package: '@margoengine/decoders',
    component: 'Draco 3D decoder (Google)',
    licence: 'Apache-2.0',
    files: 'dist/draco/draco_decoder.wasm, dist/draco/draco_wasm_wrapper.js',
    source: 'packages/decoders/vendor/draco (official build as redistributed by three 0.181.0)',
    modified: 'no',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/decoders',
    component: 'Basis Universal transcoder (Binomial LLC)',
    licence: 'Apache-2.0',
    files: 'dist/basis/basis_transcoder.wasm, dist/basis/basis_transcoder.js',
    source: 'packages/decoders/vendor/basis (official build as redistributed by three 0.181.0)',
    modified:
      'the .js glue only: scripts/static-embind.js swaps two `new Function` generators for closures; the file states it in its first line',
    notices: ['dist/THIRD-PARTY-NOTICE.md', 'dist/LICENSE-Apache-2.0.txt'],
  },
  {
    package: '@margoengine/decoders',
    component: 'meshoptimizer vertex/index decoder (Arseny Kapoulkine)',
    licence: 'MIT',
    files: 'dist/meshopt.js',
    source: 'packages/decoders/src/meshopt.ts (TypeScript port of the reference decoder)',
    modified: 'ported to TypeScript',
    notices: ['dist/THIRD-PARTY-NOTICE.md'],
  },
  {
    package: '@margoengine/machinery',
    component: 'occt-import-js 0.0.23 with OpenCascade (Viktor Kovacs; Open Cascade SAS)',
    licence: 'LGPL-2.1',
    files: 'dist/workers/occt-import-js.wasm, dist/workers/occt-import-js.js',
    source: 'node_modules/occt-import-js/dist, copied by scripts/build-modern.js',
    modified:
      'the .js glue only: scripts/static-embind.js swaps two `new Function` generators for closures; the file states it in its first line',
    notices: ['dist/workers/OCCT-NOTICE.txt', 'dist/workers/OCCT-LICENSE.txt'],
  },
  {
    package: '@margoengine/text',
    component: 'TinySDF distance transform (Mapbox)',
    licence: 'BSD-2-Clause',
    files: 'dist/sdf.js',
    source: 'packages/text/src/sdf.ts (same Felzenszwalb-Huttenlocher transform and structure as TinySDF)',
    modified: 'rewritten in TypeScript',
    notices: ['NOTICE.md'],
  },
  {
    package: '@margoengine/post, @margoengine/tonemap',
    component:
      'Colour-transform references: AgX (Troy Sobotka, Eary Chow), ACES fit (Stephen Hill), Khronos PBR Neutral',
    licence: 'attribution (formulas and constants; tests re-derive every matrix)',
    files: 'AgX/ACES shader code (also compiled into gltf-pro, animation, lod and shader from packages/shared)',
    source: 'packages/shared/agx.js, packages/shared/aces.js, packages/tonemap/src/shaders.ts',
    modified: 're-derived',
    notices: ['NOTICE.md'],
  },
];

/** Credits for the assets the site, demos and examples use. None of these files is in an npm tarball. */
const ASSETS = [
  ['examples/assets/ATTRIBUTION.md', 'demo models: RobotExpressive (CC0), FlightHelmet (CC0), Tokyo diorama (MIT)'],
  ['examples/assets/robot-CREDITS.md', 'RobotExpressive upstream credits (Tomás Laulhé, Don McCurdy; CC0)'],
  [
    'examples/assets/tokyo-diorama-CREDITS.md',
    'Tokyo diorama: Poly Haven textures (CC0), Noto Sans CJK (OFL 1.1); inspiration credit to Glen Fox, Littlest Tokyo (CC BY 4.0, nothing copied)',
  ],
  ['examples/assets/khronos/README.md', '32 Khronos glTF sample models, each CC0 1.0 or CC BY 4.0 with its credit'],
  ['examples/assets/kaykit/LICENSE-adventurers.txt', 'KayKit Adventurers (Kay Lousberg, CC0)'],
  ['examples/assets/kaykit/LICENSE-character-animations.txt', 'KayKit Character Animations (Kay Lousberg, CC0)'],
  ['examples/assets/kaykit/LICENSE-dungeon.txt', 'KayKit Dungeon (Kay Lousberg, CC0)'],
  [
    'packages/creative/examples/earth/assets/ATTRIBUTION.md',
    'Earth demo: NASA Blue Marble, Solar System Scope textures (CC BY 4.0)',
  ],
  [
    'examples/assets/damaged-helmet-CREDITS.md',
    'DamagedHelmet (CC BY-NC 4.0 / CC BY 4.0): internal tests and benchmarks only, never served',
  ],
  [
    'packages/environment/tests/fixtures/NOTICE.md',
    'test fixtures: OpenEXR test images (BSD-3-Clause), three.js spot1Lux.hdr (MIT)',
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
    const need = ['license', 'repository', 'files', 'version', ...(bin ? [] : ['exports', 'sideEffects'])];
    for (const field of need) if (manifest[field] === undefined) problems.push(`${name}: no "${field}"`);
    if (manifest.private) problems.push(`${name}: "private": true on a published package`);
    const expectedLicense = name === '@margoengine/materials' ? 'MIT AND Apache-2.0' : 'MIT';
    if (manifest.license !== expectedLicense)
      problems.push(`${name}: license ${manifest.license}, expected ${expectedLicense}`);
    if (manifest.publishConfig?.access !== 'public') problems.push(`${name}: publishConfig.access is not "public"`);
    if (manifest.repository?.url !== REPOSITORY || manifest.repository?.directory !== dir)
      problems.push(`${name}: repository must be ${REPOSITORY} with directory ${dir} (npm --provenance checks it)`);
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
      notices: ['LICENSE', ...new Set(bundled.flatMap((b) => b.notices))],
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

Margo Engine's own code is MIT licensed (\`LICENSE\`; every tarball ships a copy). This file lists everything else that
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

- **Apache-2.0 (Draco, Basis; Rapier as a peer).** Redistribution must carry the licence text, keep the upstream
  notices and mark modified files. \`@margoengine/decoders\` ships \`dist/LICENSE-Apache-2.0.txt\` and
  \`dist/THIRD-PARTY-NOTICE.md\` (projects, sources, what changed); the modified \`basis_transcoder.js\` states the change
  in its first line. Neither upstream build ships a NOTICE file to carry forward. Rapier is not redistributed by us.
- **LGPL-2.1 (occt-import-js and the OpenCascade code compiled into it, \`@margoengine/machinery\`).** We ship the
  library unchanged as Wasm plus a modified copy of its JavaScript glue. How each obligation is met:
  - *Licence and notice* (s. 1, 2): \`dist/workers/OCCT-LICENSE.txt\` (the upstream LGPL-2.1 text) and
    \`dist/workers/OCCT-NOTICE.txt\` ship next to the files.
  - *Modified files carry a notice of the change* (s. 2b): the glue's first line says it was modified by Margo Engine's
    build and how; OCCT-NOTICE.txt repeats it. The change is generated, so its date is the build's; the transformation
    and its history are \`scripts/static-embind.js\` in the public repository.
  - *The modified library stays LGPL-2.1* (s. 2c): OCCT-NOTICE.txt says so; only Margo Engine's own code is MIT.
  - *Corresponding source* (s. 4): the glue is itself JavaScript source, and the exact transformation is in our
    repository (\`scripts/static-embind.js\`, MIT, published with every release tag). The unmodified Wasm's source is
    occt-import-js 0.0.23 (its npm tarball carries the importer's C++ and build scripts) with the OpenCascade revision
    pinned by its git submodule; OCCT-NOTICE.txt links both.
  - *Replace or relink* (s. 6): the glue and Wasm are separate files loaded by URL at run time
    (\`dist/workers/occt-import-js.js\`, \`.wasm\`), never bundled into our code, so a user can drop in their own
    interface-compatible build. \`margo-convert\` depends on the unmodified npm package, so npm can swap it.
- **MPL-2.0 (web-ifc, peer of \`@margoengine/ifc\`).** Not redistributed in any tarball: the app installs it. A site or
  app that serves \`web-ifc.wasm\` must say where its source is (https://github.com/ThatOpen/engine_web-ifc).
- **MIT (meshoptimizer port, recast-navigation, React).** Keep the copyright and permission notice: the decoders notice
  carries meshoptimizer's; npm dependencies carry their own LICENSE files.
- **BSD-2-Clause (TinySDF).** \`@margoengine/text\` ships \`NOTICE.md\` with the copyright, conditions and disclaimer.
- **Zlib (Recast/Detour inside \`@recast-navigation/wasm\`).** Requires the notice in source distributions only; we do
  not redistribute it (npm dependency).
- **Site and demos.** The site build copies this file to \`/THIRD-PARTY-NOTICES.md\`, so the demos that bundle Draco,
  Basis, OCCT, Rapier or Recast carry these notices next to the asset credits below.

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
  }. CI and releases install with \`npm ci\`, which refuses a lockfile that does not match \`package.json\` and checks
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
