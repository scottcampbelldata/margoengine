// Bundler checks for the React package, from the built packages (no install, no GPU):
//   1. every "react-server" entry of the built package starts with 'use client', so Next.js server components may import it;
//   2. a Vite + React 19 production build of the README's first scene, resolved through the workspace links (the
//      README's clone route), prints no warning at all. Vite hides the warnings of modules inside node_modules, so the
//      bundler matrix (installed tarballs) cannot see a warning that our own modules cause; this build can.
// Next.js (webpack and Turbopack) builds are in scripts/bundler-matrix.mjs, part of check:merge.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const react = join(root, 'packages/react');

test('every react-server entry of the React package starts with "use client"', () => {
  const exports = JSON.parse(readFileSync(join(react, 'package.json'), 'utf8')).exports;
  const entries = Object.entries(exports).filter(([key]) => key !== './package.json');
  assert.ok(entries.length >= 5);
  for (const [key, value] of entries) {
    const file = join(react, typeof value === 'string' ? value : value['react-server']);
    assert.match(readFileSync(file, 'utf8'), /^['"]use client['"];?/, `${key} (${file}) must start with 'use client'`);
  }
});

test('the dist of the React package is free of side effects on import', () => {
  assert.equal(JSON.parse(readFileSync(join(react, 'package.json'), 'utf8')).sideEffects, false);
});

// <Html> once loaded react-dom with import(); react-dom/client already puts react-dom in every app's entry, so the
// import() moved nothing and Vite printed INEFFECTIVE_DYNAMIC_IMPORT for every app (2026-10-27).
test('a Vite + React 19 production build of the README first scene prints no warnings', async () => {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results', 'react-vite-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    );
    // The README's first scene, plus the controls and an Html label.
    writeFileSync(
      join(dir, 'src/main.tsx'),
      `import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial, OrbitControls, Html } from 'margoengine/react';

createRoot(document.getElementById('root')!).render(
  <Canvas style={{ height: 400 }}>
    <Stage camera={{ position: [0, 2, 5] }}>
      <Mesh position={[0, 1, 0]} onClick={() => {}}>
        <BoxGeometry args={[1, 1, 1]} />
        <PbrMaterial color="#84d6bd" />
        <Html>cube</Html>
      </Mesh>
      <Suspense fallback={null}>
        <OrbitControls enableDamping />
      </Suspense>
    </Stage>
  </Canvas>,
);
`,
    );
    const warnings = [];
    await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: 'dist',
        rollupOptions: { onwarn: (warning) => warnings.push(`${warning.code}: ${warning.message}`) },
      },
    });
    assert.deepEqual(warnings, [], 'the build prints no warnings');
    assert.ok(
      readdirSync(join(dir, 'dist/assets')).some((name) => name.startsWith('index-') && name.endsWith('.js')),
      'the app chunk exists',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
