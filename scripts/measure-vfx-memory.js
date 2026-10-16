import assert from 'node:assert/strict';
import { build } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { optionalGPU } from '../tests/support/optional-gpu.js';
import { prepareSources } from './support/vfx-memory-candidate.js';

const source = await prepareSources(process.argv[2]),
  root = resolve('packages/vfx'),
  reports = {};
await mkdir('test-results', { recursive: true });
for (const name of ['original', 'full', 'partial']) {
  const replacement =
    name === 'original'
      ? { index: source.originalIndex, shader: source.originalShaderSource }
      : { index: source.index, shader: name === 'full' ? source.fullShaderSource : source.partialShaderSource };
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: replacement
      ? [
          {
            name: 'vfx-memory-experiment',
            enforce: 'pre',
            transform(code, id) {
              const path = id.replaceAll('\\', '/');
              if (path.endsWith('/packages/vfx/src/index.ts')) return replacement.index;
              if (path.endsWith('/packages/vfx/src/shader.ts')) return replacement.shader;
            },
          },
        ]
      : [],
    build: {
      write: false,
      target: 'es2022',
      lib: { entry: resolve(root, 'src/index.ts'), formats: ['es'], fileName: 'index' },
      rollupOptions: { external: (id) => id === '@margoengine/core' || id.startsWith('@margoengine/core/') },
    },
  });
  const code = (Array.isArray(result) ? result : [result])
    .flatMap((output) => output.output)
    .filter((output) => output.type === 'chunk')
    .map((output) => output.code)
    .join('\n');
  await writeFile(`test-results/vfx-inplace-${name}.mjs`, code);
  const loadable = code.replace(
    /from\s+(['"])@margoengine\/core\/extension\1/g,
    (_, quote) => `from ${quote}${pathToFileURL(resolve('packages/core/dist/extension.js')).href}${quote}`,
  );
  const { VFX } = await import(`data:text/javascript;base64,${Buffer.from(loadable).toString('base64')}`);
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = new VFX({ capacity: 32, initialCount: 17, rate: 0 });
  h.engine.use(effect);
  const owned = h.resources.slice(),
    buffersBefore = owned.filter((resource) => resource.size !== undefined),
    before = effect.gpuState.particles;
  const budget = () => new Uint32Array(h.resources.findLast((r) => r.size === 224 && !r.destroyed).data)[53];
  h.frame();
  assert.equal(budget(), 17);
  const afterOne = effect.gpuState.particles;
  h.frame();
  assert.equal(budget(), 0);
  const afterTwo = effect.gpuState.particles;
  if (name === 'original') {
    assert.notEqual(afterOne, before);
    assert.equal(afterTwo, before);
  } else {
    assert.equal(afterOne, before);
    assert.equal(afterTwo, before);
    assert.equal(buffersBefore.filter((buffer) => buffer.size === 32 * 64).length, 1);
  }
  effect.onDeviceRestored(h.engine);
  assert.ok(owned.every((resource) => resource.destroyed));
  assert.notEqual(effect.gpuState.particles, before);
  h.frame();
  assert.equal(budget(), 17);
  h.frame();
  assert.equal(budget(), 0);
  effect.dispose();
  effect.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
  assert.throws(() => effect.gpuState, /not attached/);
  for (const options of [
    { capacity: 0 },
    { capacity: 1000001 },
    { capacity: 32, initialCount: 33 },
    { lifetime: [0, 1] },
    { bounce: 2 },
    { gravity: [NaN, 0, 0] },
    { emissionExtent: [-1, 0, 0] },
    { intensity: 17 },
  ])
    assert.throws(() => new VFX(options));
  reports[name] = {
    raw: Buffer.byteLength(code),
    gzip: gzipSync(code).length,
    buffersBefore: buffersBefore.length,
    stateBytesAt32: buffersBefore
      .filter((buffer) => buffer.size === 32 * 64)
      .reduce((sum, buffer) => sum + buffer.size, 0),
    currentBufferIdentity: name === 'original' ? 'alternates' : 'stable/latest',
    restorationOldResourcesDestroyed: true,
    restorationReseedBudgetExact: true,
    idempotentDisposalAllResourcesDestroyed: true,
    invalidOptionsRejected: true,
  };
}
for (const name of ['full', 'partial'])
  reports[name].delta = {
    raw: reports[name].raw - reports.original.raw,
    gzip: reports[name].gzip - reports.original.gzip,
  };
reports.baselineRef = process.argv[2];
await writeFile('test-results/vfx-inplace-size-lifecycle.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
