// The Draco output ceiling (DRACO_OUTPUT_LIMIT, 384 MiB) is sized from measured decode memory, and a stream whose
// declared counts its bytes do not back fails with a coded error. Fixture: `node scripts/draco-scale.mjs 708
// --positions --out=tests/fixtures/grid-1m-positions.drc` (999,698 triangles, positions only: the most memory per
// output byte of the measured meshes; 10M triangles with normals and UVs needs less, see docs/limits.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { decodeDraco } from '../dist/codec.js';
import { decodeNativeDraco } from '../dist/draco-native-codec.js';
import { DRACO_OUTPUT_LIMIT, validatedDracoLimits } from '../dist/protocol.js';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const grid = readFileSync(here('./fixtures/grid-1m-positions.drc'));
const page = 65536,
  step = 64 * 1024 * 1024;

/** Maximum linear memory a module declares, or the wasm32 limit when it declares none. */
function maximumMemory(wasm) {
  for (let p = 8; p < wasm.length; ) {
    const leb = () => {
      let value = 0;
      for (let shift = 0; ; shift += 7) {
        const byte = wasm[p++];
        value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
      }
    };
    const id = wasm[p++],
      size = leb(),
      end = p + size;
    if (id === 5) {
      p++; // one memory
      const flags = wasm[p++];
      leb();
      return (flags & 1 ? leb() : 65536) * page;
    }
    p = end;
  }
  throw new Error('no memory section');
}

async function prebuilt() {
  globalThis.require ??= createRequire(import.meta.url);
  globalThis.__dirname ??= here('../dist/draco/');
  runInThisContext(readFileSync(here('../dist/draco/draco_wasm_wrapper.js'), 'utf8'));
  const wasm = readFileSync(here('../dist/draco/draco_decoder.wasm'));
  const draco = await globalThis.DracoDecoderModule({ wasmBinary: wasm });
  return { draco, maximum: maximumMemory(wasm), memory: () => draco.HEAPU8.buffer.byteLength };
}

async function native() {
  const wasm = readFileSync(here('../dist/draco-native.wasm'));
  const m = (await WebAssembly.instantiate(wasm)).instance.exports;
  return { m, maximum: maximumMemory(wasm), memory: () => m.memory.buffer.byteLength };
}

const outputBytes = (g) => g.positions.byteLength + g.indices.byteLength;

test('DRACO_OUTPUT_LIMIT is the largest 64 MiB step whose measured peak memory fits 90% of each decoder', async () => {
  const p = await prebuilt(),
    n = await native();
  const runs = [
    { ...p, g: decodeDraco(p.draco, grid) },
    { ...n, g: decodeNativeDraco(n.m, grid) },
  ];
  let fit = Infinity;
  for (const run of runs) {
    assert.equal(run.g.indices.length, 999_698 * 3);
    fit = Math.min(fit, (0.9 * run.maximum) / (run.memory() / outputBytes(run.g)));
  }
  assert.equal(p.maximum, 2 ** 31, 'the prebuilt module grows to 2 GiB');
  assert.equal(DRACO_OUTPUT_LIMIT, Math.floor(fit / step) * step);
  assert.equal(DRACO_OUTPUT_LIMIT, 402_653_184);
  assert.equal(validatedDracoLimits({ maxDecodedBytes: 2 ** 40 }).maxDecodedBytes, DRACO_OUTPUT_LIMIT);
  assert.equal(validatedDracoLimits().maxDecodedBytes, DRACO_OUTPUT_LIMIT);
});

test('a Draco stream whose declared counts are not backed by its bytes fails with a coded error', async () => {
  const p = await prebuilt(),
    n = await native();
  decodeNativeDraco(n.m, grid);
  const full = n.memory();
  for (const keep of [64, 4096, grid.length >> 2, grid.length - 1]) {
    const cut = grid.subarray(0, keep);
    for (const decode of [() => decodeDraco(p.draco, cut), () => decodeNativeDraco(n.m, cut)])
      assert.throws(decode, (error) => error.code === 'failed', `${keep} bytes`);
  }
  assert.equal(n.memory(), full, 'a cut stream claims no more memory than the whole one');
});
