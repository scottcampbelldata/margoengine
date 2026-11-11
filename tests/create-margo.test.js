// create-margo: scaffolds into a temp dir, then type-checks and builds the app against this checkout's packages
// (node_modules links instead of an install, so no network). Needs `npm run build:packages` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..'),
  cli = join(root, 'tools/create-margo/index.js');
const run = (args, cwd) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_user_agent: 'pnpm/10.0.0 node/v24' },
  });

test('create-margo scaffolds the template and refuses a non-empty directory', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'create-margo-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const output = run(['My App'], temp),
    app = join(temp, 'My App');
  assert.match(output, /cd "My App"\n {2}pnpm install\n {2}pnpm dev/);
  assert.deepEqual(readdirSync(app).sort(), [
    '.gitignore',
    'README.md',
    'index.html',
    'package.json',
    'public',
    'src',
    'tsconfig.json',
  ]);
  const headers = readFileSync(join(app, 'public/_headers'), 'utf8');
  for (const directive of ["script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", 'immutable'])
    assert.ok(headers.includes(directive), directive);
  assert.doesNotMatch(
    headers,
    /'unsafe-eval'/,
    'no file, worker included, needs unsafe-eval (tests/no-eval-workers.test.js)',
  );
  assert.ok(
    readdirSync(join(app, 'public')).includes('404.html'),
    'a 404 page keeps hosts from serving index.html for missing assets',
  );
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'my-app');
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    const local = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(range, `^${local.version}`, `${name} should track the workspace version`);
  }
  const main = readFileSync(join(app, 'src/main.ts'), 'utf8');
  for (const call of [
    'applyQualityTier()',
    'paceEngine(engine)',
    'watchQuality()',
    'OrbitControls.attach(engine)',
    'Stats.attach(engine)',
    'EnvironmentLighting.attach(',
  ])
    assert.ok(main.includes(call), call);
  assert.ok(main.indexOf('applyQualityTier()') < main.indexOf('Engine.create('), 'quality tier before the engine');

  writeFileSync(join(temp, 'taken.txt'), '');
  assert.throws(() => execFileSync(process.execPath, [cli, '.'], { cwd: temp, stdio: 'pipe' }), /not empty/);
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'x', '--template', 'x'], { cwd: temp, stdio: 'pipe' }),
    /unknown template x; use one of web, game, viz, react, next/,
  );
  assert.throws(() => execFileSync(process.execPath, [cli, '--force'], { cwd: temp, stdio: 'pipe' }), /unknown option/);
  assert.ok(!existsSync(join(temp, 'x')) && !existsSync(join(temp, '--template')));
});

// The app each template scaffolds, its engine imports, and what its build must contain.
const templates = {
  web: { main: 'src/main.ts', imports: "from '@margoengine/web/environment'" },
  game: { main: 'src/main.ts', imports: "from '@margoengine/game'" },
  viz: { main: 'src/main.ts', imports: "from '@margoengine/viz'" },
  react: { main: 'src/scene.tsx', imports: "from '@margoengine/react-kit'" },
};

for (const [template, { main, imports }] of Object.entries(templates))
  test(`the ${template} template type-checks and builds against the local packages`, { timeout: 180_000 }, (t) => {
    const temp = mkdtempSync(join(tmpdir(), 'create-margo-build-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    run(['app', '--template', template], temp);
    const app = join(temp, 'app'),
      modules = join(app, 'node_modules'),
      manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    assert.deepEqual(
      Object.keys(manifest.dependencies).filter((name) => name.includes('margoengine')),
      [`@margoengine/${template === 'react' ? 'react-kit' : template}`],
      'one engine dependency',
    );
    assert.ok(readFileSync(join(app, main), 'utf8').includes(imports), imports);
    link(app, manifest);
    execFileSync(process.execPath, [join(modules, 'typescript/bin/tsc'), '-p', app], { cwd: app, stdio: 'pipe' });
    execFileSync(process.execPath, [join(modules, 'vite/bin/vite.js'), 'build', '--logLevel', 'error'], {
      cwd: app,
      stdio: 'pipe',
    });
    assert.ok(existsSync(join(app, 'dist/_headers')), 'Vite copies public/_headers into dist');
    const assets = join(app, 'dist/assets'),
      scripts = readdirSync(assets).filter((file) => file.endsWith('.js'));
    const gzip = scripts.reduce(
      (sum, file) => sum + gzipSync(readFileSync(join(assets, file)), { level: 9 }).length,
      0,
    );
    console.log(`create-margo ${template} app: ${scripts.length} JS file(s), ${gzip} bytes gzip`);
    if (template === 'web') assert.ok(gzip > 10_000 && gzip < 80_000, `unexpected bundle size ${gzip}`);
    else assert.ok(gzip > 10_000, `unexpected bundle size ${gzip}`);
  });

// Type-checked here; Next's own build needs a real install (linked copies of next and react break its prerender), so
// scripts/bundler-matrix.mjs builds it with webpack and Turbopack.
test('the next template type-checks against the local packages', { timeout: 120_000 }, (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'create-margo-next-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  run(['app', '--template', 'next'], temp);
  const app = join(temp, 'app'),
    manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  assert.ok(readFileSync(join(app, 'app/page.tsx'), 'utf8').includes("from '@margoengine/react-kit'"));
  link(app, manifest);
  // next-env.d.ts is what `next dev` writes on first run.
  writeFileSync(
    join(app, 'next-env.d.ts'),
    '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
  );
  execFileSync(process.execPath, [join(app, 'node_modules/typescript/bin/tsc'), '-p', app, '--noEmit'], {
    cwd: app,
    stdio: 'pipe',
  });
});

/** node_modules links to this checkout instead of an install, so no network. */
function link(app, manifest) {
  for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) {
    mkdirSync(dirname(join(app, 'node_modules', name)), { recursive: true });
    symlinkSync(join(root, 'node_modules', name), join(app, 'node_modules', name), 'junction');
  }
}

test('the game template carries the Vite config that keeps its production build free of the chunk-size warning', () => {
  // Rapier's WebAssembly is a 4.3 MB lazy chunk; without this limit a newcomer's first `npm run build` printed
  // "(!) Some chunks are larger than 500 kB" (found by scripts/template-install-check.mjs, which fails on any warning).
  const config = readFileSync(join(root, 'tools/create-margo/templates/game/vite.config.ts'), 'utf8');
  assert.match(config, /chunkSizeWarningLimit:\s*4500/);
});
