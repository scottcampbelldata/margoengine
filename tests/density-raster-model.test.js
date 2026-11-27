import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  checkProbes,
  compareBytes,
  containingPixel,
  discPointPixel,
  exactOverByte,
  snapSubpixel,
  squarePointPixel,
  unorm8OverByte,
} from '../scripts/support/density-raster-model.mjs';

test('positions snap to 1/256 pixel, ties to the even step', () => {
  assert.equal(snapSubpixel(10 + 1 / 512), 10);
  assert.equal(snapSubpixel(10 + 3 / 512), 10 + 2 / 256);
  assert.equal(snapSubpixel(10 + 5 / 2048), 10 + 1 / 256);
  assert.equal(snapSubpixel(11 - 1 / 512), 11);
});

test('a square point takes the left pixel on a vertical boundary and the lower one on a horizontal boundary', () => {
  assert.deepEqual(containingPixel(10, 20), [10, 20]);
  assert.deepEqual(squarePointPixel(10, 20), [9, 20]);
  assert.deepEqual(squarePointPixel(10 + 1 / 512, 20), [9, 20]);
  assert.deepEqual(squarePointPixel(10 + 1 / 256, 20), [10, 20]);
  assert.deepEqual(squarePointPixel(10.5, 21 - 1 / 512), [10, 21]);
  assert.deepEqual(squarePointPixel(10.5, 21 - 1 / 256), [10, 20]);
});

test('a one pixel disc is lit only when its pixel centre is within half a pixel', () => {
  assert.deepEqual(discPointPixel(10.5, 20.5), [10, 20]);
  assert.deepEqual(discPointPixel(10, 20.5), [9, 20]);
  assert.deepEqual(discPointPixel(10.5, 20), [10, 20]);
  assert.equal(discPointPixel(10.25, 20.0625), null);
  // The share of a pixel the disc covers is pi / 4, so about 21.5% of evenly spread points light nothing.
  let lit = 0;
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) if (discPointPixel((x + 0.5) / 256, (y + 0.5) / 256)) lit++;
  assert.ok(Math.abs(lit / 65536 - Math.PI / 4) < 0.005, String(lit / 65536));
});

test('unrounded compositing reaches white; an 8-bit target stops six bytes short', () => {
  assert.deepEqual(
    [1, 2, 40, 75].map((n) => exactOverByte(n, 0.08)),
    [20, 39, 246, 255],
  );
  assert.deepEqual(
    [1, 2, 40, 43, 44, 4096].map((n) => unorm8OverByte(n, 20 / 255)),
    [20, 38, 245, 248, 249, 249],
  );
  assert.equal(unorm8OverByte(0, 0.08), 0);
});

test('image comparison counts differing pixels and pixels more than two bytes apart', () => {
  assert.deepEqual(compareBytes(Uint8Array.of(0, 10, 20, 30), Uint8Array.of(0, 12, 23, 255)), {
    mean: (2 + 3 + 225) / 4,
    max: 225,
    above2: 2,
    differing: 3,
  });
  assert.throws(() => compareBytes(Uint8Array.of(1), Uint8Array.of(1, 2)), RangeError);
});

test('the recorded rival probes and rebuilt images follow the rules', async () => {
  const report = JSON.parse(
    await readFile(new URL('../docs/whitepaper/results/density-attribution-2026-11-27.json', import.meta.url), 'utf8'),
  );
  for (const [name, { stacks, probes, real }] of Object.entries(report.rivals)) {
    assert.deepEqual(checkProbes(name, stacks, []), { stacks: 100, stackMisses: 0, sweep: 0, sweepMisses: 0 });
    assert.deepEqual(probes, { stacks: 100, stackMisses: 0, sweep: 648, sweepMisses: 0 });
    const left = real.againstRival['full rival model'];
    assert.equal(left.differing, name === 'deck.gl' ? 0 : 7);
    // Every pixel left over sits on an observation within 1/10000 pixel of the 1/256 grid's tie.
    assert.ok(real.residualBoundaryDistances.every((distance) => distance < 1e-4));
    assert.ok(real.margoBoundaryDistances.every((distance) => distance < 1e-4));
  }
});
