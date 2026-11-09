import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, globSync } from 'node:fs';
import { join } from 'node:path';

function targets(value) {
  if (typeof value === 'string') return [value];
  if (!value) return [];
  return Object.values(value).flatMap(targets);
}
function missing(exports, hasFile) {
  return targets(exports).filter((target) => !hasFile(target));
}

test('every declared package export target exists after build, including all conditional and type targets', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const problems = [];
  for (const workspace of root.workspaces.filter((path) => path.startsWith('packages/')))
    for (const directory of globSync(workspace)) {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      const hasFile = (target) => {
        const candidates = target.includes('*')
          ? globSync(target, { cwd: directory }).map((path) => join(directory, path))
          : [join(directory, target)];
        return candidates.length > 0 && candidates.every((path) => existsSync(path) && statSync(path).isFile());
      };
      for (const target of missing(manifest.exports, hasFile)) problems.push(`${manifest.name}: ${target}`);
    }
  assert.deepEqual(problems, [], 'run npm run build:packages; every declared export branch must emit its target');
});

test('the export gate detects missing runtime, declaration and nested condition outputs', () => {
  const exports = {
    '.': {
      types: './dist/index.d.ts',
      browser: { import: './dist/browser.js' },
      node: { import: './dist/node.js' },
      default: './dist/index.js',
    },
    './choice': [null, './dist/choice.js'],
  };
  assert.deepEqual(
    missing(exports, (target) => target === './dist/index.js'),
    ['./dist/index.d.ts', './dist/browser.js', './dist/node.js', './dist/choice.js'],
  );
  assert.deepEqual(
    missing(exports, () => true),
    [],
  );
});

test('test-page 35/38/40: rebuilt preview, tilemap and viewcube APIs resolve', async () => {
  const [preview, iso, hex, axes, cube] = await Promise.all([
    import('@margoengine/webgl2-compat/preview'),
    import('@margoengine/tilemap/iso'),
    import('@margoengine/tilemap/hex'),
    import('@margoengine/viewcube/axes'),
    import('@margoengine/viewcube'),
  ]);
  assert.equal(typeof preview.webglRenderer, 'function');
  assert.equal(typeof iso.cellCenter, 'function');
  assert.equal(typeof hex.cellCenter, 'function');
  assert.equal(typeof axes.AxisTriad.attach, 'function');
  assert.equal(typeof cube.ViewCube.prototype.setTheme, 'function');
  assert.equal(typeof cube.ViewCube.prototype.roll, 'function');
});
