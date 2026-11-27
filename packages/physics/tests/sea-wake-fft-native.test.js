import assert from 'node:assert/strict';
import test from 'node:test';
import { RealFft2 } from '@margoengine/math/fft';
import { WakeSolver } from '../dist/sea.js';
import { PhysicsWorld } from '../dist/world.js';
import { bindWakeFft, loadWakeFft } from '../src/sea/wake-fft.ts';

const data = (length, scale, offset = 0) =>
  Float64Array.from({ length }, (_, i) => (((i * 19237 + offset) % 6247) - 3123) * scale);

test('the native wake FFT preserves the half spectrum and reconstructed field byte for byte', async () => {
  const module = await loadWakeFft();
  for (const [nx, nz] of [
    [4, 5],
    [6, 9],
    [10, 12],
    [16, 8],
    [30, 25],
    [40, 15],
  ]) {
    const scalar = new RealFft2(nx, nz);
    const native = bindWakeFft(module, nx, nz);
    const field = data(nx * nz, 2 ** -13);
    field[0] = -0;
    field[3] = 2 ** -900;
    const expectedSpectrum = scalar.forward(field);
    const spectrum = native.forward(field);
    assert.deepEqual(spectrum, expectedSpectrum, `forward ${nx}×${nz}`);
    assert.deepEqual(native.inverse(spectrum), scalar.inverse(expectedSpectrum), `round trip ${nx}×${nz}`);

    // Pressure and depth transfer may feed half spectra that came from external transforms and were then edited.
    const otherSpectrum = data((nx + 2) * nz, 2 ** -54, 152);
    const nextField = new Float64Array(nx * nz);
    assert.equal(native.inverse(otherSpectrum, nextField), nextField);
    assert.deepEqual(nextField, scalar.inverse(otherSpectrum), `arbitrary inverse ${nx}×${nz}`);
    native.forward(field, spectrum.fill(23));
    assert.deepEqual(spectrum, expectedSpectrum, `reuse ${nx}×${nz}`);
  }
});

test('the optional SIMD plans isolate their memory and accept world fields backed by shared buffers', async () => {
  const module = await loadWakeFft();
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const a = bindWakeFft(module, 10, 12);
  const b = bindWakeFft(module, 6, 9);
  const field = new Float64Array(new SharedArrayBuffer(8 * 10 * 12));
  const spectrum = new Float64Array(new SharedArrayBuffer(8 * 12 * 12));
  field.set(data(field.length, 2 ** -15, 152));
  const scalar = new RealFft2(10, 12);
  const expected = scalar.forward(field);
  a.forward(field, spectrum);
  assert.deepEqual(Array.from(spectrum), Array.from(expected));
  b.forward(data(54, 2 ** -11));
  a.inverse(spectrum, field);
  assert.deepEqual(Array.from(field), Array.from(scalar.inverse(expected)));

  for (const dimensions of [
    [9, 8],
    [14, 8],
    [4, 3],
    [2 ** 32 + 4, 6],
  ])
    assert.throws(() => bindWakeFft(module, ...dimensions), { code: 'state' });
  spectrum.fill(123);
  assert.throws(() => a.forward(field.subarray(1), spectrum), { code: 'state' });
  assert.ok(spectrum.every((value) => value === 123));
  const controller = new AbortController();
  controller.abort(new Error('Stop loading'));
  await assert.rejects(loadWakeFft(controller.signal), { message: 'Stop loading' });
});

test('the public SIMD wake executes the same coupled fields and exact replay as the TypeScript wake', async () => {
  const native = await WakeSolver.load();
  const scalar = new WakeSolver();
  const cells = [30, 25],
    cellSize = 0.2;
  const params = {
    cells,
    cellSize,
    depth: 0.9,
    sponge: 0,
    waterBelow: true,
    current: [0.25, -0.09],
    surfaceTension: 0.073,
    kinematicViscosity: 1.05e-6,
    sources: (time) => [{ x: 0.8 * time, z: 0.2, radius: 0.4, pressure: 1200, volume: 0.0005 }],
  };
  const make = (wake) => new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wake, params);
  const a = make(native),
    b = make(scalar);
  a.advance(11);
  const snapshot = a.takeSnapshot();
  a.advance(31);
  b.advance(31);
  assert.equal(a.hash(), b.hash());
  assert.deepEqual(native.heights(), scalar.heights());
  assert.deepEqual(native.sample(0.3, -0.1), scalar.sample(0.3, -0.1));
  assert.deepEqual(native.velocityAt(0.3, -0.4, -0.1), scalar.velocityAt(0.3, -0.4, -0.1));
  a.restoreSnapshot(snapshot.bytes);
  a.advance(31);
  assert.equal(a.hash(), b.hash());

  // The four doubling depths (0.1, 0.2, 0.4, 0.8 m) plus the surface and bed.
  const forward = 4,
    inverse = 2 + 3 * 6;
  assert.deepEqual(native.fftWork(), {
    backend: 'wasm-simd',
    forward,
    inverse,
    transferBytes: (forward + inverse) * 8 * (2 * cells[0] + 2) * cells[1],
  });
  assert.deepEqual(scalar.fftWork(), { backend: 'typescript', forward, inverse, transferBytes: 0 });
});
