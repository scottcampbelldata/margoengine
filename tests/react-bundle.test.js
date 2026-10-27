// Bundler checks for the React package, from the built packages (no install, no GPU):
//   1. every client entry of the built package starts with 'use client', so Next.js server components may import it;
//   2. a clean Vite + React 19 + TypeScript app written from the README's first scene builds for production, and the
//      only warnings are the two documented in packages/react/README.md ("Build warnings"); nothing else is printed.
// Next.js (webpack and Turbopack) builds are in scripts/bundler-matrix.mjs, part of check:merge.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const react = join(root, 'packages/react');

test('every entry of the React package starts with "use client"', () => {
  const exports = JSON.parse(readFileSync(join(react, 'package.json'), 'utf8')).exports;
  const entries = Object.entries(exports).filter(([key]) => key !== './package.json');
  assert.ok(entries.length >= 5);
  for (const [key, value] of entries) {
    const file = join(react, typeof value === 'string' ? value : value.import);
    assert.match(readFileSync(file, 'utf8'), /^['"]use client['"];?/, `${key} (${file}) must start with 'use client'`);
  }
});

test('the dist of the React package is free of side effects on import', () => {
  assert.equal(JSON.parse(readFileSync(join(react, 'package.json'), 'utf8')).sideEffects, false);
});

test('a Vite + React 19 production build from the README prints only the documented warnings', async () => {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results', 'react-vite-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    );
    // The README's first scene, plus the controls the "Models, environment and controls" section shows.
    writeFileSync(
      join(dir, 'src/main.tsx'),
      `import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial, OrbitControls } from 'margoengine/react';

createRoot(document.getElementById('root')!).render(
  <Canvas style={{ height: 400 }}>
    <Stage camera={{ position: [0, 2, 5] }}>
      <Mesh position={[0, 1, 0]} onClick={() => {}}>
        <BoxGeometry args={[1, 1, 1]} />
        <PbrMaterial color="#84d6bd" />
      </Mesh>
      <Suspense fallback={null}>
        <OrbitControls enableDamping />
      </Suspense>
    </Stage>
  </Canvas>,
);
`,
    );
    const seen = new Set();
    await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: 'dist',
        rollupOptions: {
          onwarn(warning) {
            seen.add(warning.code);
          },
        },
      },
    });
    const documented = new Set(['MODULE_LEVEL_DIRECTIVE', 'INEFFECTIVE_DYNAMIC_IMPORT']);
    assert.deepEqual(
      [...seen].filter((code) => !documented.has(code)),
      [],
      'a new build warning: fix it or document it',
    );
    const assets = readdirSync(join(dir, 'dist/assets'));
    assert.ok(
      assets.some((name) => name.startsWith('index-') && name.endsWith('.js')),
      'the app chunk exists',
    );
    // The README promises these two and no others; the build above is quiet once they are filtered.
    const readme = readFileSync(join(react, 'README.md'), 'utf8');
    for (const code of documented) assert.ok(readme.includes(code), `the README must explain ${code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
