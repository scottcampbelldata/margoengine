import assert from 'node:assert/strict';
import test from 'node:test';
import { scalarPayloadMetrics } from '../scripts/measure/scalar-payload-metrics.mjs';

test('scalar payload bar preserves R/alpha contracts and zero tolerance', () => {
  const rgba = Uint8Array.of(100, 17, 19, 200);
  assert.equal(scalarPayloadMetrics(5, [100, 200, 0, 255], rgba).numeratorSse, '0');
  assert.equal(scalarPayloadMetrics(5, [100, 199, 0, 255], rgba).numeratorSse, '1');
  assert.equal(scalarPayloadMetrics(4, [100, 0, 0, 255], rgba).numeratorSse, '0');
  assert.equal(scalarPayloadMetrics(1, [0, 0, 0, 199], rgba).numeratorSse, '1');
});

test('EAC scalar SSE retains fractional reconstruction and exact large totals', () => {
  const size = 131072;
  const rgba = new Uint8Array(size * 4);
  const actual = new Float64Array(size * 4);
  for (let p = 0; p < actual.length; p += 4) actual[p] = (2046 * 255) / 2047;
  const metric = scalarPayloadMetrics(20, actual, rgba);
  assert.equal(metric.numeratorSse, String(BigInt(2046 * 255) ** 2n * BigInt(size)));
  assert.equal(metric.denominator, 2047 ** 2);
  assert.throws(() => scalarPayloadMetrics(3, actual, rgba));
});
