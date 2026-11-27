// KB-INL1: a package that declares @margoengine/math imports its MargoError class from `@margoengine/math/errors`
// instead of bundling a copy, so an app holding several packages holds one class. Needs `npm run build:packages` first.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  declaresMath,
  mathExternal,
  HELPERS_ENTRY,
  SHARED_HELPERS,
  sharedHelpers,
  withMathExternal,
} from '../scripts/support/math-external.mjs';

const root = resolve(import.meta.dirname, '..');
// The class as every build emits it, minified or not: a subclass of Error that names itself MargoError.
const INLINED = /extends Error\s*\{[^{}]*constructor\([^)]*\)\s*\{[^{}]*this\.name\s*=\s*[`"']MargoError[`"']/;

test('mathExternal keeps math and its subpaths external only for a package that declares math', () => {
  const declared = mathExternal({ dependencies: { '@margoengine/math': '^1.0.0' } });
  assert.equal(declared('@margoengine/math'), true);
  assert.equal(declared('@margoengine/math/errors'), true);
  assert.equal(declared('@margoengine/mathematics'), false);
  assert.equal(declared('@margoengine/core'), false);
  assert.equal(mathExternal({ peerDependencies: { '@margoengine/math': '^1.0.0' } })('@margoengine/math/errors'), true);
  assert.equal(mathExternal({ dependencies: { '@margoengine/core': '^1.0.0' } })('@margoengine/math/errors'), false);
  assert.equal(declaresMath({}), false);
  const listed = withMathExternal({ dependencies: { '@margoengine/math': '1' } }, ['@margoengine/core', /^node:/]);
  assert.deepEqual(['@margoengine/core', 'node:fs', '@margoengine/math/errors', '@margoengine/bvh'].map(listed), [
    true,
    true,
    true,
    false,
  ]);
  assert.equal(withMathExternal({}, (id) => id === 'x')('@margoengine/math/errors'), false);
});

test('the detector finds the class as Vite emits it, minified and not', () => {
  assert.match('var e=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}}', INLINED);
  assert.match(
    'class MargoError extends Error {\n\tconstructor(e, t) {\n\t\tsuper(t), this.name = "MargoError";',
    INLINED,
  );
  assert.doesNotMatch("import { MargoError as e } from '@margoengine/math/errors';", INLINED);
  assert.doesNotMatch('Object.assign(Error(t),{name:`MargoError`,code:e})', INLINED);
});

/** Every shipped JavaScript file of a package dist, module workers left out (a worker reads no import map). */
function* shipped(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'workers') yield* shipped(path);
    } else if (entry.name.endsWith('.js') && !/worker/i.test(entry.name)) yield path;
  }
}

test('no package that declares @margoengine/math ships its own MargoError class', () => {
  const found = [];
  let scanned = 0;
  for (const name of readdirSync(join(root, 'packages'))) {
    const manifest = join(root, 'packages', name, 'package.json'),
      dist = join(root, 'packages', name, 'dist');
    if (name === 'math' || !existsSync(manifest) || !existsSync(dist)) continue;
    if (!declaresMath(JSON.parse(readFileSync(manifest, 'utf8')))) continue;
    for (const file of shipped(dist)) {
      scanned++;
      if (INLINED.test(readFileSync(file, 'utf8'))) found.push(file.slice(root.length + 1).replaceAll('\\', '/'));
    }
  }
  assert.ok(scanned > 100, `only ${scanned} dist files scanned: run npm run build:packages first`);
  assert.deepEqual(found, [], 'these dist files bundle MargoError instead of importing @margoengine/math/errors');
});

test('no package dist loads @margoengine/math with a dynamic import', () => {
  // Math is in every app's static graph, so a dynamic import() of it only makes the app's bundler build the module's
  // namespace object and ship its runtime helper (splats encode.ts put rolldown/runtime.js in margoengine/viz).
  const DYNAMIC = /import\(\s*[`"']@margoengine\/math/;
  assert.match('await import(`@margoengine/math/errors`)', DYNAMIC);
  assert.doesNotMatch("import{MargoError as e}from'@margoengine/math/errors'", DYNAMIC);
  const found = [];
  for (const name of readdirSync(join(root, 'packages'))) {
    const dist = join(root, 'packages', name, 'dist');
    if (name === 'math' || name === 'margoengine' || !existsSync(dist)) continue;
    for (const file of shipped(dist))
      if (DYNAMIC.test(readFileSync(file, 'utf8'))) found.push(file.slice(root.length + 1).replaceAll('\\', '/'));
  }
  assert.deepEqual(found, [], 'these dist files import @margoengine/math dynamically; import it statically');
});

test('every package that imports @margoengine/math declares it', () => {
  const undeclared = [];
  const imports = (directory) =>
    readdirSync(directory, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
        ? imports(join(directory, entry.name))
        : /\.tsx?$|\.js$/.test(entry.name) &&
          /from '@margoengine\/math(\/[\w-]+)?'/.test(readFileSync(join(directory, entry.name), 'utf8')),
    );
  for (const name of readdirSync(join(root, 'packages'))) {
    const manifest = join(root, 'packages', name, 'package.json'),
      source = join(root, 'packages', name, 'src');
    if (name === 'math' || !existsSync(manifest) || !existsSync(source)) continue;
    if (imports(source) && !declaresMath(JSON.parse(readFileSync(manifest, 'utf8')))) undeclared.push(name);
  }
  assert.deepEqual(undeclared, [], 'these packages import @margoengine/math without declaring it');
});

// KB-INL1 part B: the packages on SHARED_HELPERS import the shared error and hypot helpers from HELPERS_ENTRY
// (@margoengine/core/extension, Scott 2026-11-26) instead of bundling a copy. The copies as the builds emit them:
const HELPER_COPIES = {
  margoError: /Object\.assign\(\s*(?:new\s+)?Error\([^()]*\)\s*,\s*\{\s*name:\s*[`"']MargoError[`"']/,
  linked: /; see https:\/\/margoengine\.com\/errors#\$\{/,
  hypot: /Math\.sqrt\(\s*\w+\[4\]\s*\)\s*\*\s*\w+/,
};
const HELPER_NAMES = ['fault', 'hypot', 'hypotOf', 'hypotTerms', 'margoError', 'rangeError', 'typeError'];
const exportsOf = async (path) => {
  const entry = join(root, path);
  assert.ok(existsSync(entry), `${path} missing: run npm run build:packages first`);
  return Object.keys(await import(pathToFileURL(entry).href));
};

test('the helper-copy detectors find each copy as Vite emits it, minified and not', () => {
  assert.match('var e=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e})', HELPER_COPIES.margoError);
  assert.match(
    "const margoError = (code, message) => Object.assign(new Error(message), { name: 'MargoError', code });",
    HELPER_COPIES.margoError,
  );
  assert.match('t=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`', HELPER_COPIES.linked);
  assert.match('n[4]=n[4],n[4]=Math.sqrt(n[4])*t', HELPER_COPIES.hypot);
  assert.match('terms[4] = Math.sqrt(terms[4]) * max;', HELPER_COPIES.hypot);
  assert.doesNotMatch(
    "import { fault as e, hypot as t } from '@margoengine/core/extension';",
    HELPER_COPIES.margoError,
  );
  for (const re of Object.values(HELPER_COPIES))
    assert.doesNotMatch("import{rangeError as e}from'@margoengine/core/extension'", re);
});

test('sharedHelpers redirects packages/shared/errors.js and hypot.js only for a listed package that declares core', () => {
  const importer = join(root, 'packages/shadows/src/index.ts').replaceAll('\\', '/'),
    core = { peerDependencies: { '@margoengine/core': '^1.0.0' } },
    on = sharedHelpers({ name: '@margoengine/shadows', ...core }),
    redirected = { id: HELPERS_ENTRY, external: true, moduleSideEffects: false };
  assert.equal(HELPERS_ENTRY, '@margoengine/core/extension');
  assert.deepEqual(on.resolveId('../../shared/hypot.js', importer), redirected);
  assert.deepEqual(on.resolveId('../../shared/errors.js', importer), redirected);
  assert.equal(on.resolveId('../../shared/finite.js', importer), null);
  assert.equal(on.resolveId('@margoengine/core', importer), null);
  assert.equal(sharedHelpers({ name: '@margoengine/shadows' }).resolveId('../../shared/hypot.js', importer), null);
  assert.equal(sharedHelpers({ name: '@margoengine/sky', ...core }).resolveId('../../shared/hypot.js', importer), null);
});

test('@margoengine/math/helpers exports exactly the shared helpers, and core/extension exports each of them', async () => {
  assert.deepEqual((await exportsOf('packages/math/dist/helpers.js')).sort(), HELPER_NAMES);
  const extension = await exportsOf('packages/core/dist/extension.js');
  assert.deepEqual(
    HELPER_NAMES.filter((name) => !extension.includes(name)),
    [],
    'core/extension lacks these helpers',
  );
});

test('the SHARED_HELPERS packages ship no copy of the shared helpers and import only names core/extension has', async () => {
  const extension = await exportsOf('packages/core/dist/extension.js'),
    copies = [],
    unknown = [];
  let importing = 0;
  for (const name of SHARED_HELPERS) {
    const dist = join(root, 'packages', name.slice('@margoengine/'.length), 'dist');
    assert.ok(existsSync(dist), `${dist} missing: run npm run build:packages first`);
    for (const file of shipped(dist)) {
      const text = readFileSync(file, 'utf8'),
        at = file.slice(root.length + 1).replaceAll('\\', '/');
      for (const [kind, re] of Object.entries(HELPER_COPIES)) if (re.test(text)) copies.push(`${at}: ${kind}`);
      for (const [, list] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@margoengine\/core\/extension["']/g)) {
        for (const part of list.split(',')) {
          const imported = part.trim().split(/\s+as\s+/)[0];
          if (HELPER_NAMES.includes(imported)) importing++;
          if (imported && !extension.includes(imported)) unknown.push(`${at}: ${imported}`);
        }
      }
    }
  }
  assert.ok(importing >= 3, `only ${importing} helper imports of ${HELPERS_ENTRY}: the redirect did not run`);
  assert.deepEqual(copies, [], `these dist files bundle a shared helper instead of importing ${HELPERS_ENTRY}`);
  assert.deepEqual(unknown, [], `these dist files import a name ${HELPERS_ENTRY} does not export`);
});
