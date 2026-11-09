import { runLimited } from '../../../scripts/support/run-limited.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { BiomeWorld } from '../dist/index.js';
import * as io from '../dist/io.js';
async function prove() {
  const parent = '349243b3d';
  const folder = resolve('test-results/biomes-io-proof/parent');
  const files = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', parent, 'packages/biomes/src', 'packages/shared'],
    { encoding: 'utf8', timeout: 30000 },
  )
    .trim()
    .split('\n');
  for (const file of files) {
    const target = resolve(folder, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${parent}:${file}`], { timeout: 30000 }));
  }
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^@margoengine\/biomes\/([\w-]+)$/, replacement: resolve(folder, 'packages/biomes/src/$1.ts') },
        { find: '@margoengine/biomes', replacement: resolve(folder, 'packages/biomes/src/index.ts') },
      ],
    },
    build: {
      outDir: resolve(folder, 'dist'),
      lib: {
        entry: {
          index: resolve(folder, 'packages/biomes/src/index.ts'),
          io: resolve(folder, 'packages/biomes/src/io.ts'),
        },
        formats: ['es'],
        fileName: (_, n) => n + '.js',
      },
      rollupOptions: {
        external: (id) =>
          id.startsWith('@margoengine/') && id !== '@margoengine/biomes' && !id.startsWith('@margoengine/biomes/'),
      },
    },
  });
  const old = await import(pathToFileURL(resolve(folder, 'dist/index.js')));
  const oldIo = await import(pathToFileURL(resolve(folder, 'dist/io.js')));
  function summarize(value) {
    if (ArrayBuffer.isView(value))
      return {
        type: value.constructor.name,
        bytes: value.byteLength,
        sha256: createHash('sha256')
          .update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
          .digest('hex'),
      };
    if (value instanceof Map) return [...value].map(([k, v]) => [k, summarize(v)]);
    if (Array.isArray(value)) return value.map(summarize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v)]));
    if (typeof value === 'string' && value.length > 1000)
      return { chars: value.length, sha256: createHash('sha256').update(value).digest('hex') };
    return value;
  }
  async function run(World, api, label) {
    const world = await World.create();
    let tiles = 0;
    const tile = world.tile.bind(world);
    world.tile = (...args) => {
      tiles++;
      return tile(...args);
    };
    const result = {};
    try {
      for (const [name, args] of [
        ['exportHeight', ['png16']],
        ['exportWeights', []],
        ['exportMasks', []],
        ['exportLayer', ['temperature', 'csv']],
      ]) {
        result[name] = summarize(await api[name](world, ...args));
        console.log(label, name, tiles);
      }
      const copy = await api.loadWorld(JSON.stringify(api.saveWorld(world)), { workers: false });
      try {
        result.digest = await world.digest(0, 0);
        assert.equal(await copy.digest(0, 0), result.digest);
      } finally {
        copy.dispose();
      }
      return { result, tiles };
    } finally {
      world.dispose();
    }
  }
  const before = await run(old.BiomeWorld, oldIo, 'parent'),
    after = await run(BiomeWorld, io, 'current');
  assert.deepEqual(after.result, before.result);
  assert.deepEqual([before.tiles, after.tiles], [1537, 1025]);
  const proof = {
    parent,
    world: { size: [4096, 4096], resolution: 1, tiles: 256 },
    evidence: 'Complete CPU export output equality and deterministic work counts; no speed claim',
    beforeTiles: before.tiles - 1,
    afterTiles: after.tiles - 1,
    output: after.result,
  };
  writeFileSync('test-results/biomes-io-proof/result.json', JSON.stringify(proof, null, 2) + '\n');
  console.log('MATCH', JSON.stringify(proof));
}
process.chdir(resolve(import.meta.dirname, '../../..'));
if (process.argv.includes('--child')) await prove();
else {
  const result = await runLimited('node packages/biomes/scripts/io-proof.mjs --child', {
    cwd: process.cwd(),
    limitMs: 300000,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}
