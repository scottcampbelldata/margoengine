import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRandom } from '@margoengine/math/mathutils';
import { generateTypeScript } from '../dist/generate.js';
import { every, generator } from './values.js';

const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const root = resolve(import.meta.dirname, '../../..');

// The generated module, written to a temporary folder and imported as TypeScript (Node strips the types).
async function load(t) {
  const dir = mkdtempSync(join(tmpdir(), 'netcode-generate-')),
    file = join(dir, 'protocol.ts');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, generateTypeScript(every, { source: 'tests/values.js' }));
  return { file, dir, module: await import(pathToFileURL(file).href) };
}

test('generated TypeScript writes the same bytes as the runtime codec, full and delta, and decodes them back', async (t) => {
  const { module } = await load(t);
  assert.equal(module.SCHEMA_HASH, every.hash);
  const random = createRandom(11),
    { struct, mutate } = generator(every, random);
  for (let n = 0; n < 300; n++) {
    const value = struct('All'),
      bytes = every.encode('All', value);
    assert.ok(equalBytes(module.encodeAll(value), bytes), `full ${n}`);
    assert.ok(equalBytes(every.encode('All', module.decodeAll(bytes)), bytes), `decode ${n}`);
    const base = every.decode('All', bytes),
      next = mutate('All', base),
      delta = every.encodeDelta('All', next, base);
    assert.ok(equalBytes(module.encodeAllDelta(next, base), delta), `delta ${n}`);
    assert.ok(
      equalBytes(every.encode('All', module.decodeAllDelta(delta, base)), every.encode('All', next)),
      `delta decode ${n}`,
    );
    assert.equal(module.sameAll(value, base), true);
  }
});

test('generated decoders refuse the same malformed bytes as the runtime, with RangeError only', async (t) => {
  const { module } = await load(t);
  const random = createRandom(12),
    { struct } = generator(every, random);
  let both = 0;
  for (let n = 0; n < 1000; n++) {
    const bytes = every.encode('All', struct('All'));
    bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    const cut = bytes.subarray(0, Math.floor(random() * bytes.length + 1));
    let runtime, generated;
    try {
      runtime = every.encode('All', every.decode('All', cut));
    } catch (error) {
      assert.ok(error instanceof RangeError);
      runtime = 'refused';
    }
    try {
      generated = every.encode('All', module.decodeAll(cut));
    } catch (error) {
      assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
      generated = 'refused';
    }
    assert.deepEqual(generated, runtime, `case ${n}`);
    if (runtime === 'refused') both++;
  }
  assert.ok(both > 300);
  assert.throws(() => module.encodeAll({}), TypeError);
});

test('the generated module type-checks under strict TypeScript', async (t) => {
  const { dir } = await load(t);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        noEmit: true,
        lib: ['ES2022', 'DOM'],
        types: [],
      },
      include: ['protocol.ts'],
    }),
  );
  const run = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('generateTypeScript checks its argument', () => {
  assert.throws(() => generateTypeScript({}), /defineSchema/);
});

test('structs named like the globals and runtime classes the module uses still generate code that type-checks', async (t) => {
  const { defineSchema } = await import('../dist/index.js');
  // A game may well call a struct Map; the module's own Map, Uint8Array, DataView, Writer and Reader types must not
  // be shadowed by it.
  const named = defineSchema({
    types: {
      Map: { width: 'uint', tiles: { type: 'bytes', maxLength: 64 } },
      Writer: { name: { type: 'string', maxLength: 16 } },
      Reader: { page: 'u16' },
      DataView: { at: 'f32' },
      Uint8Array: { n: 'u8' },
      RangeError: { code: 'u8' },
      State: {
        maps: { type: 'map', of: 'Map', maxSize: 4 },
        writer: 'Writer',
        reader: 'Reader',
        view: 'DataView',
        small: 'Uint8Array',
        error: 'RangeError',
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'netcode-generate-')),
    file = join(dir, 'protocol.ts');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, generateTypeScript(named));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        noEmit: true,
        lib: ['ES2022', 'DOM'],
        types: [],
      },
      include: ['protocol.ts'],
    }),
  );
  const run = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const module = await import(pathToFileURL(file).href),
    value = {
      maps: new Map([[3, { width: 9, tiles: new Uint8Array([1, 2]) }]]),
      writer: { name: 'w' },
      reader: { page: 7 },
      view: { at: 0.5 },
      small: { n: 4 },
      error: { code: 2 },
    };
  assert.ok(equalBytes(module.encodeState(value), named.encode('State', value)));
  assert.deepEqual(
    module.decodeState(named.encode('State', value)),
    named.decode('State', named.encode('State', value)),
  );
});

test('generateTypeScript refuses two structs whose generated function names collide', async () => {
  const { defineSchema } = await import('../dist/index.js');
  const clash = defineSchema({ types: { Player: { x: 'f32' }, PlayerDelta: { y: 'f32' } } });
  // encodePlayerDelta would be both the delta encoder of Player and the encoder of PlayerDelta.
  assert.throws(
    () => generateTypeScript(clash),
    (error) => error instanceof TypeError && /PlayerDelta/.test(error.message),
  );
});
