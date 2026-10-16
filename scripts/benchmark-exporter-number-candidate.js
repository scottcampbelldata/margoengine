import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { serializerNumberSources, importExporterNumberSource } from './support/serializer-number-candidate.js';
import { parseOFF } from '../packages/loaders/dist/index.js';
import { displayGeometry, geometryData } from '../examples/package-benchmarks/asset-scene.js';

const iterations = Number(process.env.NUM_CANDIDATE_ITERATIONS ?? 16);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 8 && iterations <= 128);
const sources = await serializerNumberSources(),
  implementations = {
    A: await importExporterNumberSource(sources.original),
    B: await importExporterNumberSource(sources.candidate),
  };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const geometry = geometryData(
  displayGeometry(parseOFF(new Uint8Array(await readFile('packages/loaders/tests/fixtures/decimated-knight.off')))),
);
const scene = {
  nodes: [
    {
      name: 'Knight',
      geometry,
      translation: [0.1, -0.4, 0.7],
      rotation: [0.2, -0.1, 0.3, 0.9],
      scale: [-1, 0.5, 2],
      material: { color: [0.3, 0.6, 0.45, 1], roughness: 0.65, doubleSided: true },
    },
  ],
};
const cases = [
  ['glb', 'exportGLB', {}],
  ['gltf', 'exportGLTF', {}],
  ['stl-binary', 'exportSTL', {}],
  ['stl-text', 'exportSTL', { binary: false }],
  ['obj-mtl', 'exportOBJ', {}],
  ['ply-binary', 'exportPLY', { binary: true }],
  ['ply-text', 'exportPLY', {}],
  ['usdz', 'exportUSDZ', {}],
];
const report = {
  recordedAt: new Date().toISOString(),
  iterations,
  productionChanged: false,
  variant: 'shared-number-conversion',
  interpretation:
    'Private actual serializer CPU/size comparison. Exact output-byte/text and validation parity are required. No browser/GPU/FPS/startup claim.',
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, hash(source)])),
  cases: [],
};
for (const [name, method, options] of cases) {
  const operations = {
    A: () => implementations.A[method](scene, options),
    B: () => implementations.B[method](scene, options),
  };
  const expected = operations.A(),
    actual = operations.B();
  assert.deepEqual(actual, expected);
  const outcome = (operation) => {
    try {
      operation();
      return null;
    } catch (error) {
      return { type: error.constructor.name, message: error.message };
    }
  };
  const invalid = { nodes: [{ geometry: { ...geometry, positions: new Float32Array([NaN, 0, 0]) } }] };
  const error = outcome(() => implementations.A[method](invalid, options));
  assert.ok(error);
  assert.deepEqual(
    outcome(() => implementations.B[method](invalid, options)),
    error,
  );
  for (const operation of Object.values(operations)) for (let i = 0; i < 8; i++) operation();
  const result = {
    name,
    method,
    errorParity: error,
    runs: [],
    outputSHA256: hash(expected instanceof Uint8Array ? expected : JSON.stringify(expected)),
  };
  for (const implementation of ['A', 'B', 'B', 'A', 'B', 'A', 'A', 'B']) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) operations[implementation]();
    result.runs.push({ implementation, millisecondsPerExport: (performance.now() - started) / iterations });
  }
  const median = (implementation) =>
    result.runs
      .filter((run) => run.implementation === implementation)
      .map((run) => run.millisecondsPerExport)
      .sort((a, b) => a - b)
      .slice(1, 3)
      .reduce((sum, value) => sum + value, 0) / 2;
  result.medians = { A: median('A'), B: median('B') };
  result.speedRatio = result.medians.A / result.medians.B;
  report.cases.push(result);
}
if (process.env.NUM_CANDIDATE_SIZE === '1') {
  const { build } = await import('vite'),
    { compactOutput } = await import('./measure-size.js');
  report.bundles = {};
  for (const [name, source] of Object.entries(sources))
    for (const package_ of ['exporters', 'usdz-export']) {
      const built = await build({
        configFile: false,
        publicDir: false,
        logLevel: 'silent',
        resolve: { alias: { '@margoengine/exporters/usdz': resolve('packages/exporters/src/usdz.ts') } },
        plugins: [
          {
            name: 'private-number-source',
            enforce: 'pre',
            transform(_code, id) {
              if (id.replaceAll('\\', '/') === resolve('packages/exporters/src/scene.ts').replaceAll('\\', '/'))
                return { code: source, map: null };
            },
          },
        ],
        build: {
          write: false,
          target: 'es2022',
          lib: { entry: `packages/${package_}/src/index.ts`, formats: ['es'] },
          rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'], output: compactOutput },
        },
      });
      const code = (Array.isArray(built) ? built[0] : built).output
        .filter((chunk) => chunk.type === 'chunk')
        .map((chunk) => chunk.code)
        .join('\n');
      (report.bundles[package_] ??= {})[name] = {
        raw: Buffer.byteLength(code),
        gzip: gzipSync(code).length,
        sha256: hash(code),
      };
    }
  for (const pair of Object.values(report.bundles))
    pair.delta = { raw: pair.candidate.raw - pair.original.raw, gzip: pair.candidate.gzip - pair.original.gzip };
}
report.completedAt = new Date().toISOString();
await mkdir('test-results', { recursive: true });
await writeFile('test-results/exporter-number-private-candidate.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    cases: report.cases.map(({ name, medians, speedRatio }) => ({ name, medians, speedRatio })),
    bundles: report.bundles,
    productionChanged: false,
  }),
);
