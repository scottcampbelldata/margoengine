import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OWNER_EXCLUSIONS, OWNER_FIXTURES, selectOwnerPackages } from '../scripts/support/owner-lifetime-registry.mjs';

// A package with no fixture and an exclusion must hold nothing with a lifetime. Its source is read for everything that
// would give it one; a package that gains such a thing fails here until it gets a fixture and leaves OWNER_EXCLUSIONS.
const root = fileURLToPath(new URL('../', import.meta.url));
const PURE = {
  math: 'src/mesh.ts reads core runtime state without holding any of it (an allowed import, checked below); every other file is arithmetic on numbers and typed arrays.',
  splines: 'Curve evaluation, fitting and queries on numbers and typed arrays.',
  'kinematics-constraints':
    'Solvers on numbers and typed arrays; src/sdf.ts imports bvh pointInside, a pure winding-number query (an allowed import, checked below); src/multi-goal.ts takes an AbortSignal and only polls it with throwIfAborted.',
  brep: 'STEP, IGES and JT readers and B-rep modelling on plain objects and typed arrays; its runtime imports are math matrices and errors.',
};
// The one runtime import of an engine package a pure package may have, and what it may do with it.
const RUNTIME_IMPORT_ALLOWED = {
  math: ['src/mesh.ts'],
  'kinematics-constraints': ['src/sdf.ts'],
  // @margoengine/math/mat4 and /errors: pure functions and an error class, themselves checked here as math.
  brep: ['src/iges/step.ts', 'src/jt/read.ts', 'src/step/structure.ts'],
};
// Calls that share a lifetime pattern's name without holding one, masked out of a line before the patterns run.
const CALL_ALLOWED = {
  // Loop.use(edge, forward) adds an edge use to a B-rep face loop (src/model/topology.ts, checked below).
  brep: /\b(?:loop|bl|tl|sl|el|l)\.use\(/g,
};
// Single lines that name a lifetime word without holding one, each with the exact text allowed.
const LINE_ALLOWED = {
  // The request option's type. The solve only calls signal.throwIfAborted(), which the patterns do not match.
  'kinematics-constraints': { 'src/multi-goal.ts': ['signal?: AbortSignal;'] },
};
const LIFETIME = [
  [/\baddEventListener\b|\bremoveEventListener\b|\bEventTarget\b/, 'an event listener or target'],
  [
    /\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b|\brequestAnimationFrame\b|\brequestIdleCallback\b/,
    'a timer or frame callback',
  ],
  [/\bnew\s+(Shared)?Worker\b|\bpostMessage\b|\bMessageChannel\b|\bBroadcastChannel\b/, 'a worker or channel'],
  [/\bAbortController\b|\bAbortSignal\b/, 'an AbortSignal subscription'],
  [
    /\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\bcaches\b|\bnavigator\b|\bFileSystem\w*Handle\b/,
    'a storage handle',
  ],
  [/\.gpu\b|\bcreateBuffer\b|\bcreateTexture\b|\bGPU\w*\b|\bWebAssembly\b/, 'a GPU resource or Wasm instance'],
  [
    /\bonFrame\b|\.use\(|\bFinalizationRegistry\b|\bWeakRef\b|\bdispose\b|Symbol\.dispose/,
    'an engine registration or disposal',
  ],
  [/\bdocument\b|\bwindow\b|\bglobalThis\b/, 'a global object'],
];
const strip = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
const sources = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}/${e.name}`) : /\.(ts|js|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : [],
  );

for (const name of Object.keys(PURE))
  test(`${name} is excluded from owner/lifetime fixtures and its source holds nothing with a lifetime`, () => {
    assert.ok(OWNER_EXCLUSIONS[name], `${name} is in OWNER_EXCLUSIONS with its reason`);
    assert.equal(OWNER_FIXTURES[name], undefined, `${name} has a fixture, so it leaves OWNER_EXCLUSIONS`);
    assert.deepEqual(selectOwnerPackages([name]), { selected: [], pending: [] });
    const found = [];
    for (const file of sources(`${root}packages/${name}/src`)) {
      const relative = file.slice(`${root}packages/${name}/`.length);
      strip(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (LINE_ALLOWED[name]?.[relative]?.includes(line.trim())) return;
          const masked = CALL_ALLOWED[name] ? line.replace(CALL_ALLOWED[name], '') : line;
          for (const [pattern, what] of LIFETIME) if (pattern.test(masked)) found.push(`${relative}:${i + 1} ${what}`);
          const engine = /from\s+'(@margoengine\/[^']+)'/.exec(line);
          if (
            engine &&
            !/^\s*import\s+type\b/.test(line) &&
            !/^\s*export\s+type\b/.test(line) &&
            !(RUNTIME_IMPORT_ALLOWED[name] ?? []).includes(relative)
          )
            found.push(`${relative}:${i + 1} a runtime import of ${engine[1]}`);
        });
    }
    assert.deepEqual(
      found,
      [],
      `${name} now holds something with a lifetime: write packages/${name}/test(s)/owner-lifetime.fixture.js and drop the exclusion`,
    );
  });

test('the brep calls masked as Loop.use are the B-rep loop method, which holds nothing', () => {
  const topology = readFileSync(`${root}packages/brep/src/model/topology.ts`, 'utf8');
  const body = /export class Loop \{([\s\S]*?)\n\}/.exec(topology)?.[1] ?? '';
  assert.match(
    body,
    /\n {2}use\(edge: Edge, forward: boolean\): Coedge \{/,
    'Loop.use(edge, forward) is still the loop method',
  );
  assert.ok(!LIFETIME.some(([pattern]) => pattern.test(strip(body))), 'Loop holds nothing with a lifetime');
  assert.equal(
    'engine.use(plugin)'.replace(CALL_ALLOWED.brep, ''),
    'engine.use(plugin)',
    'an engine registration is not masked',
  );
});

test('the guard catches each kind of lifetime a pure package could gain', () => {
  for (const [sample, what] of [
    ["window.addEventListener('resize', f)", 'an event listener or target'],
    ['setTimeout(f, 1)', 'a timer or frame callback'],
    ["new Worker('x')", 'a worker or channel'],
    ['const c = new AbortController()', 'an AbortSignal subscription'],
    ['indexedDB.open(name)', 'a storage handle'],
    ['device.createBuffer(d)', 'a GPU resource or Wasm instance'],
    ['engine.onFrame(f)', 'an engine registration or disposal'],
    ['globalThis.x', 'a global object'],
  ])
    assert.ok(
      LIFETIME.some(([pattern, label]) => label === what && pattern.test(sample)),
      sample,
    );
});

// The install kits are generated bundles (scripts/umbrella.mjs): every source line is a comment or a re-export of another
// package's own entry. They create nothing, so each lifetime a kit hands out is owned and fixtured by the package it
// re-exports.
for (const name of ['kit-react', 'kit-viz', 'kit-web'])
  test(`${name} only re-exports other packages and holds nothing of its own`, () => {
    assert.ok(OWNER_EXCLUSIONS[name], `${name} is in OWNER_EXCLUSIONS with its reason`);
    assert.equal(OWNER_FIXTURES[name], undefined, `${name} has a fixture, so it leaves OWNER_EXCLUSIONS`);
    assert.deepEqual(selectOwnerPackages([name]), { selected: [], pending: [] });
    const files = sources(`${root}packages/${name}/src`);
    assert.ok(files.length > 10, `${name} has its entries`);
    const found = [];
    for (const file of files) {
      const relative = file.slice(`${root}packages/${name}/`.length);
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (line.trim() === '' || line.startsWith('//')) return;
          if (!/^export (\*|\{[^}]*\}) from '@margoengine\/[^']+';$/.test(line))
            found.push(`${relative}:${i + 1} ${line.trim()}`);
        });
    }
    assert.deepEqual(
      found,
      [],
      `${name} now holds code of its own: write packages/${name}/test(s)/owner-lifetime.fixture.js and drop the exclusion`,
    );
  });

// The game install profile is generated like the kits, but its index re-exports named bindings over several lines, so the
// whole file (comments stripped) must be re-exports and nothing else.
test('game only re-exports other packages and holds nothing of its own', () => {
  assert.ok(OWNER_EXCLUSIONS.game, 'game is in OWNER_EXCLUSIONS with its reason');
  assert.equal(OWNER_FIXTURES.game, undefined, 'game has a fixture, so it leaves OWNER_EXCLUSIONS');
  assert.deepEqual(selectOwnerPackages(['game']), { selected: [], pending: [] });
  const reexports = /^\s*(?:export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+'@margoengine\/[^']+';\s*)*$/;
  const files = sources(`${root}packages/game/src`);
  assert.ok(files.length > 10, 'game has its entries');
  assert.deepEqual(
    files.filter((file) => !reexports.test(strip(readFileSync(file, 'utf8')))).map((file) => file.slice(root.length)),
    [],
    'game now holds code of its own: write packages/game/tests/owner-lifetime.fixture.js and drop the exclusion',
  );
  for (const bad of [
    "import { engine } from '@margoengine/core';\nexport * from '@margoengine/animation';",
    'export const x = 1;',
    "export * from './local.js';",
    "export * from '@margoengine/core'; engine.use(plugin);",
  ])
    assert.ok(!reexports.test(strip(bad)), bad);
  for (const ok of [
    "export * from '@margoengine/animation';",
    "// x\nexport {\n  a,\n  b,\n} from '@margoengine/geometry/primitives';\nexport type { T } from '@margoengine/core';",
  ])
    assert.ok(reexports.test(strip(ok)), ok);
});

test('every exclusion has a reason and a package behind it', () => {
  for (const [name, reason] of Object.entries(OWNER_EXCLUSIONS)) {
    assert.ok(reason.length > 20, `${name} states why`);
    assert.ok(existsSync(`${root}packages/${name}/package.json`), `${name} is a package`);
  }
});
