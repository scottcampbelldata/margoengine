// KB-INL1: a package that declares @margoengine/math imports its MargoError class from `@margoengine/math/errors`
// instead of bundling a copy, so an app holding several packages holds one class. Needs `npm run build:packages` first.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { declaresMath, mathExternal, withMathExternal } from '../scripts/support/math-external.mjs';

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
