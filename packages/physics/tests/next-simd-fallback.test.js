// The kernel without Wasm SIMD: a build of its own, loaded when the engine cannot compile SIMD, that steps a world to the same bits as
// the SIMD build. Proved by the replay scenes against the committed hashes in both builds, the module holding no 128-bit instruction,
// and a child process whose engine reports no SIMD loading the scalar build by itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import binaryen from 'binaryen';
import { KernelWorld, Physics, loadKernel } from '../dist/index.js';
import { REPLAY_ADAPTIVE_STEPS, REPLAY_STEPS, kernelScene, physicsScene } from './replay-scene.js';

const golden = JSON.parse(readFileSync(new URL('fixtures/replay-hash.json', import.meta.url), 'utf8'));

const bytesOf = (file) => {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  return inflateRawSync(Buffer.from(/wasmBase64: string = '([^']*)'/.exec(text)[1], 'base64'));
};

test('the scalar build holds no 128-bit instruction and the SIMD build holds many', () => {
  const instructions = (file) => binaryen.readBinary(bytesOf(file)).emitText();
  const simd = /\bv128\b|\b[fi](8|16|32|64)x\d+\./g;
  assert.equal((instructions('../src/wasm-scalar.ts').match(simd) ?? []).length, 0);
  assert.ok((instructions('../src/wasm.ts').match(simd) ?? []).length > 1000);
});

test('both builds carry the same build id and the same column table', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const [a, b] = [read('../src/wasm.ts'), read('../src/wasm-scalar.ts')];
  assert.equal(
    /kernelSource: string = '([0-9a-f]{64})'/.exec(a)[1],
    /kernelSource: string = '([0-9a-f]{64})'/.exec(b)[1],
  );
  assert.equal(/kernelColumns: [^=]+ = (\[.*\]);/.exec(a)[1], /kernelColumns: [^=]+ = (\[.*\]);/.exec(b)[1]);
});

for (const simd of [false, true]) {
  test(`the replay scenes give the committed hashes in the ${simd ? 'SIMD' : 'scalar'} build`, async () => {
    await loadKernel({ simd });
    assert.equal(Physics.kernelVariant, simd ? 'simd' : 'scalar');
    const [arena, blockArena, physicsArena] = [[], [], []];
    assert.deepEqual(kernelScene(KernelWorld, undefined, undefined, undefined, arena), golden.kernel);
    assert.deepEqual(
      kernelScene(KernelWorld, undefined, undefined, { blockSolver: true }, blockArena),
      golden.kernelBlock,
      'the block solver on',
    );
    assert.deepEqual(physicsScene(Physics, undefined, physicsArena), golden.physics);
    const adaptiveArena = [];
    assert.deepEqual(
      physicsScene(Physics, REPLAY_ADAPTIVE_STEPS, adaptiveArena, true),
      golden.physicsAdaptive,
      'levels on',
    );
    assert.deepEqual(adaptiveArena, golden.physicsAdaptiveArena);
    assert.deepEqual(
      [arena, blockArena, physicsArena],
      [golden.kernelArena, golden.kernelBlockArena, golden.physicsArena],
    );
    assert.equal(golden.steps, REPLAY_STEPS);
  });
}

test('an engine without Wasm SIMD loads the scalar build by itself', () => {
  const script = `
    const validate = WebAssembly.validate.bind(WebAssembly);
    // This engine says no to the SIMD probe, as an older browser does.
    WebAssembly.validate = (bytes) => (bytes.length === 31 && bytes.includes(253) ? false : validate(bytes));
    const { Physics } = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    await Physics.load();
    const physics = new Physics(null);
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [5, 0.5, 5] } });
    const ball = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.5 } });
    for (let i = 0; i < 120; i++) physics.step();
    console.log(Physics.kernelVariant, ball.position[1].toFixed(3));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  assert.match(out, /^scalar 1\.0\d\d$/, out);
});
