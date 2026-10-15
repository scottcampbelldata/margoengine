import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { SnapshotBuffer, createSnapshot } from '../packages/net/dist/index.js';

const baselineRef = process.argv[2];
assert.ok(baselineRef, 'Usage: node scripts/benchmark-net.js <baseline Git ref>');
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${baselineRef}^{commit}`], {
  encoding: 'utf8',
}).trim();
const root = resolve('packages/net'),
  entry = resolve(root, 'src/index.ts');
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:packages/net/src/index.ts`], {
  encoding: 'utf8',
});
assert.notEqual(
  baselineSource.replace(/\r\n/g, '\n'),
  (await readFile(entry, 'utf8')).replace(/\r\n/g, '\n'),
  'Choose a Git ref before the Net change',
);
async function compile(source) {
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    ...(source
      ? {
          plugins: [
            {
              name: 'net-baseline-source',
              enforce: 'pre',
              load(id) {
                if (id === entry.replaceAll('\\', '/')) return source;
              },
            },
          ],
        }
      : {}),
    build: {
      write: false,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: 'index' },
      rollupOptions: { external: ['@margoengine/core'] },
    },
  });
  const chunks = result[0].output.filter((item) => item.type === 'chunk');
  assert.equal(chunks.length, 1, 'Net comparison must stay a single standalone module');
  return chunks[0].code.replace(/^\/\/#region packages\/net\/src\/index\.ts\r?\n/, '//#region src/index.ts\n');
}
const baselineCode = await compile(baselineSource),
  candidateCode = await compile();
assert.equal(
  candidateCode,
  await readFile(new URL('../packages/net/dist/index.js', import.meta.url), 'utf8'),
  'Rebuild Net before benchmarking',
);
const baseline = await import(`data:text/javascript;base64,${Buffer.from(baselineCode).toString('base64')}`);
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
function fixture(Type, count, capacity, angleStep) {
  const buffers = [],
    outputs = [];
  for (let actor = 0; actor < count; actor++) {
    const buffer = new Type(capacity);
    for (let i = 0; i < capacity + 3; i++) {
      const angle = i * angleStep + actor * 0.01;
      buffer.push(
        i * 0.05,
        [i * 0.1, actor, Math.sin(i)],
        [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
        [2, 0, Math.cos(i)],
      );
    }
    buffers.push(buffer);
    outputs.push(createSnapshot());
  }
  return { buffers, outputs, start: (capacity + 2) * 0.05 - 0.071 };
}
function measure(value, frames) {
  const start = performance.now();
  let checksum = 0;
  for (let frame = 0; frame < frames; frame++)
    for (let i = 0; i < value.buffers.length; i++) {
      const output = value.buffers[i].sample(value.start + (frame % 5) * 0.003, value.outputs[i]);
      checksum += output.position[0] + output.rotation[3];
    }
  assert.ok(Number.isFinite(checksum));
  return { millisecondsPerFrame: (performance.now() - start) / frames, checksum };
}
const results = [];
for (const [count, capacity, angleStep] of [
  [256, 32, 0.01],
  [1024, 32, 0.01],
  [1024, 32, 1.3],
  [256, 257, 0.01],
]) {
  const candidate = fixture(SnapshotBuffer, count, capacity, angleStep),
    original = baseline && fixture(baseline.SnapshotBuffer, count, capacity, angleStep);
  if (original)
    for (let i = 0; i < count; i++)
      for (const offset of [-10, -0.02, 0, 0.02, 10]) {
        assert.deepEqual(
          candidate.buffers[i].sample(candidate.start + offset, candidate.outputs[i]),
          original.buffers[i].sample(original.start + offset, original.outputs[i]),
        );
      }
  measure(candidate, 100);
  if (original) measure(original, 100);
  const pairs = [];
  for (let pair = 0; pair < 20; pair++) {
    let a, b;
    if (!original) b = measure(candidate, 100);
    else if (pair % 2) {
      b = measure(candidate, 100);
      a = measure(original, 100);
    } else {
      a = measure(original, 100);
      b = measure(candidate, 100);
    }
    if (a) assert.equal(b.checksum, a.checksum);
    pairs.push({
      baselineMilliseconds: a?.millisecondsPerFrame ?? null,
      candidateMilliseconds: b.millisecondsPerFrame,
    });
  }
  results.push({
    count,
    capacity,
    angleStep,
    baselineMedianMilliseconds: original ? median(pairs.map((pair) => pair.baselineMilliseconds)) : null,
    candidateMedianMilliseconds: median(pairs.map((pair) => pair.candidateMilliseconds)),
    pairs,
  });
}
function size(code) {
  return { raw: Buffer.byteLength(code), gzip: gzipSync(code).length };
}
const report = {
  time: new Date().toISOString(),
  baselineRef,
  baselineCommit,
  runtime: process.version,
  platform: process.platform,
  note: 'CPU-only snapshot interpolation fixture; exact outputs and counterbalanced warmed pairs. This does not prove whole-app or mobile FPS.',
  baselineSize: size(baselineCode),
  candidateSize: size(candidateCode),
  results,
};
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../test-results/net-cpu-benchmark.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify({ ...report, results: results.map(({ pairs, ...result }) => result) }, null, 2));
