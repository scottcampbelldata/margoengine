import assert from 'node:assert/strict';
import test from 'node:test';
import { SedimentTransport, sedimentSettlingSpeed } from '../dist/sediment.js';

test('the optional sediment entry validates material and field inputs before building a grid', async () => {
  assert.throws(() => sedimentSettlingSpeed(0), /suspendedDiameter.*finite/);
  await assert.rejects(
    () =>
      SedimentTransport.load({
        rootCohesion: { name: 'invalid-root', kind: 'uniformGrid', quantity: 'pressure', unit: 'm', centring: 'cell' },
      }),
    /root-cohesion unit.*Pa/,
  );
  const signal = AbortSignal.abort(new Error('stop sediment load'));
  await assert.rejects(() => SedimentTransport.load({ signal }), /stop sediment load/);
});
