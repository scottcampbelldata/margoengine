// The 2D kernel without Wasm SIMD: a build of its own (dist/physics2d-scalar.wasm), loaded when the engine cannot compile SIMD,
// that steps a world to the same bits as the SIMD build. Each variant runs in a process of its own, as a page loads one kernel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import binaryen from 'binaryen';

const index = new URL('../dist/index.js', import.meta.url).href;

/** A stack of boxes, a ball, a joint and a pile that sleeps, stepped 600 times; the SHA-256 of the whole world's snapshot. */
const scene = (load) => `
  import { createHash } from 'node:crypto';
  const { Physics2D } = await import(${JSON.stringify(index)});
  await ${load};
  const physics = new Physics2D(null, { gravity: [0, 20], pixelsPerMeter: 1, interpolate: false });
  physics.addBody(null, { type: 'fixed', position: [0, 10], colliders: { shape: 'box', width: 40, height: 1 } });
  const boxes = [];
  for (let i = 0; i < 12; i++)
    boxes.push(physics.addBody(null, { position: [0.1 * (i % 3), 9 - i * 1.05], rotation: 0.02 * i, colliders: { shape: 'box', width: 1, height: 1, friction: 0.6 } }));
  for (let i = 0; i < 6; i++) physics.addBody(null, { position: [5 + 0.4 * i, 2 - i], colliders: { shape: 'circle', radius: 0.4, restitution: 0.3 } });
  for (let i = 0; i < 600; i++) physics.step();
  const bytes = physics.snapshot();
  console.log(createHash('sha256').update(bytes).digest('hex'), bytes.length);
`;
const run = (load) => execFileSync(process.execPath, ['--input-type=module', '-e', scene(load)], { encoding: 'utf8' }).trim();

test('the scalar build steps a world to the same bits as the SIMD build', () => {
  const simd = run('Physics2D.load({ simd: true })'),
    scalar = run('Physics2D.load({ simd: false })');
  assert.match(simd, /^[0-9a-f]{64} \d+$/);
  assert.equal(scalar, simd);
});

test('an engine that reports no SIMD loads the scalar build by itself', () => {
  const deny = `
    const validate = WebAssembly.validate.bind(WebAssembly);
    WebAssembly.validate = (bytes) => (bytes.length === 31 && bytes.includes(253) ? false : validate(bytes));
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    globalThis.loaded = [];
    WebAssembly.instantiate = (source, ...rest) => (globalThis.loaded.push(source.byteLength ?? 0), instantiate(source, ...rest));
  `;
  const script = deny + scene('Physics2D.load()') + "\nconsole.log('sizes', globalThis.loaded.join());";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim().split('\n');
  const simd = readFileSync(new URL('../src/physics2d-kernel.wasm', import.meta.url)).length,
    scalar = readFileSync(new URL('../src/physics2d-kernel-scalar.wasm', import.meta.url)).length;
  assert.equal(out[1], `sizes ${scalar}`, `loaded the scalar module (${scalar} bytes, not the SIMD one of ${simd})`);
  assert.equal(out[0].split(' ')[0], run('Physics2D.load({ simd: true })').split(' ')[0], 'and gives the same world');
});

test('the scalar module holds no 128-bit instruction and the SIMD one holds many', () => {
  const text = (file) => binaryen.readBinary(readFileSync(new URL(file, import.meta.url))).emitText();
  const simd = /\bv128\b|\b[fi](8|16|32|64)x\d+\./g;
  assert.equal((text('../src/physics2d-kernel-scalar.wasm').match(simd) ?? []).length, 0);
  assert.ok((text('../src/physics2d-kernel.wasm').match(simd) ?? []).length > 100);
});
